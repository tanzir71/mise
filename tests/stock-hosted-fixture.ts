import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMap,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {StockItem} from '../packages/core/models';
import {newInboxId} from '../packages/core/inbox';
import {stockWritePlan,type StockCommand,type StockSaveInput} from '../packages/core/stock-commands';
import {stockFingerprint,stockWriteFields} from '../supabase/functions/_shared/stock-write';
/** SQL-role proof only: one deliberate exception rolls back all synthetic writes. */
export async function stockHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now()-1000,clockBase=Date.now()+100000,records:CloudRecord[]=[...f.baseRecords];
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMap(table).fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const rows=(table:BackupTable)=>records.filter(r=>r.table===cloudRecordMap(table).table).map(r=>raw(table,r));
 const item=(id:string)=>decodeCommandRecord('stockItems',rows('stockItems').find(r=>r.id===id)!) as unknown as StockItem;
 const a=newInboxId(),b=newInboxId(),base=()=>({id:newInboxId(),outletId:f.outletId,occurredAt:occurred}),literal='চাল\0'+String.fromCharCode(0xd800);
 const input:StockSaveInput={name:literal,nameLocal:literal,unit:'kg',category:'Food',aliases:[literal],onHand:20.125,target:30,packSize:1,lowAt:null,supplierId:null};
 const steps:{id:string;type:string;ticket:string;plan:ReturnType<typeof stockWritePlan>;hash:string;clock:string;records:string}[]=[];
 async function step(c:StockCommand){
  const ticket=newInboxId(),clock=clockBase+steps.length,plan=stockWritePlan(c),fields=stockWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson:JSON.stringify({business:rows('businesses')[0],outlet:rows('outlets')[0],items:rows('stockItems'),moves:rows('stockMoves').filter(m=>plan.rows.some(p=>p.itemId===m.stock_item_id)),suppliers:[]})},c,ticket);
  steps.push({id:c.id,type:c.type,ticket,plan:stockWritePlan(c),hash:await stockFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const i=records.findIndex(x=>x.table===r.table&&x.values.id===r.values.id);if(i<0)records.push(r);else records[i]=r;}
 }
 await step({...base(),type:'stock.create',stockItemId:a,moveId:newInboxId(),input});
 await step({...base(),type:'stock.create',stockItemId:b,moveId:newInboxId(),input:{...input,name:'Oil'}});
 await step({...base(),type:'stock.update',stockItemId:a,revision:1,moveId:null,input:{...input,category:'Updated'}});
 await step({...base(),type:'stock.adjust',moveId:newInboxId(),change:{id:a,revision:item(a).revision,reason:'used',quantity:1.125,source:'manual',note:literal}});
 // A retained relative intent survives intervening metadata and relative writes.
 await step({...base(),type:'stock.adjust',moveId:newInboxId(),change:{id:a,revision:1,reason:'received',quantity:2,source:'quick_update',note:literal}});
 const count=base(),countMove=newInboxId(),batchId=newInboxId();
 await step({...count,type:'stock.batch',count:true,batchId,changes:[{id:a,revision:item(a).revision,eventId:count.id,moveId:countMove,reason:'count',quantity:0,source:'count',note:literal},{id:b,revision:item(b).revision,eventId:newInboxId(),moveId:newInboxId(),reason:'count',quantity:8,source:'count',note:'Physical count'}]});
 await step({...base(),type:'stock.undo',stockItemId:a,revision:item(a).revision,undoMoveId:countMove,moveId:newInboxId()});
 await step({...base(),type:'stock.archive',stockItemId:a,revision:item(a).revision});
 await step({...base(),type:'stock.restore',stockItemId:a,revision:item(a).revision});
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
   if public.admit_stock_batch(${quote(f.outletId)}) is not true then raise exception 'Owner batch admission failed';end if;
   p:=public.prepare_stock_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';
   for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_stock_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.stock_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_stock_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   begin perform public.admit_stock_batch(${quote(f.outletId)});exception when insufficient_privilege then admission_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_stock_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred}
     or exists(select 1 from jsonb_array_elements(r->'results') with ordinality x where x.value->>'stockItemId' is distinct from s->'plan'->'rows'->(x.ordinality::int-1)->>'itemId'
       or x.value->>'eventId' is distinct from s->'plan'->'rows'->(x.ordinality::int-1)->>'eventId' or x.value->>'moveId' is distinct from s->'plan'->'rows'->(x.ordinality::int-1)->>'moveId') then raise exception 'Stock clocks or device IDs changed';end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_stock_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Receipt replay mismatch';end if;completed:=completed+1;
  end loop;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'deviceIdsAndClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,'otherBatchAdmissionDenied',admission_denied,
   'firstQuantity',(select on_hand from public.stock_items where id=${quote(a)}),'secondQuantity',(select on_hand from public.stock_items where id=${quote(b)}),
   'literalUnicodeRetained',(select name::text=${quote(JSON.stringify(literal))} from public.stock_items where id=${quote(a)}),
   'countBatchRetained',(select count(*)=2 from public.stock_moves where count_batch_id=${quote(batchId)} and reason='count'),
   'firstRestored',(select archived_at is null and active_key is not null from public.stock_items where id=${quote(a)}),
   'pendingTickets',(select count(*) from private.stock_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>9 or (proof->>'firstQuantity')::numeric<>21 or (proof->>'secondQuantity')::numeric<>8 or (proof->>'receipts')::int<>9 or (proof->>'pendingTickets')::int<>0
    or not caller_denied or not raw_denied or not other_denied or not admission_denied or (proof->>'literalUnicodeRetained')::boolean is not true or (proof->>'countBatchRetained')::boolean is not true or (proof->>'firstRestored')::boolean is not true then raise exception 'Stock verification failed';end if;
  raise exception using errcode='MZ004',message='Roll back stock verification fixture';
 exception when sqlstate 'MZ004' then null;end;
 perform set_config('mise.stock_verification',proof::text,true);
end $verify$;
select current_setting('mise.stock_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.stock_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('Retain fixture Unicode as escaped JSON');return sql;
}
