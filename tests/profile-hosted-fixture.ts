import {setupCommand,normaliseSetupInput} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {parseProfileCommand,profileWritePlan,type ProfileCommand} from '../packages/core/profile-commands';
import {profileFingerprint} from '../supabase/functions/_shared/profile-write';
/** Synthetic role checks only: no real owner JWT, OTP, SMS or Auth commissioning. */
export async function profileHostedProofSql(){
 const owner='00000000-0000-4000-8000-000000009501',other='00000000-0000-4000-8000-000000009502',manager='00000000-0000-4000-8000-000000009503',otherId=newInboxId(),managerId=newInboxId(),branchId=newInboxId(),at=Date.now()-1000,literal='প্রোফাইল\0'+String.fromCharCode(0xd800);
 const s=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Original '+literal,phone:'01712345482'},null,at-10000).snapshot;
 const tables=emptyBackupTables();tables.businesses.push(s.business);tables.outlets.push(s.outlet);tables.members.push(s.owner);const seed=(await prepareCloudMigration(createBackup(tables),owner)).records;
 const first=parseProfileCommand({id:newInboxId(),type:'setup.update',businessId:s.business.id,outletId:s.outlet.id,ownerId:s.owner.id,occurredAt:at,input:normaliseSetupInput({businessType:'restaurant',marketCode:'IN',name:literal,phone:'+919876543210',outletName:'Updated outlet',address:literal,language:'bn',currency:'INR',timezone:'Asia/Kolkata'})});
 const last=parseProfileCommand({...first,id:newInboxId(),input:{...first.input,name:'Latest '+literal}}),second=parseProfileCommand({...last,id:newInboxId(),ownerId:otherId,input:{...last.input,phone:'+14155550952'}});
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`;
 const auth=(uid:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:uid,user_metadata:{role:'owner'}}))},true);set local role authenticated;`,service="reset role;perform set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);set local role service_role;";
 const prepare=async(c:ProfileCommand,plan=profileWritePlan(c))=>`public.prepare_profile_write(${q(c.id)},${q(newInboxId())},${q(c.businessId)},${q(c.outletId)},${q(c.ownerId)},${q(JSON.stringify(plan))}::jsonb,${q(await profileFingerprint(c))},${c.occurredAt})`;
 const finish=(c:ProfileCommand,input=JSON.stringify(c.input))=>`public.finish_profile_write((p->>'ticketId')::public.ulid,p->>'token',${q(input)})`;
 const bad=profileWritePlan(first);bad.input.nameJson='"substituted"';
 const code=[
  'do $mise_profile$ declare p jsonb;r jsonb;original jsonb;proof jsonb;other_contact_denied boolean:=false;manager_denied boolean:=false;plan_bound boolean:=false;completion_bound boolean:=false;client_finish_denied boolean:=false;client_private_denied boolean:=false;service_private_denied boolean:=false;begin begin',
  `insert into auth.users(id,phone,phone_confirmed_at) values(${q(owner)},'14155550951',now()),(${q(other)},'14155550952',now()),(${q(manager)},'14155550953',now());`,...seed.map(insert),
  `insert into public.outlets(id,business_id,name,address,timezone,currency,created_at,updated_at) values(${q(branchId)},${q(s.business.id)},'"Other outlet"','"Original branch"','UTC','USD',1,1);`,
  `insert into public.member_outlets values(${q(s.business.id)},${q(s.owner.id)},${q(branchId)});`,
  `insert into public.members(id,business_id,auth_user_id,name,phone,role,permissions,created_at,updated_at) values(${q(otherId)},${q(s.business.id)},${q(other)},'"Other owner"','+14155550952','owner','{"preserve":true}',1,1),(${q(managerId)},${q(s.business.id)},${q(manager)},'"Manager"','+14155550953','manager','{}',1,1);`,
  `insert into public.member_outlets values(${q(s.business.id)},${q(otherId)},${q(branchId)}),(${q(s.business.id)},${q(managerId)},${q(s.outlet.id)});`,
  auth(manager),`begin perform ${await prepare(first)};raise exception 'Manager accepted owner profile';exception when insufficient_privilege then manager_denied:=true;end;`,
  auth(other),`begin perform ${await prepare(first)};raise exception 'Other owner contact accepted';exception when insufficient_privilege then other_contact_denied:=true;end;`,
  auth(owner),`begin perform ${await prepare(first,bad)};raise exception 'Substituted plan accepted';exception when invalid_parameter_value then plan_bound:=true;end;`,
  `p:=${await prepare(first)};begin perform ${finish(first)};raise exception 'Client completion accepted';exception when insufficient_privilege then client_finish_denied:=true;end;begin perform 1 from private.profile_write_tickets;raise exception 'Client private read accepted';exception when insufficient_privilege then client_private_denied:=true;end;`,
  service,`begin perform ${finish(first,JSON.stringify({...first.input,name:'Substituted'}))};raise exception 'Substituted completion accepted';exception when invalid_parameter_value then completion_bound:=true;end;begin perform 1 from private.profile_write_tickets;raise exception 'Service private read accepted';exception when insufficient_privilege then service_private_denied:=true;end;original:=${finish(first)};`,
  auth(owner),`p:=${await prepare(last)};`,service,`r:=${finish(last)};`,
  auth(owner),`p:=${await prepare(first)};if not (p->>'done')::boolean or p->'receipt' is distinct from original then raise exception 'Historical profile replay changed';end if;`,
  auth(other),`p:=${await prepare(second)};`,service,`r:=${finish(second)};`,
  'reset role;',
  `proof:=jsonb_build_object('commands',3,'audits',(select count(*) from public.events where business_id=${q(s.business.id)}),'receipts',(select count(*) from private.shop_command_receipts where business_id=${q(s.business.id)}),'pendingTickets',(select count(*) from private.profile_write_tickets where business_id=${q(s.business.id)}),`+
   `'managerDenied',manager_denied,'otherOwnerContactDenied',other_contact_denied,'normalizedPlanBound',plan_bound,'normalizedCompletionBound',completion_bound,'clientCompletionDenied',client_finish_denied,'privateReadsDenied',client_private_denied and service_private_denied,`+
   `'literalProfileRetained',(select name::text=${q(JSON.stringify(last.input.name))} and business_type='restaurant' and market_code='IN' and languages::text='["bn"]' from public.businesses where id=${q(s.business.id)}),`+
   `'otherOutletRetained',(select address::text='"Original branch"' and currency='USD' and timezone='UTC' and updated_at=1 from public.outlets where id=${q(branchId)}),`+
   `'ownerAssignmentsRetained',(select count(*)=2 from public.member_outlets where member_id=${q(s.owner.id)}),`+
   `'otherOwnerPermissionsRetained',(select permissions='{"preserve":true}'::jsonb and role='owner' and phone='+14155550952' from public.members where id=${q(otherId)}),`+
   `'firstOwnerContactRetained',(select phone=${q(first.input.phone)} from public.members where id=${q(s.owner.id)}),`+
   `'authLoginPhonesUnchanged',(select count(*)=3 from auth.users where (id,phone) in ((${q(owner)}::uuid,'14155550951'),(${q(other)}::uuid,'14155550952'),(${q(manager)}::uuid,'14155550953'))),`+
   `'originalOccurrenceRetained',r->>'occurredAt'=${q(at)},'secondOwnerActorRetained',r->>'ownerId'=${q(otherId)},`+
   `'noFinancialSideEffects',(select count(*)=0 from public.sales where business_id=${q(s.business.id)}) and (select count(*)=0 from public.credit_entries where business_id=${q(s.business.id)}));`,
  "raise exception using errcode='MZ007';exception when sqlstate 'MZ007' then perform set_config('mise.profile_command_verification',proof::text,true);end;end $mise_profile$;",
  `select current_setting('mise.profile_command_verification')::jsonb proof,(select count(*)::int from auth.users where id in (${q(owner)},${q(other)},${q(manager)})) auth_rows,(select count(*)::int from public.businesses where id=${q(s.business.id)}) business_rows,(select count(*)::int from private.profile_write_tickets where business_id=${q(s.business.id)}) ticket_rows;`
 ];
 const query=code.join('\n');if(query.includes('\0')||/[\ud800-\udfff]/.test(query))throw Error('Use escaped literal JSON in SQL fixtures.');return query;
}
