import {customerHostedFixture} from './customer-hosted-fixture';
import {cloudRecordMap,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import {moneyWritePlan,type MoneyCommand} from '../packages/core/money-commands';
import {moneyFingerprint,moneyWriteFields} from '../supabase/functions/_shared/money-write';
import {newInboxId} from '../packages/core/inbox';
/** All fictional Auth/domain writes roll back in one SQL subtransaction. */
export async function moneyHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now()-1000,clockBase=Date.now()+10000;
 const records=[...f.baseRecords,...f.records,{table:'customer_outlets',values:{business_id:f.businessId,outlet_id:f.outletId,customer_id:f.command.customerId}} as CloudRecord];
 const account=records.find(r=>r.table==='credit_accounts')!.values.id as string;
 const raw=(table:BackupTable,r:CloudRecord)=>Object.fromEntries(Object.entries(r.values).map(([k,v])=>[k,v!==null&&(cloudRecordMap(table).fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const row=(table:BackupTable,id?:string)=>{const r=records.find(r=>r.table===cloudRecordMap(table).table&&(id===undefined||r.values.id===id));return r?raw(table,r):null;};
 const base=()=>({id:newInboxId(),occurredAt:occurred,outletId:f.outletId});
 const cash:MoneyCommand={...base(),type:'sale.record',saleId:newInboxId(),input:{expression:'100',method:'cash',given:12000,wallet:null,who:'Synthetic only',items:[]}};
 const credit:MoneyCommand={...base(),type:'sale.credit',saleId:newInboxId(),accountId:account,entryId:newInboxId(),creditEventId:newInboxId(),input:{expression:'100',items:[],confirmation:null}};
 const payment:MoneyCommand={...base(),type:'khata.payment',accountId:account,entryId:newInboxId(),input:{amount:5000,method:'cash',wallet:null,note:'হিসাব\0'+String.fromCharCode(0xd800)}};
 const commands:MoneyCommand[]=[cash,credit,payment,{...base(),type:'khata.undo',entryId:payment.entryId,reversalId:newInboxId()},
  {...base(),type:'sale.undo',saleId:cash.saleId,entryId:null,creditEventId:null},{...base(),type:'sale.undo',saleId:credit.saleId,entryId:newInboxId(),creditEventId:newInboxId()},
  {...base(),type:'khata.communication',accountId:account,entryId:newInboxId(),input:{purpose:'reminder',channel:'manual',text:'Manual record only'}}];
 const steps=[];
 for(const [i,c] of commands.entries()){
  const ticket=newInboxId(),clock=clockBase+i,chosen='accountId'in c?c.accountId:c.type==='khata.undo'||c.type==='sale.undo'&&c.entryId?account:null;
  const target=c.type==='khata.undo'?c.entryId:c.type==='sale.undo'&&c.entryId?credit.entryId:undefined;
  const fields=moneyWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson:JSON.stringify({business:row('businesses'),outlet:row('outlets'),customer:chosen?row('customers'):null,account:chosen?row('creditAccounts',chosen):null,sale:'saleId'in c?row('sales',c.saleId):null,entry:target?row('creditEntries',target):null,entries:chosen?records.filter(r=>r.table==='credit_entries'&&r.values.account_id===chosen).map(r=>raw('creditEntries',r)):[],items:[]})},c,ticket);
  steps.push({id:c.id,type:c.type,outlet:c.outletId,occurred:c.occurredAt,ticket,plan:moneyWritePlan(c),hash:await moneyFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
  for(const r of fields.p_records as CloudRecord[]){const old=records.findIndex(v=>v.table===r.table&&v.values.id===r.values.id);if(old>=0)records[old]=r;else records.push(r);}
 }
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v);
 const initial=[...f.baseRecords,...f.records,{table:'customer_outlets',values:{business_id:f.businessId,outlet_id:f.outletId,customer_id:f.command.customerId}} as CloudRecord];
 const allowed=new Set(['businesses','outlets','members','member_outlets','customers','credit_accounts','credit_entries','events','customer_outlets']);
 const inserts=initial.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid fixture record');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 return `do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;
 caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   p:=public.prepare_money_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',(s->>'outlet')::public.ulid,s->'plan',s->>'hash',(s->>'occurred')::public.utc_ms);
   if p->>'done'<>'false' then raise exception 'Unexpected replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';
   -- Replace only generated fixture server-clock markers, including nested audit
   -- snapshots. Original device times and literal text remain untouched.
   for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_money_write((s->>'ticket')::public.ulid,p->>'token',(s->>'occurred')::public.utc_ms,payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.money_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_money_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',(s->>'outlet')::public.ulid,s->'plan',s->>'hash',(s->>'occurred')::public.utc_ms);exception when insufficient_privilege then other_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_money_write((s->>'ticket')::public.ulid,p->>'token',(s->>'occurred')::public.utc_ms,payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>(s->>'occurred')::bigint then raise exception 'Financial clocks changed';end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_money_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',(s->>'outlet')::public.ulid,s->'plan',s->>'hash',(s->>'occurred')::public.utc_ms);
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Receipt replay mismatch';end if;completed:=completed+1;
  end loop;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'allClocksRetained',true,'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,
   'salesVoided',(select count(*) from public.sales where business_id=${quote(f.businessId)} and void_reason='undo'),
   'finalBalance',(select sum(case when type='payment' then -amount when type in ('charge','adjustment') then amount else 0 end) from public.credit_entries where account_id=${quote(account)}),
   'literalPaymentRetained',(select note::text=${quote(JSON.stringify(payment.input.note))} from public.credit_entries where id=${quote(payment.entryId)}),
   'pendingTickets',(select count(*) from private.money_write_tickets where business_id=${quote(f.businessId)})) into proof;
  raise exception using errcode='MZ003',message='Roll back financial verification fixture';
 exception when sqlstate 'MZ003' then null;end;
 perform set_config('mise.money_verification',proof::text,true);
end $verify$;
select current_setting('mise.money_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)} and name::text=${quote(JSON.stringify('Mise customer command probe'))}) business_rows,
 (select count(*) from private.money_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
}
