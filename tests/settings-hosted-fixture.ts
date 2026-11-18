import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {defaultCreditMessaging} from '../packages/core/khata-messages';
import {exportDatasets} from '../packages/core/exports';
import {newInboxId} from '../packages/core/inbox';
import {parseSettingsCommand,settingsWritePlan,type SettingsCommand} from '../packages/core/settings-commands';
import {settingsFingerprint} from '../supabase/functions/_shared/settings-write';

/** Synthetic database-role proof only. No signed owner JWT, SMS or file delivery. */
export async function settingsHostedProofSql(){
 const owner='00000000-0000-4000-8000-000000009401',manager='00000000-0000-4000-8000-000000009402',managerId=newInboxId(),branchId=newInboxId(),at=Date.now()-1000,literal='মূল\0'+String.fromCharCode(0xd800);
 const s=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Settings '+literal,phone:'01712345482'},null,at-10000).snapshot;
 const tables=emptyBackupTables();tables.businesses.push(s.business);tables.outlets.push(s.outlet);tables.members.push(s.owner);const seed=(await prepareCloudMigration(createBackup(tables),owner)).records;
 const wording=(note:string)=>({...defaultCreditMessaging,paymentNote:note,templates:{gentle:{...defaultCreditMessaging.templates.gentle,en:defaultCreditMessaging.templates.gentle.en+literal},direct:{...defaultCreditMessaging.templates.direct}}});
 const commands:SettingsCommand[]=[
  parseSettingsCommand({id:newInboxId(),type:'khata.wording',outletId:s.outlet.id,occurredAt:at,input:wording(literal)}),
  parseSettingsCommand({id:newInboxId(),type:'export.prepare',outletId:s.outlet.id,occurredAt:at,input:{format:'csv',datasets:[...exportDatasets],rows:123,filename:'তালিকা'+String.fromCharCode(0xd800)+'.csv',capturedAt:at-100,from:null,to:null,includePhones:false}}),
  parseSettingsCommand({id:newInboxId(),type:'khata.wording',outletId:s.outlet.id,occurredAt:at,input:wording('Later '+literal)}),
  parseSettingsCommand({id:newInboxId(),type:'export.prepare',outletId:s.outlet.id,occurredAt:at,input:{format:'json',datasets:[],rows:321,filename:'backup.json',capturedAt:at-100,from:null,to:null,includePhones:true}})
 ];
 const outside=parseSettingsCommand({...commands[3],id:newInboxId(),outletId:branchId});
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
 const insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':quote(v)).join(',')});`;
 const auth=(subject:string)=>`reset role;perform set_config('request.jwt.claims',${quote(JSON.stringify({role:'authenticated',sub:subject,user_metadata:{role:'owner'}}))},true);set local role authenticated;`;
 const service="reset role;perform set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);set local role service_role;";
 const prepare=async(c:SettingsCommand)=>`public.prepare_settings_write(${quote(c.id)},${quote(newInboxId())},${quote(c.type)},${quote(c.outletId)},${quote(JSON.stringify(settingsWritePlan(c)))}::jsonb,${quote(await settingsFingerprint(c))},${c.occurredAt})`;
 const finish=(c:SettingsCommand,input=JSON.stringify(c.input))=>`public.finish_settings_write((p->>'ticketId')::public.ulid,p->>'token',${quote(input)})`;
 const first=commands[0],exported=commands[1],last=commands[2],managed=commands[3],badPlan=settingsWritePlan(first);if(!('paymentNoteJson'in badPlan.input))throw Error();badPlan.input.paymentNoteJson='"substituted"';
 const code:string[]=[
  'do $mise_settings$ declare p jsonb;r jsonb;first_receipt jsonb;proof jsonb;ordinary_denied boolean:=false;private_denied boolean:=false;service_private_denied boolean:=false;scope_denied boolean:=false;other_actor_denied boolean:=false;plan_bound boolean:=false;completion_bound boolean:=false;begin begin',
  `insert into auth.users(id,phone,phone_confirmed_at) values(${quote(owner)},'14155559401',now()),(${quote(manager)},'14155559402',now());`,
  ...seed.map(insert),
  insert({table:'outlets',values:{...seed.find(r=>r.table==='outlets')!.values,id:branchId,name:JSON.stringify('Other branch')}}),
  `insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values(${quote(managerId)},${quote(s.business.id)},${quote(manager)},'"Manager"','manager',1,1);insert into public.member_outlets values(${quote(s.business.id)},${quote(managerId)},${quote(s.outlet.id)});`,
  auth(owner),
  `begin perform public.prepare_settings_write(${quote(first.id)},${quote(newInboxId())},'khata.wording',${quote(first.outletId)},${quote(JSON.stringify(badPlan))}::jsonb,${quote(await settingsFingerprint(first))},${first.occurredAt});raise exception 'Unbound fields accepted';exception when invalid_parameter_value then plan_bound:=true;end;`,
  `p:=${await prepare(first)};`,
  `begin perform ${finish(first)};raise exception 'Ordinary completion accepted';exception when insufficient_privilege then ordinary_denied:=true;end;`,
  `begin perform count(*) from private.settings_write_tickets;raise exception 'Private table readable';exception when insufficient_privilege then private_denied:=true;end;`,
  service,
  `begin perform count(*) from private.settings_write_tickets;raise exception 'Service table readable';exception when insufficient_privilege then service_private_denied:=true;end;`,
  `begin perform ${finish(first,JSON.stringify(defaultCreditMessaging))};raise exception 'Substituted completion accepted';exception when invalid_parameter_value then completion_bound:=true;end;`,
  `first_receipt:=${finish(first)};`,
  auth(owner),`p:=${await prepare(exported)};`,service,`r:=${finish(exported)};`,
  auth(owner),`p:=${await prepare(last)};`,service,`r:=${finish(last)};`,
  auth(owner),`p:=${await prepare(first)};if p->'receipt' is distinct from first_receipt then raise exception 'Historical replay changed';end if;`,
  auth(manager),
  `begin perform ${await prepare(first)};raise exception 'Another actor replay accepted';exception when insufficient_privilege then other_actor_denied:=true;end;`,
  `begin perform ${await prepare(outside)};raise exception 'Foreign outlet accepted';exception when insufficient_privilege then scope_denied:=true;end;`,
  `p:=${await prepare(managed)};`,service,`r:=${finish(managed)};`,
  'reset role;',
  `proof:=jsonb_build_object('commands',4,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(s.business.id)}),'audits',(select count(*) from public.events where business_id=${quote(s.business.id)}),
   'ordinaryCompletionDenied',ordinary_denied,'privateReadsDenied',private_denied and service_private_denied,'unassignedOutletDenied',scope_denied,'originalActorReplayOnly',other_actor_denied,'normalizedPlanBound',plan_bound,'normalizedCompletionBound',completion_bound,
   'latestWordingRetained',(select credit_messaging::text=${quote(JSON.stringify(last.input))} from public.outlets where id=${quote(s.outlet.id)}),
   'literalExportRetained',(select after_data::text=${quote(JSON.stringify(exported.input))} from public.events where id=${quote(exported.id)}),
   'literalOutletSourceRetained',(select position(${quote(JSON.stringify(s.outlet.name))} in before_data::text)>0 from public.events where id=${quote(first.id)}),
   'managerActorRetained',(select actor_id=${quote(managerId)} and command='export.prepare' from public.events where id=${quote(managed.id)}),
   'originalOccurrenceRetained',(select bool_and((receipt->>'occurredAt')::bigint=${at}) from private.shop_command_receipts where business_id=${quote(s.business.id)}),
   'noFinancialEffects',not exists(select 1 from public.sales where business_id=${quote(s.business.id)}) and not exists(select 1 from public.credit_entries where business_id=${quote(s.business.id)}),
   'pendingTickets',(select count(*) from private.settings_write_tickets where business_id=${quote(s.business.id)}));`,
  "if exists(select 1 from jsonb_each(proof) e where jsonb_typeof(e.value)='boolean' and e.value='false'::jsonb) or proof->>'receipts'<>'4' or proof->>'audits'<>'4' or proof->>'pendingTickets'<>'0' then raise exception 'Incomplete settings role proof';end if;",
  "raise sqlstate 'MZ006';exception when sqlstate 'MZ006' then null;end;perform set_config('mise.settings_command_verification',proof::text,true);end $mise_settings$;",
  `select current_setting('mise.settings_command_verification')::jsonb proof,(select count(*) from auth.users where id in (${quote(owner)},${quote(manager)})) auth_rows,(select count(*) from public.businesses where id=${quote(s.business.id)}) business_rows,(select count(*) from private.settings_write_tickets where business_id=${quote(s.business.id)}) ticket_rows;`
 ];
 const query=code.join('\n');if(/[\u0000\ud800-\udfff]/.test(query))throw new Error('Retain fixture literal data as escaped JSON.');return query;
}
