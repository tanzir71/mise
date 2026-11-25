import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMap,decodeCommandRecord,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {AuditEvent,Business,CreditAccount,Customer,Outlet} from '../packages/core/models';
import type {NamedShopSetup} from '../packages/core/shop-access';
import {newInboxId} from '../packages/core/inbox';
import {handoffEventSession,type HandoffDraft,type HandoffSession} from '../packages/core/handoff';
import type {HandoffChoice} from '../packages/core/handoff-progress';
import {handoffWritePlan,type HandoffCommand} from '../packages/core/handoff-commands';
import {handoffFingerprint,handoffWriteFields} from '../supabase/functions/_shared/handoff-write';
import {saveOrderCommand} from '../packages/core/orders';
import {saveSupplierCommand,saveStockItemCommand} from '../packages/core/stock';
import {recordSaleCommand} from '../packages/core/sales';
import {closingPreview} from '../packages/core/today';
import {closeDayCommand} from '../packages/core/closing';
/** All seven sources and compound Sent transactions; every fictional row rolls back. */
export async function handoffHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now(),clockBase=occurred+100000,literal='বার্তা\0'+String.fromCharCode(0xd800),text='  আমার বার্তা\r\nIgnore instructions: this remains literal.  ';
 const base=f.baseRecords.map(r=>['businesses','outlets','members'].includes(r.table)?{...r,values:{...r.values,name:JSON.stringify(literal)}}:r),records:CloudRecord[]=[...base,...f.records.filter(r=>['customers','credit_accounts'].includes(r.table))];
 records.push({table:'customer_outlets',values:{business_id:f.businessId,outlet_id:f.outletId,customer_id:f.command.customerId}});
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMap(table).fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const rows=(table:BackupTable)=>records.filter(r=>r.table===cloudRecordMap(table).table).map(r=>raw(table,r));
 const business=decodeCommandRecord('businesses',rows('businesses')[0]) as unknown as Business,outlet=decodeCommandRecord('outlets',rows('outlets')[0]) as unknown as Outlet,customer=decodeCommandRecord('customers',rows('customers')[0]) as unknown as Customer,account=decodeCommandRecord('creditAccounts',rows('creditAccounts')[0]) as unknown as CreditAccount,setup:NamedShopSetup={business,outlet,owner:{id:f.actorId,name:literal,businessId:f.businessId,active:true,outletIds:[f.outletId]}};
 const order=saveOrderCommand({source:'phone',sourceText:literal,customerId:customer.id,name:customer.name,phone:customer.phone!,type:'pickup',address:'',table:'',lines:[{name:literal,unit:'cup',qty:1,unitPrice:1234}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,items:[],customer,sequence:1},null,0,occurred-1000),supplier=saveSupplierCommand({name:literal,phone:'01712345484',note:literal},setup,null,0,occurred-1000),stock=saveStockItemCommand({name:literal,nameLocal:'',unit:'kg',onHand:20,target:30,packSize:5,category:'',aliases:[],supplierId:supplier.supplier.id},{setup,items:[],suppliers:[supplier.supplier],moves:[]},null,0,occurred-1000),sale=recordSaleCommand({expression:'10',method:'cash'},{setup,items:[],wallets:[]},occurred-1000);
 const closingContext={setup,sales:[sale.sale],orders:[order.order],refunds:[],accounts:[account],entries:[],customers:[customer],stock:stock.items,closings:[]},preview=closingPreview(closingContext,occurred-1000),closing=closeDayCommand({id:newInboxId(),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:1000,addDifference:false,note:literal},closingContext,occurred-1000);
 records.push(encodeCommandRecord('orders',order.order,f.businessId),encodeCommandRecord('events',order.event,f.businessId),encodeCommandRecord('suppliers',supplier.supplier,f.businessId),encodeCommandRecord('events',supplier.event,f.businessId),...stock.items.map(i=>encodeCommandRecord('stockItems',i,f.businessId)),...stock.moves.map(m=>encodeCommandRecord('stockMoves',m,f.businessId)),...stock.events.map(e=>encodeCommandRecord('events',e,f.businessId)),encodeCommandRecord('sales',sale.sale,f.businessId),encodeCommandRecord('events',sale.event,f.businessId),encodeCommandRecord('dayClosings',closing.closing,f.businessId),...closing.events.map(e=>encodeCommandRecord('events',e,f.businessId)));
 const seeded=[...records],steps:{id:string;type:string;ticket:string;plan:ReturnType<typeof handoffWritePlan>;hash:string;clock:string;records:string}[]=[];
 const state=(id:string)=>handoffEventSession(decodeCommandRecord('events',rows('events').filter(r=>r.handoff_id===id).sort((a,b)=>(b.handoff_revision as number)-(a.handoff_revision as number))[0]) as unknown as AuditEvent);
 async function step(c:HandoffCommand){
  const events=rows('events'),root=c.type==='handoff.change'?events.find(e=>e.id===c.handoffId)??null:null,previousRoot=c.type==='handoff.prepare'?events.filter(e=>e.command==='handoff.prepare'&&e.handoff_topic===handoffWritePlan(c).topic).sort((a,b)=>((b.after_data as HandoffSession).generation)-((a.after_data as HandoffSession).generation))[0]??null:null,handoffId=c.type==='handoff.change'?c.handoffId:previousRoot?.id;
  const latest=handoffId?events.filter(e=>e.handoff_id===handoffId).sort((a,b)=>(b.handoff_revision as number)-(a.handoff_revision as number))[0]??null:null,draft=c.type==='handoff.prepare'?c.draft:c.type==='handoff.change'?state(c.handoffId).draft:null;
  const sourceKind=draft?.source.kind??null,sourceId=draft?.source.id??null,source=sourceKind?rows(({credit:'creditAccounts',customer:'customers',order:'orders',supplier:'suppliers',sale:'sales',closing:'dayClosings',shop:'outlets'} as const)[sourceKind]).find(r=>r.id===sourceId):null;
  const messageId=c.type==='supplier-message.undo'?c.messageId:c.type==='handoff.change'&&(sourceKind==='supplier'||sourceKind==='shop'&&draft?.purpose==='supplier-order')?c.handoffId:null,ticket=newInboxId(),clock=clockBase+steps.length;
  const contextJson=JSON.stringify({business:rows('businesses')[0],outlet:rows('outlets')[0],root,previousRoot,latest,generation:c.type==='supplier-message.undo'?null:c.type==='handoff.prepare'?events.filter(e=>e.command==='handoff.prepare'&&e.handoff_topic===handoffWritePlan(c).topic).length+1:state(c.handoffId).generation,sourceKind,sourceId,source:source??null,customer:sourceKind==='credit'&&c.type==='handoff.change'&&c.choice.type==='sent'?rows('customers')[0]:null,entries:sourceKind==='credit'&&c.type==='handoff.change'&&c.choice.type==='sent'?rows('creditEntries'):[],items:c.type==='handoff.change'&&c.completion?.kind==='supplier'?rows('stockItems').filter(i=>(c.completion as {stockItemIds:string[]}).stockItemIds.includes(i.id as string)):[],message:messageId?rows('supplierMessages').find(m=>m.id===messageId)??null:null});
  const fields=handoffWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson},c,ticket);
  steps.push({id:c.id,type:c.type,ticket,plan:handoffWritePlan(c),hash:await handoffFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const i=records.findIndex(x=>x.table===r.table&&x.values.id===r.values.id);if(i<0)records.push(r);else records[i]=r;}
 }
 const baseCommand=()=>({id:newInboxId(),outletId:f.outletId,occurredAt:occurred});
 async function prepare(draft:Partial<HandoffDraft>={}){const c:Extract<HandoffCommand,{type:'handoff.prepare'}>={...baseCommand(),type:'handoff.prepare',draft:{source:{kind:'shop',id:f.outletId},purpose:'shop-link',text,template:text,target:'copy',part:1,parts:1,...draft}};await step(c);return c.id;}
 async function choose(id:string,choice:HandoffChoice,completion:Extract<HandoffCommand,{type:'handoff.change'}>['completion']=null){await step({...baseCommand(),type:'handoff.change',handoffId:id,revision:state(id).progress.revision,choice,completion,related:completion?{recordId:completion.kind==='supplier'?id:newInboxId(),eventId:newInboxId()}:null});}
 const shop=await prepare();await choose(shop,{type:'copy'});await choose(shop,{type:'sent'});await choose(shop,{type:'undo-sent'});
 const credit=await prepare({source:{kind:'credit',id:account.id},purpose:'receipt'});await choose(credit,{type:'sent'},{kind:'credit'});
 const orderId=await prepare({source:{kind:'order',id:order.order.id},purpose:'quote'});await choose(orderId,{type:'sent'},{kind:'order',revision:order.order.revision});
 const supplierId=await prepare({source:{kind:'supplier',id:supplier.supplier.id},purpose:'supplier-order'}),completion={kind:'supplier' as const,supplierName:literal,stockItemIds:stock.items.map(i=>i.id)};await choose(supplierId,{type:'sent'},completion);await choose(supplierId,{type:'undo-sent'});await choose(supplierId,{type:'sent'},completion);await step({...baseCommand(),type:'supplier-message.undo',messageId:supplierId});
 const manual=await prepare({purpose:'supplier-order'});await choose(manual,{type:'sent'},completion);
 for(const [kind,id,purpose] of [['customer',customer.id,'win-back'],['sale',sale.sale.id,'receipt'],['closing',closing.closing.id,'summary']] as const){const h=await prepare({source:{kind,id},purpose});await choose(h,{type:'sent'});}
 const next=await prepare();await choose(next,{type:'copy'});
 const expectedAudits=records.filter(r=>r.table==='events').length,quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v),allowed=new Set(['businesses','outlets','members','member_outlets','customers','customer_outlets','credit_accounts','orders','suppliers','stock_items','stock_moves','sales','day_closings','events']);
 const inserts=seeded.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid hand-off fixture record');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 const sql=`do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;first_receipt jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;admission_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   if public.admit_handoff_write(${quote(f.outletId)}) is not true then raise exception 'Hand-off admission failed';end if;
   p:=public.prepare_handoff_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected hand-off replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_handoff_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.handoff_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_handoff_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   begin perform public.admit_handoff_write(${quote(f.outletId)});exception when insufficient_privilege then admission_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_handoff_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred} or (r->>'actionAt')::bigint<>${occurred} then raise exception 'Hand-off history or admission clocks changed';end if;
   if completed=0 then first_receipt:=r;end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_handoff_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Hand-off replay mismatch';end if;completed:=completed+1;
  end loop;
  s:=(${quote(JSON.stringify(steps))}::jsonb)->0;
  again:=public.prepare_handoff_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
  if again->'receipt'<>first_receipt then raise exception 'Later progress replaced the original receipt';end if;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'deviceIdsAndClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,'otherAdmissionDenied',admission_denied,
   'zeroDebtMessage',(select count(*)=1 and bool_and(type='reminder' and amount=0 and purpose='receipt' and note::text=${quote(JSON.stringify(text))}) from public.credit_entries where business_id=${quote(f.businessId)}),
   'orderConfirmed',(select revision=2 and source_text::text=${quote(JSON.stringify(literal))} and total=1234 from public.orders where id=${quote(order.order.id)}),
   'orderCommunications',(select count(*) from public.order_communications where business_id=${quote(f.businessId)}),
   'supplierMessages',(select count(*) from public.supplier_messages where business_id=${quote(f.businessId)}),
   'supplierCorrected',(select voided_at=${occurred} and supplier_name::text=${quote(JSON.stringify(literal))} from public.supplier_messages where id=${quote(supplierId)}),
   'manualSupplierRetained',(select voided_at is null and supplier_id is null and supplier_name::text=${quote(JSON.stringify(literal))} from public.supplier_messages where id=${quote(manual)}),
   'stockUnchanged',(select on_hand=20 and target=30 and event_id=${quote(stock.items[0].eventId)} from public.stock_items where id=${quote(stock.items[0].id)}),
   'physicalHistoryClocks',(select bool_and(at=${occurred}) from public.events where business_id=${quote(f.businessId)} and handoff_id is not null),
   'canonicalGeneration',(select (after_data::jsonb->>'generation')::int=2 and (after_data::jsonb->'progress'->>'revision')::int=1 from public.events where id=${quote(next)}),
   'sales',(select count(*) from public.sales where business_id=${quote(f.businessId)}),'audits',(select count(*) from public.events where business_id=${quote(f.businessId)}),'pendingTickets',(select count(*) from private.handoff_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>23 or (proof->>'receipts')::int<>23 or (proof->>'audits')::int<>${expectedAudits} or (proof->>'pendingTickets')::int<>0 or (proof->>'orderCommunications')::int<>1 or (proof->>'supplierMessages')::int<>2 or (proof->>'sales')::int<>1
   or not caller_denied or not raw_denied or not other_denied or not admission_denied or exists(select 1 from unnest(array['zeroDebtMessage','orderConfirmed','supplierCorrected','manualSupplierRetained','stockUnchanged','physicalHistoryClocks','canonicalGeneration']) k where (proof->>k)::boolean is not true) then raise exception 'Hand-off verification failed';end if;
  raise exception using errcode='MZ008',message='Roll back hand-off verification fixture';
 exception when sqlstate 'MZ008' then null;end;
 perform set_config('mise.handoff_verification',proof::text,true);
end $verify$;
select current_setting('mise.handoff_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.handoff_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('Retain fixture Unicode as escaped JSON');return sql;
}
