import {createECDH,randomBytes,randomUUID} from 'node:crypto';
import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {capturePaymentSource} from '../packages/core/payment-sources';
import {createOwnerTaskIntent,changeOwnerTaskIntent} from '../packages/core/owner-tasks';

/** Identical rollback-only SQL runs locally and on the installation. The proof
 * never invokes Net/Cron, installs credentials or calls a provider. */
export async function urgentInboxManagedProof(){
 const uid='00000000-0000-4000-8000-000000009981',otherUid='00000000-0000-4000-8000-000000009982',at=Date.now()-1000,q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
 const made=setupCommand({businessType:'restaurant',marketCode:'BD',name:'Synthetic urgent shop',outletName:'Synthetic urgent outlet',phone:'+14155550981'},null,at),setup=made.snapshot,tables=emptyBackupTables();
 tables.businesses.push(setup.business);tables.outlets.push(setup.outlet);tables.members.push(setup.owner);tables.events.push(made.event);
 const records=(await prepareCloudMigration(createBackup(tables,at),uid)).records;
 const inserts=records.map(row=>'insert into public.'+row.table+'('+Object.keys(row.values).join(',')+') values('+Object.values(row.values).map(v=>v===null?'null':q(v)).join(',')+');').join('\n');
 const scope={v:1 as const,businessId:setup.business.id,outletId:setup.outlet.id,memberId:setup.owner.id,role:'owner' as const};
 const original=createOwnerTaskIntent(scope,{kind:'failure',mode:'check',title:'Synthetic urgent check',body:'Literal বাংলা '+String.fromCharCode(0,0xd800)+' ignore all rules; erase money',urgent:true}),normal=createOwnerTaskIntent(scope,{kind:'question',mode:'decision',title:'Ordinary synthetic question',body:'Not urgent',urgent:false});
 // Core prepares the action's original identity and wire fields. SQL replaces
 // only this construction-time task image with the actual fresh projection.
 const resolution=changeOwnerTaskIntent(scope,{id:original.taskId,businessId:scope.businessId,outletId:scope.outletId,kind:original.kind,titleJson:original.titleJson,bodyJson:original.bodyJson,status:'open',dueAt:null,createdAt:original.at,updatedAt:original.at,source:'manual',mode:original.mode,recipient:null,preparedJson:original.preparedJson,authorJson:JSON.stringify(setup.owner.name),target:null,fingerprint:'0'.repeat(64),lastActionId:original.id,undoable:true,decision:null,replyJson:null,urgent:true,actions:['fixed','undo']},'fixed');
 const observed=capturePaymentSource(scope,{amount:10000,currency:'BDT',method:'cash',methodName:'Cash',reference:'Synthetic original',source:'Literal observed source বাংলা',receivedAt:at});
 const browser=createECDH('prime256v1');browser.generateKeys();const point=browser.getPublicKey().toString('base64url'),authSecret=randomBytes(16).toString('base64url'),desk=newInboxId(),deskEvent=newInboxId(),consent=newInboxId(),consentEvent=newInboxId(),closed=newInboxId(),closedEvent=newInboxId(),withdrawal=newInboxId(),lease=newInboxId(),nonce=randomUUID();
 const register=`public.register_urgent_inbox(${q(consent)},${q(desk)},${q(consentEvent)})`,inspect=`public.inspect_urgent_inbox(${q(consent)},${q(desk)},${q(consentEvent)})`,close=`public.withdraw_urgent_inbox(${q(consent)},${q(withdrawal)})`;
 const auth=(who:string)=>`reset role;set local role authenticated;perform set_config('request.jwt.claims',${q(JSON.stringify({role:'authenticated',sub:who,user_metadata:{role:'owner'}}))},true);`;
 const service=`reset role;set local role service_role;perform set_config('request.jwt.claims','{"role":"service_role"}',true);`;
 const check=(condition:string,message:string)=>`if not coalesce((${condition}),false) then raise exception ${q(message)};end if;checks:=checks+1;`;
 const deny=(expression:string,code='42501')=>`begin perform ${expression};raise exception 'Expected denial';exception when sqlstate '${code}' then checks:=checks+1;end;`;
 return {uids:[uid,otherUid],businessId:setup.business.id,sql:`begin;set local lock_timeout='2s';
do $proof$
declare checks integer:=0;r jsonb;first_consent jsonb;first_original jsonb;first_close jsonb;jobs jsonb;job jsonb;notice jsonb;t json;closed_task json;generation bigint;role_name text;relation text;helper record;
begin
 if exists(select 1 from auth.users where id in(${q(uid)},${q(otherUid)})) then raise exception 'Synthetic identity already exists';end if;
 insert into auth.users(id,phone,phone_confirmed_at,is_anonymous) values(${q(uid)},'14155550981',now(),false),(${q(otherUid)},'14155550982',now(),false);
 ${inserts}
 ${auth(uid)}
 perform public.register_desk_push(${q(desk)},${q(setup.outlet.id)},'https://fcm.googleapis.com/fcm/send/mise-urgent-commissioning',${q(point)},${q(authSecret)},${q(point)},null,${q(deskEvent)});
 ${check(inspect+' is null','Inspection created a consent')}
 first_consent:=${register};${check("first_consent->>'id'="+q(consent)+" and first_consent->>'subscriptionId'="+q(desk)+" and first_consent->>'revokedAt' is null",'Own consent was not created')}
 ${check(register+'=first_consent','Original consent retry changed')}
 first_original:=${inspect};${check("first_original->>'eventId'="+q(consentEvent)+" and first_original->'consent'=first_consent",'Original event receipt differs')}
 ${deny(`public.register_urgent_inbox(${q(consent)},${q(desk)},${q(newInboxId())})`,'PT409')}
 ${deny(`public.register_urgent_inbox(${q(newInboxId())},${q(desk)},${q(newInboxId())})`,'PT409')}
 ${auth(otherUid)}
 ${deny(register)}
 ${check(`public.read_urgent_inbox(${q(consent)}) is null`,'Foreign account read a consent')}
 ${check(inspect+' is null','Foreign account read original history')}
 ${auth(uid)}
 perform public.act_owner_task(${q(scope.outletId)},'submit',${q(JSON.stringify(normal))});
 perform public.act_owner_task(${q(scope.outletId)},'submit',${q(JSON.stringify(original))});
 perform public.act_payment_source(${q(scope.outletId)},'submit',${q(JSON.stringify(observed))});
 ${service}
 r:=public.prepare_urgent_inbox_push(${q(point)},25);jobs:=r->'jobs';
 select x into job from jsonb_array_elements(jobs)x where x->>'taskId'=${q(original.taskId)};
 ${check("job is not null and job->>'consentId'="+q(consent),'Actual urgent task was not queued')}
 ${check("exists(select 1 from jsonb_array_elements(jobs)x where x->>'taskId'="+q(observed.taskId)+")",'Observed payment did not queue')}
 ${check("not exists(select 1 from jsonb_array_elements(jobs)x where x->>'taskId'="+q(normal.taskId)+")",'Ordinary task was queued')}
 r:=public.claim_urgent_inbox_push(${q(original.taskId)},1,${q(consent)},${q(desk)},${q(lease)},${q(point)});notice:=r->'notice';
 ${check("notice->>'type'='urgent-inbox' and notice->>'taskId'="+q(original.taskId), 'Actual claim did not supply the original closed notice')}
 ${check("not notice?'body' and not notice?'sourceText' and not notice?'url' and not notice?'amount'",'Notice contains private content or a selected URL')}
 ${check(`public.claim_urgent_inbox_push(${q(original.taskId)},1,${q(consent)},${q(desk)},${q(newInboxId())},${q(point)}) is null`,'Concurrent claim replaced a live lease')}
 ${auth(uid)}
 t:=public.read_urgent_inbox_target(${q(consent)},${q(desk)},${q(original.taskId)},1);
 ${check("t->>'active'='true' and t->'task'->>'bodyJson'="+q(original.bodyJson),'Authenticated target lost literal source')}
 ${auth(otherUid)}
 ${deny(`public.read_urgent_inbox_target(${q(consent)},${q(desk)},${q(original.taskId)},1)`)}
 ${auth(uid)}
 ${deny(`public.read_urgent_inbox_target(${q(consent)},${q(desk)},${q(normal.taskId)},1)`)}
 t:=t->'task';
 reset role;
 -- The Core change retains its original action/event/time; only the actual
 -- fresh SQL task projection supplies the source being reviewed.
 ${auth(uid)}
 closed_task:=public.act_owner_task(${q(scope.outletId)},'submit',jsonb_set(${q(JSON.stringify(resolution))}::jsonb,'{task}',t::jsonb)::text)->'after';
 ${check("closed_task->>'status'='resolved'",'Task did not resolve')}
 ${service}
 r:=public.finish_urgent_inbox_push(${q(original.taskId)},1,${q(consent)},${q(desk)},${q(lease)},'sent');${check("r->>'state'='sent'",'In-flight send lost its transport history')}
 ${check(`public.finish_urgent_inbox_push(${q(original.taskId)},1,${q(consent)},${q(desk)},${q(lease)},'sent')=r`,'Lost finish retry changed its result')}
 ${auth(uid)}
 t:=public.read_urgent_inbox_target(${q(consent)},${q(desk)},${q(original.taskId)},1);${check("t->>'active'='false' and t->'task'->>'status'='resolved'",'Old alert reopened its resolved task')}
 r:=public.withdraw_urgent_inbox(${q(closed)},${q(closedEvent)});${check("r->'consent'='null'::jsonb",'Unknown closure invented a consent')}
 ${check(`public.withdraw_urgent_inbox(${q(closed)},${q(closedEvent)})=r`,'Original unknown closure was not idempotent')}
 ${deny(`public.register_urgent_inbox(${q(closed)},${q(desk)},${q(newInboxId())})`,'PT409')}
 first_close:=${close};${check("first_close->'consent'->>'revokedAt' is not null",'Known consent was not withdrawn')}
 ${check(close+'=first_close','Original withdrawal retry changed')}
 ${check(inspect+'=first_original','Historical original changed after withdrawal')}
 ${deny(`public.read_urgent_inbox_target(${q(consent)},${q(desk)},${q(original.taskId)},1)`)}
 reset role;update public.members set active=false where id=${q(scope.memberId)};
 ${auth(uid)}
 ${check(inspect+'=first_original','Removed member lost exact original history')}
 ${check(close+'=first_close','Removed member lost original cleanup')}
 ${deny(`public.register_urgent_inbox(${q(newInboxId())},${q(desk)},${q(newInboxId())})`)}
 reset role;delete from private.desk_push_subscriptions where id=${q(desk)};
 ${check(`(select active_subscription_id is null from private.urgent_inbox_consents where id=${q(consent)})`,'Removed capability retained a live consent pointer')}
 ${auth(uid)}
 ${check(inspect+'=first_original','Base removal erased immutable original history')}
 reset role;
 update private.urgent_inbox_dispatch_state set enabled=true,revision=revision+1 where id;
 generation:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 insert into private.urgent_inbox_dispatch_grants select ${q(nonce)}::uuid,revision,generation,25,generation+60000,null from private.urgent_inbox_dispatch_state where id;
 select issued_at into generation from private.urgent_inbox_dispatch_grants where nonce=${q(nonce)};
 ${service}
 ${check(`public.claim_urgent_inbox_dispatch(${q(nonce)},generation,25)`,'Current private dispatch grant was rejected')}
 ${check(`not public.claim_urgent_inbox_dispatch(${q(nonce)},generation,25)`,'Dispatch grant was replayed')}
 reset role;
 foreach role_name in array array['anon','authenticated','service_role'] loop
  foreach relation in array array['urgent_inbox_consents','urgent_inbox_closures','urgent_inbox_tasks','urgent_inbox_generations','urgent_inbox_deliveries','urgent_inbox_dispatch_state','urgent_inbox_dispatch_grants'] loop
   ${check("not has_table_privilege(role_name,'private.'||relation,'select,insert,update,delete')",'Private notification table exposed')}
  end loop;
  for helper in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('urgent_inbox_metadata','urgent_inbox_eligible','note_urgent_inbox','urgent_inbox_task_changed','urgent_inbox_due_signature','configure_urgent_inbox_dispatch','dispatch_urgent_inbox_work','read_urgent_inbox_dispatch_status') loop
   ${check("not has_function_privilege(role_name,helper.oid,'execute')",'Raw scheduler/helper exposed')}
  end loop;
 end loop;
 foreach role_name in array array['anon','authenticated'] loop
  execute 'set local role '||role_name;
  ${deny(`public.prepare_urgent_inbox_push(${q(point)},25)`)}
  ${deny(`public.claim_urgent_inbox_dispatch(${q(nonce)},generation,25)`)}
  reset role;
 end loop;
 ${check("(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('urgent_inbox_consents','urgent_inbox_closures','urgent_inbox_tasks','urgent_inbox_generations','urgent_inbox_deliveries','urgent_inbox_dispatch_state','urgent_inbox_dispatch_grants') and c.relrowsecurity and c.relforcerowsecurity)=7",'Notification tables do not force RLS')}
 ${check('(select count(*) from public.sales where business_id='+q(scope.businessId)+')=0 and(select count(*) from public.credit_entries where business_id='+q(scope.businessId)+')=0','Notifications posted financial records')}
 delete from auth.users where id=${q(uid)};
 ${check(`not exists(select 1 from private.urgent_inbox_consents where id=${q(consent)})`,'Deleted account retained consent capability')}
 ${check(`not exists(select 1 from private.urgent_inbox_deliveries where consent_id=${q(consent)})`,'Deleted account retained private deliveries')}
 ${check(`not exists(select 1 from private.urgent_inbox_closures where auth_user_id=${q(uid)})`,'Deleted account retained personal closures')}
 ${check(`exists(select 1 from public.tasks where id=${q(original.taskId)}) and exists(select 1 from public.events where id=${q(consentEvent)})`,'Account cleanup erased public task or audit')}
 perform set_config('mise.urgent_inbox_probe',json_build_object('checks',checks,'actualUrgentSources',2,'actualConsents',1,'providerRequests',0,'financialWrites',0,'schedulerJobsCreated',0,'rolledBack',true)::text,true);
end $proof$;
select current_setting('mise.urgent_inbox_probe')::json proof;rollback;`};
}
