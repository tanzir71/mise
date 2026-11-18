import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {shopCommandFingerprint} from '../packages/core/sync-coverage';
import type {CloudCommand} from '../packages/core/cloud-commands';

/** Exact rolled-back SQL roles. Local committed-transaction/HTTP tests remain separate evidence. */
export async function coverageHostedProofSql(){
 const users=Array.from({length:4},(_,n)=>'00000000-0000-4000-8000-'+String(9901+n).padStart(12,'0')),[owner,manager,staff,outside]=users;
 const setup=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Receipt coverage proof',phone:'01712345482'}),t=emptyBackupTables(),managerId=newInboxId(),staffId=newInboxId();t.businesses.push(setup.snapshot.business);t.outlets.push(setup.snapshot.outlet);t.members.push({...setup.snapshot.owner,outletIds:[]});t.items.push(...setup.items);t.categories.push(...setup.categories);
 const records=(await prepareCloudMigration(createBackup(t),owner)).records,b=setup.snapshot.business.id,o=setup.snapshot.outlet.id,command:CloudCommand={id:newInboxId(),outletId:o,occurredAt:Date.now()-1000,type:'catalogue.availability',itemId:setup.items[0].id,available:false},fingerprint=await shopCommandFingerprint(command),win=newInboxId(),managerWin=newInboxId(),absent=newInboxId();
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`;
 const auth=(user:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:user,user_metadata:{role:'owner'}}))},true);set local role authenticated;`;
 const action=`public.apply_catalogue_intent(${q(command.id)},'catalogue.availability',${q(command.itemId)},${q(o)},false,null,${command.occurredAt})`,ids=q(JSON.stringify([command.id])),read=`public.read_sync_coverage(${q(win)},${q(o)},${ids}::jsonb)`;
 const deny=(label:string,call=read)=>`begin perform ${call};raise exception 'Unauthorized coverage accepted';exception when insufficient_privilege then null;end;proof:=proof||jsonb_build_object(${q(label)},true);`;
 return [
  "do $mise_coverage$ declare proof jsonb:='{}';w jsonb;p jsonb;original jsonb;receipt jsonb;page_index int:=0;before_events int;begin begin",
  `insert into auth.users(id,phone,phone_confirmed_at) values ${users.map((u,n)=>`(${q(u)},'1415555099${n+1}',now())`).join(',')};`,...records.map(insert),
  `insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values(${q(managerId)},${q(b)},${q(manager)},'"Manager"','manager',1,1),(${q(staffId)},${q(b)},${q(staff)},'"Staff"','staff',1,1);insert into public.member_outlets values(${q(b)},${q(managerId)},${q(o)}),(${q(b)},${q(staffId)},${q(o)});`,auth(owner),
  `receipt:=${action};w:=public.prepare_sync_read(${q(win)},${q(o)},null);`,
  `begin perform ${read};raise exception 'Incomplete download accepted';exception when invalid_parameter_value then null;end;proof:=proof||jsonb_build_object('completePagesRequired',true);`,
  `loop p:=public.read_sync_page(${q(win)},${q(o)},page_index);exit when (p->>'done')::boolean;page_index:=page_index+1;if page_index>100 then raise exception 'Unbounded proof';end if;end loop;`,
  `p:=${read};if p->'coverage'->0->>'state'<>'later' or p->'coverage'->0->>'requestHash'<>${q(fingerprint)} or p->>'id'<>${q(win)} or p->>'actorId'<>${q(setup.snapshot.owner.id)} then raise exception 'Original transaction coverage changed';end if;proof:=proof||jsonb_build_object('fixedSnapshotBound',true,'originalIntentHash',true,'ownPendingTransactionNotVisible',true);`,
  `original:=public.read_sync_coverage(${q(win)},${q(o)},${q(JSON.stringify([absent]))}::jsonb);if original->'coverage'->0->>'state'<>'absent' then raise exception 'Missing receipt invented';end if;if public.read_sync_coverage(${q(win)},${q(o)},${q(JSON.stringify([absent]))}::jsonb)<>original then raise exception 'Cached reply changed';end if;proof:=proof||jsonb_build_object('cachedAbsenceExact',true);`,
  `if ${action}<>receipt then raise exception 'Original replay changed';end if;proof:=proof||jsonb_build_object('exactCommandReplay',true);`,
  'reset role;',`if (select r.admission_xid from private.command_receipts r where r.id=${q(command.id)})<>pg_current_xact_id() then raise exception 'Admission transaction missing';end if;proof:=proof||jsonb_build_object('actualParentXidCaptured',true);`,
  `begin update private.command_receipts set admission_xid='1'::xid8 where id=${q(command.id)};raise exception 'Receipt identity replaced';exception when insufficient_privilege then null;end;proof:=proof||jsonb_build_object('admissionCannotBeRestamped',true);select count(*) into before_events from public.events where business_id=${q(b)};`,auth(manager),deny('differentAccountDenied'),
  `w:=public.prepare_sync_read(${q(managerWin)},${q(o)},null);page_index:=0;loop p:=public.read_sync_page(${q(managerWin)},${q(o)},page_index);exit when (p->>'done')::boolean;page_index:=page_index+1;end loop;p:=public.read_sync_coverage(${q(managerWin)},${q(o)},${ids}::jsonb);if p->'coverage'->0->>'state'<>'absent' then raise exception 'Another actor receipt leaked';end if;proof:=proof||jsonb_build_object('managerOwnWindow',true,'otherActorReceiptHidden',true);`,
  "begin perform 1 from private.sync_read_coverage;raise exception 'Private cache readable';exception when insufficient_privilege then null;end;proof:=proof||jsonb_build_object('authenticatedCacheDenied',true);",
  auth(staff),deny('staffDenied'),auth(outside),deny('foreignAccountDenied'),
  'reset role;',`delete from public.member_outlets where member_id=${q(managerId)};`,auth(manager),deny('assignmentRevocationRechecked',`public.read_sync_coverage(${q(managerWin)},${q(o)},${ids}::jsonb)`),
  'reset role;',`update auth.users set is_anonymous=true where id=${q(owner)};`,auth(owner),deny('anonymousPhoneDenied'),
  'reset role;',`update auth.users set is_anonymous=false,phone_confirmed_at=null where id=${q(owner)};`,auth(owner),deny('unconfirmedPhoneDenied'),
  'reset role;',`update auth.users set phone_confirmed_at=now(),banned_until=now()+interval '1 day' where id=${q(owner)};`,auth(owner),deny('bannedAccountDenied'),
  'reset role;',`update auth.users set banned_until=null,deleted_at=now() where id=${q(owner)};`,auth(owner),deny('deletedAccountDenied'),
  "reset role;perform set_config('request.jwt.claims','{}',true);set local role anon;",deny('anonymousRoleDenied'),
  'reset role;set local role service_role;',deny('serviceRoleDenied'),
  'reset role;',`update auth.users set deleted_at=null where id=${q(owner)};update private.sync_read_windows set expires_at=0 where id=${q(win)};`,auth(owner),
  `begin perform ${read};raise exception 'Expired coverage accepted';exception when sqlstate 'PT409' then null;end;proof:=proof||jsonb_build_object('cachedExpiryRechecked',true);`,
  'reset role;',`proof:=proof||jsonb_build_object('coverageDoesNotWriteDomain',before_events=(select count(*) from public.events where business_id=${q(b)}),'projectionExcludesAuthIdentity',position(${q(owner)} in original::text)=0 and position('auth_user_id' in original::text)=0,'privateCacheForcedRls',exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='sync_read_coverage' and c.relrowsecurity and c.relforcerowsecurity));`,
  "raise exception using errcode='MZ011';exception when sqlstate 'MZ011' then perform set_config('mise.coverage_verification',proof::text,true);end;end $mise_coverage$;",
  `select current_setting('mise.coverage_verification')::jsonb proof,(select count(*)::int from auth.users where id in(${users.map(q).join(',')})) auth_rows,(select count(*)::int from public.businesses where id=${q(b)}) business_rows,(select count(*)::int from private.sync_read_coverage where window_id in(${q(win)},${q(managerWin)})) coverage_rows;`
 ].join('\n');
}
