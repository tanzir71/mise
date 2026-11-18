import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMaps,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {Supplier} from '../packages/core/models';
import {newInboxId} from '../packages/core/inbox';
import {purchaseWritePlan,type PurchaseCommand} from '../packages/core/purchase-commands';
import {purchaseFingerprint,purchaseWriteFields} from '../supabase/functions/_shared/purchase-write';
/** Synthetic SQL-role proof; every Auth/domain row rolls back in one subtransaction. */
export async function purchaseHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now()-1000,clockBase=Date.now()+100000,records:CloudRecord[]=[...f.baseRecords],literal='সরবরাহ\0'+String.fromCharCode(0xd800),supplierId=newInboxId(),purchaseId=newInboxId();
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const rows=(table:BackupTable)=>records.filter(r=>r.table===cloudRecordMaps[table].table).map(r=>raw(table,r));
 const supplier=()=>decodeCommandRecord('suppliers',rows('suppliers')[0]) as unknown as Supplier,base=()=>({id:newInboxId(),outletId:f.outletId,occurredAt:occurred});
 const steps:{id:string;type:string;ticket:string;plan:ReturnType<typeof purchaseWritePlan>;hash:string;clock:string;records:string}[]=[];
 async function step(c:PurchaseCommand){
  const ticket=newInboxId(),clock=clockBase+steps.length,fields=purchaseWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson:JSON.stringify({business:rows('businesses')[0],outlet:rows('outlets')[0],supplier:('supplierId'in c||c.type==='purchase.record')?rows('suppliers')[0]??null:null,purchase:c.type==='purchase.undo'?rows('purchases')[0]:null,stock:[]})},c,ticket);
  steps.push({id:c.id,type:c.type,ticket,plan:purchaseWritePlan(c),hash:await purchaseFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const i=records.findIndex(x=>x.table===r.table&&x.values.id===r.values.id);if(i<0)records.push(r);else records[i]=r;}
 }
 await step({...base(),type:'supplier.create',supplierId,input:{name:literal,phone:'০১৭১২৩৪৫৪৮৩',note:literal}});
 await step({...base(),type:'supplier.update',supplierId,revision:supplier().revision,input:{name:'Updated '+literal,phone:'01712345483',note:literal}});
 await step({...base(),type:'purchase.record',purchaseId,input:{supplierId,supplierName:'Ignored selected supplier label',reference:literal,paid:'wallet',wallet:'bKash',note:literal,lines:[{stockItemId:null,name:literal,unit:literal,qty:2.5,unitPrice:12001},{stockItemId:null,name:'Free',unit:'kg',qty:0.001,unitPrice:1}]}});
 await step({...base(),type:'purchase.undo',purchaseId});
 await step({...base(),type:'supplier.archive',supplierId,revision:supplier().revision});
 await step({...base(),type:'supplier.restore',supplierId,revision:supplier().revision});
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v),allowed=new Set(['businesses','outlets','members','member_outlets']);
 const inserts=f.baseRecords.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid fixture record');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 const sql=`do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;
 caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;admission_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   if public.admit_purchase_record(${quote(f.outletId)}) is not true then raise exception 'Owner invoice admission failed';end if;
   p:=public.prepare_purchase_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_purchase_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.purchase_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_purchase_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   begin perform public.admit_purchase_record(${quote(f.outletId)});exception when insufficient_privilege then admission_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_purchase_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred} or (s->>'type' like 'supplier.%' and r->>'supplierId'<>${quote(supplierId)}) or (s->>'type' like 'purchase.%' and r->>'purchaseId'<>${quote(purchaseId)}) then raise exception 'Supplier/invoice clocks or device IDs changed';end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_purchase_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Receipt replay mismatch';end if;completed:=completed+1;
  end loop;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'deviceIdsAndClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,'otherLargeBodyAdmissionDenied',admission_denied,
   'supplierRestored',(select archived_at is null and revision=4 and phone='+8801712345483' from public.suppliers where id=${quote(supplierId)}),
   'literalUnicodeRetained',(select name::text=${quote(JSON.stringify('Updated '+literal))} and note::text=${quote(JSON.stringify(literal))} from public.suppliers where id=${quote(supplierId)}),
   'exactInvoiceTotal',(select total=30003 and paid='wallet' and method_name::text='"bKash"' and supplier_name::text=${quote(JSON.stringify('Updated '+literal))} from public.purchases where id=${quote(purchaseId)}),
   'invoiceVoided',(select voided_at=${occurred} from public.purchases where id=${quote(purchaseId)}),
   'stockRows',(select count(*) from public.stock_items where business_id=${quote(f.businessId)}),'stockMoves',(select count(*) from public.stock_moves where business_id=${quote(f.businessId)}),
   'customerDebtEntries',(select count(*) from public.credit_entries where business_id=${quote(f.businessId)}),'sales',(select count(*) from public.sales where business_id=${quote(f.businessId)}),
   'pendingTickets',(select count(*) from private.purchase_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>6 or (proof->>'receipts')::int<>6 or (proof->>'pendingTickets')::int<>0 or not caller_denied or not raw_denied or not other_denied or not admission_denied
   or (proof->>'supplierRestored')::boolean is not true or (proof->>'literalUnicodeRetained')::boolean is not true or (proof->>'exactInvoiceTotal')::boolean is not true or (proof->>'invoiceVoided')::boolean is not true
   or (proof->>'stockRows')::int<>0 or (proof->>'stockMoves')::int<>0 or (proof->>'customerDebtEntries')::int<>0 or (proof->>'sales')::int<>0 then raise exception 'Supplier/invoice verification failed';end if;
  raise exception using errcode='MZ005',message='Roll back supplier/invoice verification fixture';
 exception when sqlstate 'MZ005' then null;end;
 perform set_config('mise.purchase_verification',proof::text,true);
end $verify$;
select current_setting('mise.purchase_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.purchase_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('Retain fixture Unicode as escaped JSON');return sql;
}
