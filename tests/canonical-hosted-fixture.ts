import {reportBackupFixture} from './report-backup-fixture';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';

/** One rolled-back SQL-role proof; never a genuine hosted phone/JWT HTTP claim. */
export async function canonicalHostedProofSql(){
 const t=reportBackupFixture().tables,owner='00000000-0000-4000-8000-000000009901',manager='00000000-0000-4000-8000-000000009902',outside='00000000-0000-4000-8000-000000009903',b=t.businesses[0].id,o=t.outlets[0].id,a=t.members[0].id,m=newInboxId(),other=newInboxId(),branch=newInboxId(),review=newInboxId();t.members[0].outletIds=[];t.members[0].name='Original\0\ud800 member';
 const seed=(await prepareCloudMigration(createBackup(t),owner)).records;
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",insert=(r:CloudRecord)=>`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(v=>v===null?'null':q(v)).join(',')});`,auth=(id:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:id,user_metadata:{role:'owner'}}))},true);set local role authenticated;`;
 return [
 "do $mise_canonical$ declare proof jsonb:='{}';w jsonb;p jsonb;part jsonb;literal text;profile json;keys text[];found_owner boolean:=false;begin begin",
 `insert into auth.users(id,phone,phone_confirmed_at) values(${q(owner)},'14155550991',now()),(${q(manager)},'14155550992',now()),(${q(outside)},'14155550993',now());`,...seed.map(insert),
 insert(encodeCommandRecord('outlets',{...t.outlets[0],id:branch,name:'Unrelated outlet'},b)),
 `insert into public.members(id,business_id,auth_user_id,name,phone,role,created_at,updated_at) values(${q(m)},${q(b)},${q(manager)},'"Manager"','+14155550992','manager',1,1),(${q(other)},${q(b)},${q(outside)},'"Unrelated person"','+14155550993','staff',1,1);`,
 `insert into public.member_outlets values(${q(b)},${q(m)},${q(o)}),(${q(b)},${q(other)},${q(branch)});set constraints all immediate;`,
 `select convert_from(c.payload,'UTF8') into literal from private.sync_changes c where c.business_id=${q(b)} and c.outlet_id=${q(o)} and c.record_id=${q(a)} and c.table_name='member_refs' and c.operation='upsert' order by c.id desc limit 1;
 if literal is null then raise exception 'Owner historical capture missing';end if;
 select array_agg(k order by k) into keys from jsonb_array_elements_text(private.sync_columns('member_refs')) k;
 if keys is distinct from array['business_id','created_at','id','name','role','updated_at'] or position('"phone":' in literal)>0 or position('"active":' in literal)>0 or position('"auth_user_id":' in literal)>0 or position(chr(92)||'u0000' in literal)=0 or position(chr(92)||'ud800' in lower(literal))=0 then raise exception 'Historical projection lost literal data or exposed extra fields';end if;`,
 auth(manager),`w:=public.prepare_sync_read(${q(review)},${q(o)},null);p:=public.read_sync_page(${q(review)},${q(o)},0);if not (p->>'done')::boolean or jsonb_array_length(p->'parts')<>0 then raise exception 'Own uncommitted changes were presented as committed';end if;
 if exists(select 1 from public.members where id in(${q(a)},${q(other)})) then raise exception 'Direct member RLS broadened';end if;`,
 "proof:=proof||jsonb_build_object('historicalParentCaptured',true,'ownerContactProfileHidden',true,'referenceFieldsExact',true,'literalNullAndSurrogatePreserved',true,'unrelatedStaffHidden',true,'directMemberRlsUnchanged',true,'ownUncommittedChangesExcluded',true);",
 `begin perform private.sync_member_reference_outlets(${q(b)},${q(a)});raise exception 'Authenticated direct helper accepted';exception when insufficient_privilege then null;end;`,
 'reset role;set local role anon;',`begin perform public.prepare_sync_read(${q(newInboxId())},${q(o)},null);raise exception 'Anon sync accepted';exception when insufficient_privilege then null;end;`,
 'reset role;set local role service_role;',`begin perform private.sync_refresh_member_reference(${q(b)},${q(o)},${q(a)});raise exception 'Service direct helper accepted';exception when insufficient_privilege then null;end;`,
 'reset role;',`delete from public.member_outlets where member_id=${q(m)};`,auth(manager),
 `begin perform public.read_sync_page(${q(review)},${q(o)},0);raise exception 'Revoked manager cached page accepted';exception when insufficient_privilege then null;end;`,
 'reset role;',`proof:=proof||jsonb_build_object('authenticatedHelperDenied',true,'anonDenied',true,'serviceHelperDenied',true,'revocationBeforeCachedReply',true,'ownerAssignmentNotInvented',not exists(select 1 from public.member_outlets where member_id=${q(a)}),'privateHelpersNotGranted',not has_function_privilege('authenticated','private.sync_refresh_member_reference(public.ulid,public.ulid,public.ulid)','EXECUTE'),'pendingQueuePrivate',not has_table_privilege('authenticated','private.sync_member_pending','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('anon','private.sync_member_pending','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('service_role','private.sync_member_pending','SELECT,INSERT,UPDATE,DELETE'),'pendingQueueDrained',not exists(select 1 from private.sync_member_pending));
 raise exception using errcode='MZ021';exception when sqlstate 'MZ021' then perform set_config('mise.canonical_verification',proof::text,true);end;end $mise_canonical$;`,
 `select current_setting('mise.canonical_verification')::jsonb proof,(select count(*)::int from auth.users where id in(${[owner,manager,outside].map(q).join(',')})) auth_rows,(select count(*)::int from public.businesses where id=${q(b)}) business_rows;`
 ].join('\n');
}
