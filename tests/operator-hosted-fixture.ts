import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';

/** Exact rolled-back SQL-role proof. It cannot stand in for genuine phone/JWT HTTP acceptance. */
export async function operatorHostedProofSql(){
 const owner='00000000-0000-4000-8000-000000009701',manager='00000000-0000-4000-8000-000000009702',outside='00000000-0000-4000-8000-000000009703',staff='00000000-0000-4000-8000-000000009704';
 const setup=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Operator role proof',phone:'01712345482'}),t=emptyBackupTables(),branch=newInboxId(),managerId=newInboxId(),staffId=newInboxId();
 t.businesses.push(setup.snapshot.business);t.outlets.push(setup.snapshot.outlet);t.members.push({...setup.snapshot.owner,outletIds:[]});
 const seed=(await prepareCloudMigration(createBackup(t),owner)).records;
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`;
 const auth=(id:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:id,user_metadata:{role:'owner'}}))},true);set local role authenticated;`;
 const b=setup.snapshot.business.id,o=setup.snapshot.outlet.id,a=setup.snapshot.owner.id,selection=(actor:string,outlet=o)=>`public.operator_context(${q(b)},${q(outlet)},${q(actor)})`;
 return [
 'do $mise_operator$ declare proof jsonb:=\'{}\';page json;selected json;begin begin',
 `insert into auth.users(id,phone,phone_confirmed_at) values(${q(owner)},'14155550971',now()),(${q(manager)},'14155550972',now()),(${q(outside)},'14155550973',now()),(${q(staff)},'14155550974',now());`,
 ...seed.map(insert),insert(encodeCommandRecord('outlets',{...setup.snapshot.outlet,id:branch,name:'Second outlet'},b)),
 `insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values(${q(managerId)},${q(b)},${q(manager)},'"Manager"','manager',1,1),(${q(staffId)},${q(b)},${q(staff)},'"Staff"','staff',1,1);`,
 `insert into public.member_outlets values(${q(b)},${q(managerId)},${q(o)}),(${q(b)},${q(staffId)},${q(o)});`,
 auth(owner),'page:=public.operator_contexts(null,50);',
 `if json_array_length(page->'contexts')<>2 or page->>'accountHash'<>encode(sha256(uuid_send(${q(owner)}::uuid)),'hex') then raise exception 'Owner discovery failed';end if;`,
 "proof:=proof||jsonb_build_object('ownerImplicitOutlets',true,'uuidByteFingerprint',true);",
 `selected:=${selection(a,branch)};if selected->>'actorId'<>${q(a)} or selected->>'role'<>'owner' then raise exception 'Owner branch selection failed';end if;`,
 auth(manager),'page:=public.operator_contexts(null,50);',
 `if json_array_length(page->'contexts')<>1 or page->'contexts'->0->>'outletId'<>${q(o)} then raise exception 'Manager discovery escaped scope';end if;selected:=${selection(managerId)};`,
 `if selected->>'actorId'<>${q(managerId)} or selected->>'role'<>'manager' or selected->>'accountHash'<>encode(sha256(uuid_send(${q(manager)}::uuid)),'hex') then raise exception 'Manager identity changed';end if;`,
 `begin perform ${selection(managerId,branch)};raise exception 'Manager foreign branch accepted';exception when insufficient_privilege then null;end;`,
 `begin perform ${selection(a)};raise exception 'Wrong actor accepted';exception when insufficient_privilege then null;end;`,
 "proof:=proof||jsonb_build_object('managerScope',true,'actualManagerIdentity',true,'foreignOutletDenied',true,'wrongActorDenied',true);",
 auth(outside),"page:=public.operator_contexts(null,50);if json_array_length(page->'contexts')<>0 then raise exception 'Foreign account received choices';end if;",
 auth(staff),"page:=public.operator_contexts(null,50);if json_array_length(page->'contexts')<>0 then raise exception 'Staff promoted to owner';end if;",
 `begin perform ${selection(staffId)};raise exception 'Staff selected owner workspace';exception when insufficient_privilege then null;end;`,
 'reset role;',`delete from public.member_outlets where member_id=${q(managerId)};`,auth(manager),
 `begin perform ${selection(managerId)};raise exception 'Revoked manager accepted';exception when insufficient_privilege then null;end;`,
 'reset role;',`update auth.users set is_anonymous=true where id=${q(owner)};`,auth(owner),
 "begin perform public.operator_contexts(null,50);raise exception 'Anonymous phone account accepted';exception when insufficient_privilege then null;end;",
 'reset role;',`update auth.users set is_anonymous=false,phone_confirmed_at=null where id=${q(owner)};`,auth(owner),
 "begin perform public.operator_contexts(null,50);raise exception 'Unconfirmed phone accepted';exception when insufficient_privilege then null;end;",
 'reset role;set local role anon;',"begin perform public.operator_contexts(null,50);raise exception 'Anon discovery accepted';exception when insufficient_privilege then null;end;",
 'reset role;set local role service_role;',"begin perform public.operator_contexts(null,50);raise exception 'Service role discovery accepted';exception when insufficient_privilege then null;end;",
 'reset role;',`proof:=proof||jsonb_build_object('foreignAccountEmpty',true,'staffNotPromoted',true,'revocationRechecked',true,'anonymousPhoneDenied',true,'unconfirmedPhoneDenied',true,'anonDenied',true,'serviceDenied',true,'ownerAssignmentsUnchanged',not exists(select 1 from public.member_outlets where member_id=${q(a)}),'noAuthIdentityInProjection',position(${q(owner)} in page::text)=0 and position('auth_user_id' in page::text)=0);`,
 "raise exception using errcode='MZ009';exception when sqlstate 'MZ009' then perform set_config('mise.operator_context_verification',proof::text,true);end;end $mise_operator$;",
 `select current_setting('mise.operator_context_verification')::jsonb proof,(select count(*)::int from auth.users where id in(${[owner,manager,outside,staff].map(q).join(',')})) auth_rows,(select count(*)::int from public.businesses where id=${q(b)}) business_rows;`
 ].join('\n');
}
