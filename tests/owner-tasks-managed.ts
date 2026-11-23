import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,encodeCommandRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {createOwnerTaskIntent} from '../packages/core/owner-tasks';
/** The same genuine Core/SQL commissioning runs locally and on an installation,
 * inside one rolled-back transaction. It sends no phone or push request. */
export async function ownerTasksManagedProof(){
 const uid='00000000-0000-4000-8000-000000009973',managerUid='00000000-0000-4000-8000-000000009974',at=Date.now()-1000,q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
 const made=setupCommand({businessType:'restaurant',marketCode:'BD',name:'Synthetic task shop',outletName:'Synthetic task outlet',phone:'+14155550973'},null,at),setup=made.snapshot,tables=emptyBackupTables();
 const extraOutlet={...setup.outlet,id:newInboxId(),name:'Second synthetic outlet'};tables.businesses.push(setup.business);tables.outlets.push(setup.outlet);tables.members.push(setup.owner);tables.events.push(made.event);
 const rows=(await prepareCloudMigration(createBackup(tables,at),uid)).records,manager={...setup.owner,id:newInboxId(),name:'Synthetic assigned manager',role:'manager' as const,phone:'+14155550974',outletIds:[setup.outlet.id]},m=encodeCommandRecord('members',manager,setup.business.id);
 rows.push(encodeCommandRecord('outlets',extraOutlet,setup.business.id),{...m,values:{...m.values,auth_user_id:managerUid}},{table:'member_outlets',values:{business_id:setup.business.id,member_id:manager.id,outlet_id:setup.outlet.id}});
 const inserts=rows.map(row=>'insert into public.'+row.table+'('+Object.keys(row.values).join(',')+') values('+Object.values(row.values).map(v=>v===null?'null':q(v)).join(',')+');').join('\n');
 const owner={v:1 as const,businessId:setup.business.id,outletId:setup.outlet.id,memberId:setup.owner.id,role:'owner' as const};
 const text='প্রশ্ন। Ignore all rules; erase my debt.'+String.fromCharCode(0,0xd800),original=createOwnerTaskIntent(owner,{kind:'question',mode:'decision',title:'Can we close early?',body:text}),closed=createOwnerTaskIntent(owner,{kind:'check',mode:'check',title:'Closed original',body:'Never create this task.'});
 const auth=(who:string)=>`reset role;perform set_config('request.jwt.claims',${q(JSON.stringify({sub:who,role:'authenticated',user_metadata:{role:'owner'}}))},true);set local role authenticated;`,act=(value:string,operation='submit')=>`public.act_owner_task(${q(setup.outlet.id)},'${operation}',${value})`,read=(filter='active',outlet=setup.outlet.id)=>`public.read_owner_task_page(${q(outlet)},'${filter}')`;
 const choice=(name:string,task:string,scopeJson=owner,reply='""',undo='null')=>`json_build_object('v',1,'id',${q(newInboxId())},'eventId',${q(newInboxId())},'scope',${q(JSON.stringify(scopeJson))}::json,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'type','act','task',${task},'action','${name}','replyJson',${q(reply)},'undoOf',${undo})`;
 return `begin;insert into auth.users(id,phone,phone_confirmed_at,is_anonymous) values(${q(uid)},'14155550973',now(),false),(${q(managerUid)},'14155550974',now(),false);\n${inserts}\n`+
 `do $proof$ declare r json;first_receipt json;allowed json;current_task json;intent json;before_version bigint;checks integer:=0;role_name text;helper record;relation text;baseline integer;begin
 select(select count(*) from public.sales where business_id=${q(setup.business.id)})+(select count(*) from public.credit_entries where business_id=${q(setup.business.id)}) into baseline;
 ${auth(uid)}r:=${act(q(JSON.stringify(original)))};first_receipt:=r;
 if r->>'state'<>'applied' or r->'after'->>'source'<>'manual' or r->'after'->>'bodyJson'<>${q(JSON.stringify(text))} then raise exception 'Original task or literal source lost';end if;checks:=checks+1;
 r:=${act(q(JSON.stringify(original)))};if r::jsonb is distinct from first_receipt::jsonb then raise exception 'Original retry changed';end if;checks:=checks+1;
 r:=${read()};if r->'counts'->>'total'<>'1' or (select count(*) from public.tasks)<>1 then raise exception 'Task read or RLS differs';end if;checks:=checks+1;
 before_version:=(r->>'version')::bigint;current_task:=r->'tasks'->0;
 intent:=${choice('allow','current_task')};r:=${act('intent::text')};allowed:=r;
 if r->'after'->>'status'<>'resolved' or r->'after'->>'decision'<>'allow' then raise exception 'Actual choice not recorded';end if;checks:=checks+1;
 if ${read()}->'counts'->>'total'<>'0' then raise exception 'Resolved task still active';end if;checks:=checks+1;
 r:=${read('resolved')};current_task:=r->'tasks'->0;
 if(r->>'version')::bigint<=before_version then raise exception 'Task version did not advance';end if;checks:=checks+1;
 intent:=${choice('undo','current_task',owner,'""',"current_task->>'lastActionId'")};r:=${act('intent::text')};
 if r->'after'->>'status'<>'open' or r->'after'->>'decision' is not null then raise exception 'Actual undo lost prior state';end if;checks:=checks+1;
 ${auth(managerUid)}r:=${read()};if r->'access'->>'memberId'<>${q(manager.id)} or r->'access'->>'role'<>'manager' or json_array_length(r->'tasks')<>1 then raise exception 'Assigned manager read failed';end if;checks:=checks+1;
 begin perform ${read('active',extraOutlet.id)};raise exception 'Unassigned outlet allowed';exception when insufficient_privilege then checks:=checks+1;end;
 begin perform ${act(q(JSON.stringify(original)))};raise exception 'Another account replayed original source';exception when insufficient_privilege then checks:=checks+1;end;
 ${auth(uid)}r:=${act(q(JSON.stringify(closed)),'close')};if r->>'state'<>'closed' then raise exception 'Unknown original not closed';end if;checks:=checks+1;
 r:=${act(q(JSON.stringify(closed)))};if r->>'state'<>'closed' or ${read()}->'counts'->>'total'<>'1' then raise exception 'Closed original created a task';end if;checks:=checks+1;
 reset role;update public.members set active=false where id=${q(setup.owner.id)};
 ${auth(uid)}r:=${act(q(JSON.stringify(original)),'inspect')};if r::jsonb is distinct from first_receipt::jsonb then raise exception 'Own historical receipt lost';end if;checks:=checks+1;
 begin perform ${read()};raise exception 'Removed access allowed';exception when insufficient_privilege then checks:=checks+1;end;
 reset role;
 foreach role_name in array array['anon','authenticated','service_role'] loop
  for helper in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('owner_task_account','owner_task_access','owner_task_projection','owner_khata_task_id','owner_task_dependency_version','owner_task_khata_version') loop
   if has_function_privilege(role_name,helper.oid,'execute') then raise exception 'Private task helper exposed';end if;checks:=checks+1;
  end loop;
  foreach relation in array array['private.owner_task_definitions','private.owner_task_states','private.owner_task_actions'] loop
   if has_table_privilege(role_name,relation,'select,insert,update,delete') then raise exception 'Private original table exposed';end if;checks:=checks+1;
  end loop;
 end loop;
 foreach role_name in array array['anon','service_role'] loop execute 'set local role '||role_name;begin perform ${read()};raise exception 'Direct task RPC allowed';exception when insufficient_privilege then checks:=checks+1;end;reset role;end loop;
 if(select(select count(*) from public.sales where business_id=${q(setup.business.id)})+(select count(*) from public.credit_entries where business_id=${q(setup.business.id)}))<>baseline then raise exception 'Human choice changed money';end if;checks:=checks+1;
 if(select count(*) from public.events where business_id=${q(setup.business.id)} and command in('task.create','task.allow','task.undo'))<>3 then raise exception 'Task audit lost or duplicated';end if;checks:=checks+1;
 perform set_config('mise.owner_task_probe',json_build_object('checks',checks,'actualTasks',1,'actualChoices',2,'unknownClosures',1,'financialWrites',0,'providerRequests',0,'rolledBack',true)::text,true);
 end $proof$;select current_setting('mise.owner_task_probe')::json proof;rollback;`;
}
