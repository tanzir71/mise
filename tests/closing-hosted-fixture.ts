import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMaps,decodeCommandRecord,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {Business,DayClosing,Outlet} from '../packages/core/models';
import type {NamedShopSetup} from '../packages/core/shop-access';
import {recordSaleCommand} from '../packages/core/sales';
import {closingPreview,dayKey,type TodayContext} from '../packages/core/today';
import {closingWritePlan,type ClosingCommand} from '../packages/core/closing-commands';
import {closingFingerprint,closingWriteFields} from '../supabase/functions/_shared/closing-write';
import {newInboxId} from '../packages/core/inbox';
/** Five actual SQL-role transactions, rolled back with their fictional identities. */
export async function closingHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now(),clockBase=occurred+100000,literal='সমাপনী\0'+String.fromCharCode(0xd800);
 // Keep the synthetic admission clock on the same day, including around midnight.
 // Production closing/undo clock rules are unchanged.
 const timezone=['Asia/Dhaka','UTC'].find(zone=>dayKey(occurred,zone)===dayKey(clockBase+10000,zone))!;
 const base=f.baseRecords.map(r=>['businesses','outlets','members'].includes(r.table)?{...r,values:{...r.values,name:JSON.stringify(literal),...(r.table==='outlets'?{timezone}:{})}}:r),records:CloudRecord[]=[...base];
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const rows=(table:BackupTable)=>records.filter(r=>r.table===cloudRecordMaps[table].table).map(r=>raw(table,r));
 const business=decodeCommandRecord('businesses',rows('businesses')[0]) as unknown as Business,outlet=decodeCommandRecord('outlets',rows('outlets')[0]) as unknown as Outlet,setup:NamedShopSetup={business,outlet,owner:{id:f.actorId,name:literal,businessId:f.businessId,active:true,outletIds:[outlet.id]}};
 const initial=recordSaleCommand({expression:'100',method:'cash'},{setup,items:[],wallets:[]},occurred-1000);
 records.push(encodeCommandRecord('sales',initial.sale,f.businessId),encodeCommandRecord('events',initial.event,f.businessId));
 const steps:{id:string;type:string;ticket:string;plan:ReturnType<typeof closingWritePlan>;hash:string;clock:string;records:string}[]=[];
 async function step(c:ClosingCommand){
  const ticket=newInboxId(),clock=clockBase+steps.length,closing=rows('dayClosings').find(r=>r.id===c.closingId)??null,sale=c.type==='closing.undo'?rows('sales').find(r=>r.id===c.saleId)??null:null;
  const fields=closingWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson:JSON.stringify({business:rows('businesses')[0],outlet:rows('outlets')[0],actorName:literal,closing,sale,sales:rows('sales'),orders:[],refunds:[],accounts:[],entries:[],customers:[],stock:[],closings:rows('dayClosings')})},c,ticket);
  steps.push({id:c.id,type:c.type,ticket,plan:closingWritePlan(c),hash:await closingFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const i=records.findIndex(x=>x.table===r.table&&x.values.id===r.values.id);if(i<0)records.push(r);else records[i]=r;}
 }
 const ctx=()=>({setup,sales:rows('sales').map(r=>decodeCommandRecord('sales',r)),orders:[],refunds:[],accounts:[],entries:[],customers:[],stock:[],closings:rows('dayClosings').map(r=>decodeCommandRecord('dayClosings',r))}) as unknown as TodayContext<NamedShopSetup>;
 async function close(countedCash:number,addDifference:boolean){const p=closingPreview(ctx(),occurred),c:ClosingCommand={id:newInboxId(),type:'closing.record',outletId:f.outletId,closingId:newInboxId(),occurredAt:occurred,saleId:addDifference?newInboxId():null,saleEventId:addDifference?newInboxId():null,input:{day:p.summary.day,fingerprint:p.fingerprint,countedCash,addDifference,note:literal}};await step(c);return c;}
 async function undo(id:string){const c=decodeCommandRecord('dayClosings',rows('dayClosings').find(r=>r.id===id)!) as unknown as DayClosing;await step({id:newInboxId(),type:'closing.undo',outletId:f.outletId,closingId:id,occurredAt:occurred,saleId:c.addedSaleId??null,saleEventId:c.addedSaleId?newInboxId():null});}
 const first=await close(12501,true);await undo(first.closingId);const second=await close(9000,false);await undo(second.closingId);const last=await close(10000,false);
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v);
 const seeded=[...base,encodeCommandRecord('sales',initial.sale,f.businessId),encodeCommandRecord('events',initial.event,f.businessId)],allowed=new Set(['businesses','outlets','members','member_outlets','sales','events']);
 const inserts=seeded.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid closing fixture record');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 const sql=`do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;first_receipt jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   p:=public.prepare_closing_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected closing replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_closing_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.closing_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_closing_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_closing_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred} or r->>'closingId'<>s->'plan'->>'closingId' then raise exception 'Closing device IDs or clocks changed';end if;
   if completed=0 then first_receipt:=r;end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_closing_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Closing replay mismatch';end if;completed:=completed+1;
  end loop;
  s:=(${quote(JSON.stringify(steps))}::jsonb)->0;
  again:=public.prepare_closing_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
  if again->'receipt'<>first_receipt then raise exception 'Closing history replaced the original receipt';end if;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'deviceIdsAndClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,
   'historicalClosings',(select count(*) from public.day_closings where business_id=${quote(f.businessId)}),'activeClosings',(select count(*) from public.day_closings where business_id=${quote(f.businessId)} and voided_at is null),
   'surplusReceiptVoided',(select voided_at=${occurred} and amount=2501 and closing_id=${quote(first.closingId)} from public.sales where id=${quote(first.saleId)}),
   'originalCashRetained',(select voided_at is null and amount=10000 from public.sales where id=${quote(initial.sale.id)}),
   'shortfallSnapshotRetained',(select voided_at=${occurred} and difference=-1000 and counted_cash=9000 and expected_cash=10000 and added_sale_id is null from public.day_closings where id=${quote(second.closingId)}),
   'finalSnapshotRetained',(select voided_at is null and difference=0 and counted_cash=10000 and expected_cash=10000 and added_sale_id is null from public.day_closings where id=${quote(last.closingId)}),
   'literalUnicodeRetained',(select bool_and(note::text=${quote(JSON.stringify(literal))} and created_by_name::text=${quote(JSON.stringify(literal))}) from public.day_closings where business_id=${quote(f.businessId)}),
   'audits',(select count(*) from public.events where business_id=${quote(f.businessId)}),'pendingTickets',(select count(*) from private.closing_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>5 or (proof->>'receipts')::int<>5 or (proof->>'pendingTickets')::int<>0 or (proof->>'audits')::int<>8 or (proof->>'historicalClosings')::int<>3 or (proof->>'activeClosings')::int<>1
   or not caller_denied or not raw_denied or not other_denied or exists(select 1 from unnest(array['surplusReceiptVoided','originalCashRetained','shortfallSnapshotRetained','finalSnapshotRetained','literalUnicodeRetained']) k where (proof->>k)::boolean is not true) then raise exception 'Closing verification failed';end if;
  raise exception using errcode='MZ007',message='Roll back closing verification fixture';
 exception when sqlstate 'MZ007' then null;end;
 perform set_config('mise.closing_verification',proof::text,true);
end $verify$;
select current_setting('mise.closing_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.closing_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('Retain closing fixture Unicode as escaped JSON');return sql;
}
