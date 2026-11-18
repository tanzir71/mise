import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMaps,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {Order,OrderRefund,Customer,CreditAccount} from '../packages/core/models';
import {newInboxId} from '../packages/core/inbox';
import {orderWritePlan,type OrderCommand,type OrderFinanceIds} from '../packages/core/order-commands';
import {orderFingerprint,orderWriteFields} from '../supabase/functions/_shared/order-write';
/** Actual SQL roles, fictional identities; every write rolls back in one subtransaction. */
export async function orderHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now(),clockBase=Date.now()+100000,literal='অর্ডার\0'+String.fromCharCode(0xd800),orderId=newInboxId();
 const baseRecords:CloudRecord[]=[...f.baseRecords,...f.records.filter(r=>['customers','credit_accounts'].includes(r.table))];
 baseRecords.push({table:'customer_outlets',values:{business_id:f.businessId,outlet_id:f.outletId,customer_id:f.records.find(r=>r.table==='customers')!.values.id}});
 const records:CloudRecord[]=[...baseRecords];
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const rows=(table:BackupTable)=>records.filter(r=>r.table===cloudRecordMaps[table].table).map(r=>raw(table,r));
 const readOrder=()=>decodeCommandRecord('orders',rows('orders')[0]) as unknown as Order,customer=decodeCommandRecord('customers',rows('customers')[0]) as unknown as Customer,account=decodeCommandRecord('creditAccounts',rows('creditAccounts')[0]) as unknown as CreditAccount;
 const ids=():OrderFinanceIds=>({saleId:newInboxId(),saleEventId:newInboxId(),entryId:newInboxId(),creditEventId:newInboxId(),refundId:newInboxId(),refundEventId:newInboxId()}),base=()=>({id:newInboxId(),outletId:f.outletId,occurredAt:occurred});
 const steps:{id:string;type:string;ticket:string;plan:ReturnType<typeof orderWritePlan>;hash:string;clock:string;records:string}[]=[];
 async function step(c:OrderCommand){
  const ticket=newInboxId(),clock=clockBase+steps.length,current=c.type==='order.warning-settings'?null:rows('orders')[0]??null,saleId='sourceSaleId'in c?c.sourceSaleId:c.type==='order.refund-undo'?(decodeCommandRecord('orderRefunds',rows('orderRefunds').find(r=>r.id===c.refundId)!) as unknown as OrderRefund).saleId:undefined;
  const selectedSale=rows('sales').find(r=>r.id===saleId)??null,selectedAccount=(c.type==='order.payment'&&c.input.method==='credit'||c.type==='order.create'||c.type==='order.update'&&c.settlement||selectedSale?.credit_account_id)?rows('creditAccounts')[0]:null;
  const contextJson=JSON.stringify({business:rows('businesses')[0],outlet:rows('outlets')[0],order:current,customer:c.type==='order.warning-settings'?null:rows('customers')[0],account:c.type==='order.warning-settings'?null:selectedAccount,sale:selectedSale,refund:c.type==='order.refund-undo'?rows('orderRefunds').find(r=>r.id===c.refundId):null,statusEvent:c.type==='order.status-undo'?rows('events').find(r=>r.id===readOrder().statusEventId):null,items:[],entries:selectedAccount?rows('creditEntries'):[],sequence:current?(readOrder().sequence):1});
  const fields=orderWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson},c,ticket);
  steps.push({id:c.id,type:c.type,ticket,plan:orderWritePlan(c),hash:await orderFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const i=records.findIndex(x=>x.table===r.table&&x.values.id===r.values.id);if(i<0)records.push(r);else records[i]=r;}
 }
 const firstFinance=ids();
 await step({...base(),type:'order.create',orderId,revision:0,newLineIds:[newInboxId(),newInboxId()],input:{source:'paste',sourceText:literal,customerId:customer.id,name:literal,phone:customer.phone!,type:'pickup',address:'',table:'',lines:[{name:literal,unit:'kg',qty:2.5,unitPrice:12001,note:literal},{name:'Free',unit:'kg',qty:0.001,unitPrice:1}],deliveryFee:0,discount:0,payment:{method:'credit'}},settlement:{id:newInboxId(),input:{method:'credit',accountId:account.id},ids:firstFinance}});
 await step({...base(),type:'order.note',orderId,revision:readOrder().revision,noteId:newInboxId(),text:literal});
 await step({...base(),type:'order.communication',orderId,revision:readOrder().revision,communicationId:newInboxId(),input:{purpose:'quote',channel:'manual',text:literal}});
 await step({...base(),type:'order.status',orderId,revision:readOrder().revision,status:'priced',sourceSaleId:readOrder().payment.saleId!,ids:ids()});
 await step({...base(),type:'order.status-undo',orderId,revision:readOrder().revision,sourceSaleId:readOrder().payment.saleId!,ids:ids()});
 await step({...base(),type:'order.payment-undo',orderId,revision:readOrder().revision,sourceSaleId:readOrder().payment.saleId!,sourcePaymentAt:readOrder().payment.at!,ids:ids()});
 const secondFinance=ids();await step({...base(),type:'order.payment',orderId,revision:readOrder().revision,input:{method:'wallet',wallet:'bKash'},ids:secondFinance});
 await step({...base(),type:'order.status',orderId,revision:readOrder().revision,status:'cancelled',sourceSaleId:readOrder().payment.saleId!,ids:ids()});
 const refundFinance=ids();await step({...base(),type:'order.refund',orderId,revision:readOrder().revision,sourceSaleId:readOrder().payment.saleId!,input:{amount:10000,method:'cash',note:literal},ids:refundFinance});
 await step({...base(),type:'order.refund-undo',orderId,revision:readOrder().revision,refundId:refundFinance.refundId,ids:ids()});
 await step({...base(),type:'order.status-undo',orderId,revision:readOrder().revision,sourceSaleId:readOrder().payment.saleId!,ids:ids()});
 await step({...base(),type:'order.warning-settings',minutes:30});
 const current=readOrder();await step({...base(),type:'order.update',orderId,revision:current.revision,newLineIds:[],settlement:null,input:{source:current.source,sourceText:current.sourceText,customerId:current.customer.id,name:current.customer.name,phone:current.customer.phone!,type:'delivery',address:'Road 12',table:'',lines:current.lines.map(l=>({id:l.id,itemId:l.itemId,name:l.name,unit:l.unit,qty:l.qty,unitPrice:l.unitPrice,note:l.note,unavailable:l.unavailable,substitution:l.substitution?{from:l.substitution.from,accepted:l.substitution.accepted}:undefined})),deliveryFee:0,discount:0,payment:{method:'wallet',wallet:'bKash'}}});
 const expectedLines=records.find(r=>r.table==='orders')!.values.lines;
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v),allowed=new Set(['businesses','outlets','members','member_outlets','customers','customer_outlets','credit_accounts']);
 const inserts=baseRecords.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid fixture record');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 const sql=`do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;first_receipt jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;
 caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;admission_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   if public.admit_order_write(${quote(f.outletId)}) is not true then raise exception 'Owner order admission failed';end if;
   p:=public.prepare_order_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_order_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.order_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_order_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   begin perform public.admit_order_write(${quote(f.outletId)});exception when insufficient_privilege then admission_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_order_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred} or (s->>'type'<>'order.warning-settings' and r->>'orderId'<>${quote(orderId)}) then raise exception 'Order clocks or device IDs changed';end if;
   if completed=0 then first_receipt:=r;end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_order_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Receipt replay mismatch';end if;completed:=completed+1;
  end loop;
  s:=(${quote(JSON.stringify(steps))}::jsonb)->0;
  again:=public.prepare_order_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
  if again->'receipt'<>first_receipt then raise exception 'Later mutations replaced the accepted receipt';end if;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'deviceIdsAndClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,'otherLargeBodyAdmissionDenied',admission_denied,
   'orderHistoryRetained',(select revision=13 and status='requested' and type='delivery' and address::text='"Road 12"' and total=30003 from public.orders where id=${quote(orderId)}),
   'literalUnicodeRetained',(select source_text::text=${quote(JSON.stringify(literal))} and customer_name::text=${quote(JSON.stringify(literal))} and lines::text=${quote(expectedLines)} from public.orders where id=${quote(orderId)}),
   'creditReversed',(select count(*)=2 and sum(amount)=0 and bool_and(order_id=${quote(orderId)} and sale_id=${quote(firstFinance.saleId)}) from public.credit_entries where business_id=${quote(f.businessId)}),
   'walletRestored',(select voided_at is null and method='wallet' and method_name::text='"bKash"' from public.sales where id=${quote(secondFinance.saleId)}),
   'refundVoided',(select voided_at=${occurred} and amount=10000 from public.order_refunds where id=${quote(refundFinance.refundId)}),
   'notes',(select count(*) from public.order_notes where business_id=${quote(f.businessId)}),'communications',(select count(*) from public.order_communications where business_id=${quote(f.businessId)}),
   'audits',(select count(*) from public.events where business_id=${quote(f.businessId)}),'pendingTickets',(select count(*) from private.order_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>13 or (proof->>'receipts')::int<>13 or (proof->>'pendingTickets')::int<>0 or (proof->>'audits')::int<>23 or (proof->>'notes')::int<>1 or (proof->>'communications')::int<>1
   or not caller_denied or not raw_denied or not other_denied or not admission_denied or (proof->>'orderHistoryRetained')::boolean is not true or (proof->>'literalUnicodeRetained')::boolean is not true
   or (proof->>'creditReversed')::boolean is not true or (proof->>'walletRestored')::boolean is not true or (proof->>'refundVoided')::boolean is not true then raise exception 'Order verification failed';end if;
  raise exception using errcode='MZ006',message='Roll back order verification fixture';
 exception when sqlstate 'MZ006' then null;end;
 perform set_config('mise.order_verification',proof::text,true);
end $verify$;
select current_setting('mise.order_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.order_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('Retain fixture Unicode as escaped JSON');return sql;
}
