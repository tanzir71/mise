import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {parseShopCommand,type CustomerCommand} from '../packages/core/shop-commands';
import {defaultCreditTerms} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';
import {customerFingerprint,customerWriteFields} from '../supabase/functions/_shared/customer-write';
/** Synthetic SQL-role verification only; always roll back Auth and domain writes. */
export async function customerHostedFixture(){
  const subject='00000000-0000-4000-8000-000000009001',otherSubject='00000000-0000-4000-8000-000000009002',at=Date.now(),s=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Mise customer command probe',phone:'01712345482'},null,at).snapshot;
  const tables=emptyBackupTables();tables.businesses.push(s.business);tables.outlets.push(s.outlet);tables.members.push(s.owner);
  const base=await prepareCloudMigration(createBackup(tables),subject),ticketId=newInboxId();
  const command=parseShopCommand({id:newInboxId(),type:'customer.create',customerId:newInboxId(),outletId:s.outlet.id,
    input:{name:'করিম\0'+String.fromCharCode(0xd800),nickname:'Probe',phone:'০১৭১২৩৪৫৪৮৪',address:'',notes:'Synthetic only',tags:[' Regular ','regular']},
    ids:{accountId:newInboxId(),accountEventId:newInboxId(),openingEntryId:newInboxId(),openingEventId:newInboxId()},credit:{...defaultCreditTerms,allowed:true,limit:50000},opening:{amount:12345,occurredAt:at-86400000}}) as CustomerCommand;
  const contextJson=JSON.stringify({business:{id:s.business.id,name:s.business.name,business_type:s.business.businessType,market_code:s.business.marketCode,languages:s.business.languages,created_at:at,updated_at:at},
    outlet:{id:s.outlet.id,business_id:s.business.id,name:s.outlet.name,address:s.outlet.address,currency:s.outlet.currency,timezone:s.outlet.timezone,created_at:at,updated_at:at},customer:null,accounts:[],hasBalance:false});
  const fields=customerWriteFields({done:false,ticketId,token:'x'.repeat(43),businessId:s.business.id,outletId:s.outlet.id,actorId:s.owner.id,at,contextJson},command,ticketId);
  return {subject,otherSubject,businessId:s.business.id,outletId:s.outlet.id,actorId:s.owner.id,baseRecords:base.records,command,hash:await customerFingerprint(command),ticketId,records:fields.p_records as CloudRecord[]};
}
/** A single SQL statement group; MZ002 rolls back every synthetic identity/write. */
export async function customerHostedProofSql(){
  const f=await customerHostedFixture(),c=f.command;if(!('ids'in c))throw new Error('Profile IDs required');const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
  const managerSubject='00000000-0000-4000-8000-000000009003',managerId=newInboxId(),branchId=newInboxId(),branchAccountId=newInboxId(),ordinaryCommandId=newInboxId(),ordinaryTicketId=newInboxId(),statusCommandId=newInboxId(),statusTicketId=newInboxId();
  const value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v);
  const tables=new Set(['businesses','outlets','members','member_outlets']);
  const insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;
  const baseRecords=[...f.baseRecords,{table:'outlets',values:{...f.baseRecords.find(r=>r.table==='outlets')!.values,id:branchId,name:JSON.stringify('Probe branch')}},
    {table:'members',values:{id:managerId,business_id:f.businessId,auth_user_id:managerSubject,name:JSON.stringify('Probe manager'),role:'manager',active:true,created_at:1,updated_at:1}},
    {table:'member_outlets',values:{business_id:f.businessId,member_id:managerId,outlet_id:f.outletId}}];
  const inserts=baseRecords.map(r=>{if(!tables.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Unexpected fixture table');return insert(r);}).join('\n');
  const branchAccount:CloudRecord={table:'credit_accounts',values:{...f.records.find(r=>r.table==='credit_accounts')!.values,id:branchAccountId,outlet_id:branchId}};
  const recordClock=f.records.find(r=>r.table==='customers')!.values.created_at;
  const name=f.records.find(r=>r.table==='customers')!.values.name;
  const sql=`do $verify$
declare p jsonb;r jsonb;again jsonb;proof jsonb;ordinary jsonb;status_context jsonb;records jsonb:=${quote(JSON.stringify(f.records))}::jsonb;
 other_denied boolean:=false;raw_denied boolean:=false;caller_finish_denied boolean:=false;primary_tickets integer;
 manager_context_redacted boolean:=false;manager_status_denied boolean:=false;manager_all_assigned boolean:=false;manager_revoked_finish boolean:=false;manager_other_rows integer;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)},${quote(managerSubject)}) or phone in ('14155550199','14155550198','14155550197'))
   or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic fixture identity already exists';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now()),(${quote(managerSubject)},'14155550197',now());
  ${inserts}
  perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
  perform set_config('role','authenticated',true);
  p:=public.prepare_customer_intent(${quote(c.id)},${quote(f.ticketId)},${quote(c.type)},${quote(c.customerId)},${quote(c.outletId)},null,${quote(f.hash)},${quote(JSON.stringify(c.ids))}::jsonb);
  records:=replace(records::text,${quote(String(recordClock))},p->>'at')::jsonb;
  begin perform public.finish_customer_write(${quote(f.ticketId)},p->>'token',records);
  exception when insufficient_privilege then caller_finish_denied:=true;end;
  begin perform 1 from private.customer_write_tickets;
  exception when insufficient_privilege then raw_denied:=true;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
  begin perform public.prepare_customer_intent(${quote(c.id)},${quote(f.ticketId)},${quote(c.type)},${quote(c.customerId)},${quote(c.outletId)},null,${quote(f.hash)},${quote(JSON.stringify(c.ids))}::jsonb);
  exception when insufficient_privilege then other_denied:=true;end;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);perform set_config('role','service_role',true);
  r:=public.finish_customer_write(${quote(f.ticketId)},p->>'token',records);
  perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
  again:=public.prepare_customer_intent(${quote(c.id)},${quote(f.ticketId)},${quote(c.type)},${quote(c.customerId)},${quote(c.outletId)},null,${quote(f.hash)},${quote(JSON.stringify(c.ids))}::jsonb);
  if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Receipt replay failed';end if;
  perform set_config('role','postgres',true);
  select count(*) into primary_tickets from private.customer_write_tickets where command_id=${quote(c.id)};
  insert into public.customer_outlets(business_id,outlet_id,customer_id) values(${quote(f.businessId)},${quote(branchId)},${quote(c.customerId)});
  ${insert(branchAccount)}
  perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(managerSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
  perform set_config('role','authenticated',true);
  select count(*) into manager_other_rows from public.credit_accounts where id=${quote(branchAccountId)};
  ordinary:=public.prepare_customer_intent(${quote(ordinaryCommandId)},${quote(ordinaryTicketId)},'customer.update',${quote(c.customerId)},${quote(c.outletId)},null,${quote('a'.repeat(64))},${quote(JSON.stringify({...c.ids,accountEventId:newInboxId(),openingEntryId:newInboxId(),openingEventId:newInboxId()}))}::jsonb);
  manager_context_redacted:=right(replace(ordinary->>'contextJson',' ',''),length('"hasBalance":false}'))='"hasBalance":false}'
    and strpos(ordinary->>'contextJson',${quote(branchAccountId)})=0;
  begin perform public.prepare_customer_intent(${quote(statusCommandId)},${quote(statusTicketId)},'customer.archive',${quote(c.customerId)},${quote(c.outletId)},null,${quote('b'.repeat(64))},null);
  exception when insufficient_privilege then manager_status_denied:=true;end;
  perform set_config('role','postgres',true);
  insert into public.member_outlets values(${quote(f.businessId)},${quote(managerId)},${quote(branchId)});
  perform set_config('role','authenticated',true);
  status_context:=public.prepare_customer_intent(${quote(statusCommandId)},${quote(statusTicketId)},'customer.archive',${quote(c.customerId)},${quote(c.outletId)},null,${quote('b'.repeat(64))},null);
  manager_all_assigned:=status_context->>'done'='false';
  perform set_config('role','postgres',true);
  delete from public.member_outlets where business_id=${quote(f.businessId)} and member_id=${quote(managerId)} and outlet_id=${quote(branchId)};
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);perform set_config('role','service_role',true);
  begin perform public.finish_customer_write(${quote(statusTicketId)},status_context->>'token','[]'::jsonb);
  exception when insufficient_privilege then manager_revoked_finish:=true;end;
  perform set_config('role','postgres',true);
  proof:=jsonb_build_object('originalActor',(select bool_and(actor_id=${quote(f.actorId)}) from public.events where business_id=${quote(f.businessId)}),
   'literalUnicodeRoundTrip',(select name::text=${quote(name)} from public.customers where id=${quote(c.customerId)}),
   'deviceIdsRetained',r->>'accountId'=${quote(c.ids.accountId)} and r->>'accountEventId'=${quote(c.ids.accountEventId)} and r->>'entryId'=${quote(c.ids.openingEntryId)} and r->>'openingEventId'=${quote(c.ids.openingEventId)} and exists(select 1 from public.credit_entries e where e.id=${quote(c.ids.openingEntryId)} and e.account_id=${quote(c.ids.accountId)} and e.event_id=${quote(c.ids.openingEventId)}),
   'serverClockAgrees',exists(select 1 from public.customers saved where saved.id=${quote(c.customerId)} and saved.updated_at=(p->>'at')::bigint and saved.updated_at=(r->>'customerUpdatedAt')::bigint) and (select bool_and(at=(r->>'at')::bigint) from public.events where business_id=${quote(f.businessId)}),
   'normalizedPhone',(select phone='+8801712345484' from public.customers where id=${quote(c.customerId)}),
   'customerRows',(select count(*) from public.customers where business_id=${quote(f.businessId)}),
   'accountRows',(select count(*) from public.credit_accounts where business_id=${quote(f.businessId)} and outlet_id=${quote(f.outletId)}),
   'openingEntries',(select count(*) from public.credit_entries where business_id=${quote(f.businessId)} and type='adjustment' and amount=12345),
   'ledgerBalance',(select sum(amount) from public.credit_entries where business_id=${quote(f.businessId)}),
   'auditRows',(select count(*) from public.events where business_id=${quote(f.businessId)}),
   'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'ticketsAfterCommit',primary_tickets,
   'managerOtherOutletRows',manager_other_rows,'managerOrdinaryContextRedacted',manager_context_redacted,'managerUnassignedStatusDenied',manager_status_denied,
   'managerAllAssignedCanPrepare',manager_all_assigned,'managerRevocationAtFinishDenied',manager_revoked_finish,
   'receiptReplay',again->'receipt'=r,'rawStagingDenied',raw_denied,'ordinaryCallerFinishDenied',caller_finish_denied,'differentConfirmedUserDenied',other_denied);
  if not other_denied or not raw_denied or not caller_finish_denied or not manager_context_redacted or not manager_status_denied or not manager_all_assigned or not manager_revoked_finish or manager_other_rows<>0 or (proof->>'customerRows')::int<>1 or (proof->>'accountRows')::int<>1
   or (proof->>'openingEntries')::int<>1 or (proof->>'ledgerBalance')::int<>12345 or (proof->>'auditRows')::int<>3 or (proof->>'receipts')::int<>1
   or (proof->>'deviceIdsRetained')::boolean is not true or (proof->>'serverClockAgrees')::boolean is not true or (proof->>'ticketsAfterCommit')::int<>0 or (proof->>'literalUnicodeRoundTrip')::boolean is not true or (proof->>'originalActor')::boolean is not true then
   raise exception 'Customer command verification failed';end if;
  raise exception using errcode='MZ002',message='Rollback synthetic customer command fixture';
 exception when sqlstate 'MZ002' then null;
 end;
 perform set_config('mise.customer_command_verification',proof::text,true);
end $verify$;
select current_setting('mise.customer_command_verification')::jsonb as proof,
 (select count(*) from auth.users) as auth_users,(select count(*) from public.businesses) as businesses,
 (select count(*) from public.customers) as customers,(select count(*) from public.credit_accounts) as accounts,
 (select count(*) from public.credit_entries) as entries,(select count(*) from public.events) as events,
 (select count(*) from private.shop_command_receipts) as receipts,(select count(*) from private.customer_write_tickets) as tickets;`;
  if(/[\u0000\ud800-\udfff]/.test(sql))throw new Error('SQL fixture must retain literal data as escaped JSON');
  return sql;
}
