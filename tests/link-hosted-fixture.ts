import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {generateShopLinkCommand,reviewShopLink,type ShopLinkContext} from '../packages/core/shop-links';
import {parseLinkCommand,linkWritePlan,type LinkCommand} from '../packages/core/link-commands';
import {linkFingerprint} from '../supabase/functions/_shared/link-write';
import {newInboxId} from '../packages/core/inbox';
/** Synthetic SQL-role proof; no real JWT, OTP, external message or publication. */
export async function linkHostedProofSql(){
 const owner='00000000-0000-4000-8000-000000009601',manager='00000000-0000-4000-8000-000000009602',outside='00000000-0000-4000-8000-000000009603',managerId=newInboxId(),outsideId=newInboxId(),branchId=newInboxId(),at=Date.now()-3600000,base='https://shop.test/mise/app/',legacy='https://shop.test/legacy-shop',setup=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'লিংক দোকান',phone:'01712345482'},null,at-10000).snapshot;
 setup.outlet.shopLink=legacy;const tables=emptyBackupTables();tables.businesses.push(setup.business);tables.outlets.push(setup.outlet);tables.members.push(setup.owner);const seed=(await prepareCloudMigration(createBackup(tables),owner)).records;
 function generate(actorId:string,phone:string,time:number):LinkCommand{const context:ShopLinkContext={setup:{...setup,owner:{...setup.owner,id:actorId,phone}},items:[],categories:[]},input={phone:'+8801812345482',hours:'9 am–11 pm',deliveryNote:'গেটে ফোন করুন',mode:'list' as const,itemIds:[]},review=reviewShopLink(context,[]),change=generateShopLinkCommand(input,context,review,base,time);return parseLinkCommand({id:change.event.id,type:'shopLink.generate',outletId:setup.outlet.id,ownerId:actorId,occurredAt:time,review,url:change.outlet.shopLink});}
 const first=generate(setup.owner.id,setup.owner.phone,at),second=generate(setup.owner.id,setup.owner.phone,at+1),managed=generate(managerId,'+14155550962',at+3000),undo=(c:LinkCommand,time:number)=>parseLinkCommand({id:newInboxId(),type:'shopLink.undo',outletId:c.outletId,ownerId:c.ownerId,occurredAt:time,sourceId:c.id}),undoSecond=undo(second,at+1000),undoFirst=undo(first,at+2000),undoManaged=undo(managed,at+4000);
 if(first.type!=='shopLink.generate'||second.type!=='shopLink.generate'||managed.type!=='shopLink.generate')throw Error();
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`,auth=(id:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:id,user_metadata:{role:'owner'}}))},true);set local role authenticated;`,service="reset role;perform set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);set local role service_role;";
 const prepare=async(c:LinkCommand,plan=linkWritePlan(c))=>`public.prepare_shop_link_write(${q(c.id)},${q(newInboxId())},${q(c.type)},${q(c.outletId)},${q(c.ownerId)},${q(JSON.stringify(plan))}::jsonb,${q(await linkFingerprint(c))},${c.occurredAt})`,finish=(url:string|null)=>`public.finish_shop_link_write((p->>'ticketId')::public.ulid,p->>'token',${q(JSON.stringify({url}))})`;
 const bad=linkWritePlan(first);bad.url='https://shop.test/substituted';
 const otherUndo=parseLinkCommand({...undo(first,at+1000),ownerId:managerId}),code=[
  'do $mise_link$ declare p jsonb;r jsonb;original jsonb;proof jsonb;scope_denied boolean:=false;other_undo_denied boolean:=false;plan_bound boolean:=false;completion_bound boolean:=false;client_finish_denied boolean:=false;client_private_denied boolean:=false;service_private_denied boolean:=false;frozen_retained boolean:=false;physical_undo boolean:=false;owner_admit boolean:=false;manager_admit boolean:=false;begin begin',
  `insert into auth.users(id,phone,phone_confirmed_at) values(${q(owner)},'14155550961',now()),(${q(manager)},'14155550962',now()),(${q(outside)},'14155550963',now());`,...seed.map(insert),
  `insert into public.outlets(id,business_id,name,address,timezone,currency,created_at,updated_at) values(${q(branchId)},${q(setup.business.id)},'"Other outlet"','"Original branch"','UTC','USD',1,1);`,
  `insert into public.members(id,business_id,auth_user_id,name,phone,role,created_at,updated_at) values(${q(managerId)},${q(setup.business.id)},${q(manager)},'"Manager"','+14155550962','manager',1,1),(${q(outsideId)},${q(setup.business.id)},${q(outside)},'"Other manager"','+14155550963','manager',1,1);`,
  `insert into public.member_outlets values(${q(setup.business.id)},${q(managerId)},${q(setup.outlet.id)}),(${q(setup.business.id)},${q(outsideId)},${q(branchId)});`,
  auth(outside),`begin perform public.admit_shop_link_write(${q(setup.outlet.id)});raise exception 'Unassigned manager admitted';exception when insufficient_privilege then scope_denied:=true;end;`,
  auth(owner),`owner_admit:=public.admit_shop_link_write(${q(setup.outlet.id)});begin perform ${await prepare(first,bad)};raise exception 'Substituted plan accepted';exception when invalid_parameter_value then plan_bound:=true;end;`,
  `p:=${await prepare(first)};begin perform ${finish(first.url)};raise exception 'Client completion accepted';exception when insufficient_privilege then client_finish_denied:=true;end;begin perform 1 from private.shop_link_write_tickets;raise exception 'Client private read accepted';exception when insufficient_privilege then client_private_denied:=true;end;`,
  service,`begin perform ${finish('https://shop.test/substituted')};raise exception 'Substituted URL accepted';exception when invalid_parameter_value then completion_bound:=true;end;begin perform 1 from private.shop_link_write_tickets;raise exception 'Service private read accepted';exception when insufficient_privilege then service_private_denied:=true;end;original:=${finish(first.url)};`,
  'reset role;',`update public.outlets set name='"Profile changed after approval"' where id=${q(setup.outlet.id)};`,
  auth(owner),`p:=${await prepare(second)};`,service,`r:=${finish(second.url)};reset role;frozen_retained:=exists(select 1 from public.outlets where id=${q(setup.outlet.id)} and shop_link=${q(second.url)} and name::text='"Profile changed after approval"');`,
  auth(owner),`p:=${await prepare(undoSecond)};`,service,`r:=${finish(first.url)};physical_undo:=((r->>'at')::bigint-(r->>'occurredAt')::bigint)>600000;`,
  auth(owner),`p:=${await prepare(undoFirst)};`,service,`r:=${finish(legacy)};`,
  auth(manager),`manager_admit:=public.admit_shop_link_write(${q(setup.outlet.id)});begin perform ${await prepare(otherUndo)};raise exception 'Another actor undo accepted';exception when insufficient_privilege then other_undo_denied:=true;end;p:=${await prepare(managed)};`,service,`r:=${finish(managed.url)};`,
  auth(manager),`p:=${await prepare(undoManaged)};`,service,`r:=${finish(legacy)};`,
  auth(owner),`p:=${await prepare(first)};if not (p->>'done')::boolean or p->'receipt' is distinct from original then raise exception 'Historical receipt changed';end if;`,
  'reset role;',
  `proof:=jsonb_build_object('commands',6,'audits',(select count(*) from public.events where business_id=${q(setup.business.id)}),'receipts',(select count(*) from private.shop_command_receipts where business_id=${q(setup.business.id)}),'pendingTickets',(select count(*) from private.shop_link_write_tickets where business_id=${q(setup.business.id)}),`+
   `'ownerAdmitted',owner_admit,'managerAdmitted',manager_admit,'unassignedOutletDenied',scope_denied,'otherActorUndoDenied',other_undo_denied,'normalizedPlanBound',plan_bound,'normalizedCompletionBound',completion_bound,'clientCompletionDenied',client_finish_denied,'privateReadsDenied',client_private_denied and service_private_denied,'frozenPublicationRetained',frozen_retained,'physicalUndoAfterDelayedAdmission',physical_undo,`+
   `'canonicalReplacedUrlAudited',exists(select 1 from public.events where id=${q(second.id)} and (before_data->'url')#>>'{}'=${q(first.url)}),`+
   `'legacyUrlRestored',exists(select 1 from public.outlets where id=${q(setup.outlet.id)} and shop_link=${q(legacy)}),`+
   `'managerActorRetained',r->>'ownerId'=${q(managerId)},'originalOccurrenceRetained',r->>'occurredAt'=${q(undoManaged.occurredAt)},`+
   `'otherOutletRetained',exists(select 1 from public.outlets where id=${q(branchId)} and address::text='"Original branch"' and updated_at=1),`+
   `'noFinancialSideEffects',(select count(*)=0 from public.sales where business_id=${q(setup.business.id)}) and (select count(*)=0 from public.credit_entries where business_id=${q(setup.business.id)}));`,
  "raise exception using errcode='MZ008';exception when sqlstate 'MZ008' then perform set_config('mise.shop_link_command_verification',proof::text,true);end;end $mise_link$;",
  `select current_setting('mise.shop_link_command_verification')::jsonb proof,(select count(*)::int from auth.users where id in(${q(owner)},${q(manager)},${q(outside)})) auth_rows,(select count(*)::int from public.businesses where id=${q(setup.business.id)}) business_rows,(select count(*)::int from private.shop_link_write_tickets where business_id=${q(setup.business.id)}) ticket_rows;`
 ];return code.join('\n');
}
