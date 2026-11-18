import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {captureInboxCommand,inboxImageBase64,newInboxId} from '../packages/core/inbox';
import {inboxPng} from './inbox-fixture';

/** Rolled-back SQL roles only: never evidence of a genuine phone/JWT or S3 request. */
export async function imageHostedProofSql(){
 const users=Array.from({length:4},(_,n)=>'00000000-0000-4000-8000-'+String(9801+n).padStart(12,'0')),[owner,manager,foreign,staff]=users;
 const setup=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Private image role proof',phone:'01712345482'}).snapshot,t=emptyBackupTables(),managerId=newInboxId(),staffId=newInboxId(),branch=newInboxId();
 t.businesses.push(setup.business);t.outlets.push(setup.outlet);t.members.push({...setup.owner,outletIds:[]});
 const capture=captureInboxCommand({title:'Original image',text:'',url:'',images:[{id:newInboxId(),name:'original.png',type:'image/png',size:inboxPng.length,data:inboxImageBase64(inboxPng)}]},setup);
 t.inboxItems.push(capture.item);if(capture.event)t.events.push(capture.event);
 const records=(await prepareCloudMigration(createBackup(t),owner)).records,image=capture.item.images[0].id,b=setup.business.id,o=setup.outlet.id;
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`;
 const auth=(user:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:user,user_metadata:{role:'owner'}}))},true);set local role authenticated;`;
 const context=`public.inbox_image_context(${q(image)})`,complete=`public.complete_inbox_image(${q(image)},${q(newInboxId())})`;
 const denied=(label:string)=>`begin perform ${context};raise exception 'Image context accepted';exception when insufficient_privilege then null;end;begin perform ${complete};raise exception 'Image completion accepted';exception when insufficient_privilege then null;end;proof:=proof||jsonb_build_object(${q(label)},true);`;
 return [
  "do $mise_image$ declare proof jsonb:='{}';meta jsonb;begin begin",
  `insert into auth.users(id,phone,phone_confirmed_at) values ${users.map((u,n)=>`(${q(u)},'1415555098${n+1}',now())`).join(',')};`,...records.map(insert),
  insert(encodeCommandRecord('outlets',{...setup.outlet,id:branch},b)),
  `insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values(${q(managerId)},${q(b)},${q(manager)},'"Assigned manager"','manager',1,1),(${q(staffId)},${q(b)},${q(staff)},'"Staff"','staff',1,1);`,
  `insert into public.member_outlets values(${q(b)},${q(managerId)},${q(o)}),(${q(b)},${q(staffId)},${q(o)});`,
  ...[owner,manager].flatMap((u,n)=>[auth(u),`meta:=${context};if meta->>'id'<>${q(image)} or (meta->>'size')::int<>${inboxPng.length} or meta->>'businessId'<>${q(b)} or meta->>'outletId'<>${q(o)} then raise exception 'Original image projection changed';end if;`,
   `begin perform ${complete};raise exception 'Missing Storage object accepted';exception when object_not_in_prerequisite_state then null;end;proof:=proof||jsonb_build_object(${q(n?'assignedManager':'owner')},true,${q(n?'managerMissingObjectDenied':'ownerMissingObjectDenied')},true);`]),
  auth(foreign),denied('foreignAccountDenied'),auth(staff),denied('staffDenied'),
  'reset role;',`delete from public.member_outlets where member_id=${q(managerId)};insert into public.member_outlets values(${q(b)},${q(managerId)},${q(branch)});`,auth(manager),denied('unassignedOutletDenied'),
  'reset role;',`update public.members set active=false where id=${q(setup.owner.id)};`,auth(owner),denied('revokedMemberDenied'),
  'reset role;',`update public.members set active=true where id=${q(setup.owner.id)};update auth.users set is_anonymous=true where id=${q(owner)};`,auth(owner),denied('anonymousConfirmedPhoneDenied'),
  'reset role;',`update auth.users set is_anonymous=false,phone_confirmed_at=null where id=${q(owner)};`,auth(owner),denied('unconfirmedPhoneDenied'),
  'reset role;',`update auth.users set phone_confirmed_at=now(),banned_until=now()+interval '1 day' where id=${q(owner)};`,auth(owner),denied('bannedAccountDenied'),
  'reset role;',`update auth.users set banned_until=null,deleted_at=now() where id=${q(owner)};`,auth(owner),denied('deletedAccountDenied'),
  "reset role;perform set_config('request.jwt.claims','{}',true);set local role anon;",denied('anonymousRoleDenied'),
  'reset role;set local role service_role;',denied('serviceRoleDenied'),
  'reset role;',`proof:=proof||jsonb_build_object('noUploadOrCompletion',not exists(select 1 from public.events where business_id=${q(b)} and command='inbox.image.upload') and not exists(select 1 from public.inbox_images where business_id=${q(b)} and uploaded_at is not null),'bucketStillPrivate',exists(select 1 from storage.buckets where id='mise-inbox' and not public));`,
  "raise exception using errcode='MZ010';exception when sqlstate 'MZ010' then perform set_config('mise.image_account_verification',proof::text,true);end;end $mise_image$;",
  `select current_setting('mise.image_account_verification')::jsonb proof,(select count(*)::int from auth.users where id in(${users.map(q).join(',')})) auth_rows,(select count(*)::int from public.businesses where id=${q(b)}) business_rows,(select count(*)::int from public.inbox_images where id=${q(image)}) image_rows;`
 ].join('\n');
}
