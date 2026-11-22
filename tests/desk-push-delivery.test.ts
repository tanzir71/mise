import {createECDH,randomBytes} from 'node:crypto';
import {generateVAPIDKeys,generateRequestDetails} from 'web-push';
import {beforeAll,afterAll,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createPairingDatabase,deviceId,deviceUid,type PairingDatabase} from './device-pairing-fixture';
import {newKitchenId} from '../packages/core/kitchen';
import {prepareKitchenAction} from '../packages/core/kitchen';
import {orderFixture} from './order-fixture';
import {saveOrderCommand,changeOrderStatusCommand,nextOrderStatuses} from '../packages/core/orders';
import {encodeCommandRecord,decodeCommandRecord} from '../packages/core/cloud-records';
import type {Order} from '../packages/core/models';
import {createStaffPin} from '../supabase/functions/_shared/staff-pin';
import {createKitchenAlarmsHandler,createKitchenAlarmsStore} from '../supabase/functions/_shared/kitchen-alarms-handler';
import {createKitchenActionsHandler,createKitchenActionsStore} from '../supabase/functions/_shared/kitchen-actions-handler';
import {createKitchenPushHandler,createKitchenPushStore} from '../supabase/functions/_shared/kitchen-push-handler';
import {createDeskPushSender} from '../supabase/functions/_shared/desk-push-sender';
import {createDeskNotificationsHandler,createDeskNotificationsStore} from '../supabase/functions/_shared/desk-notifications-handler';

type Sql=Pick<PGlite,'exec'|'query'>;
interface Registration {id:string;event:string;outlet:string;endpoint:string;point:string;auth:string;applicationKey:string;expires:number|null}
let f:PairingDatabase;
let order:Order,deviceToken:string,sessionToken:string;
const vapid={subject:'https://desk.test/contact',...generateVAPIDKeys()},applicationKey=vapid.publicKey;
function registration():Registration {
 const key=createECDH('prime256v1');key.generateKeys();
 return {id:newKitchenId(),event:newKitchenId(),outlet:deviceId(11),endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-'+newKitchenId(),
  point:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url'),applicationKey,expires:null};
}
async function role<T=unknown>(sql:Sql,n:number|null,selected:'authenticated'|'anon'|'service_role',query:string,args:unknown[]=[]):Promise<T>{
 await sql.exec('set local role '+selected);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:selected,...(n===null?{}:{sub:deviceUid(n)}),user_metadata:{role:'owner'}})]);
 const result=(await sql.query<{data:T}>(query,args)).rows[0]?.data;await sql.exec('reset role');return result;
}
async function rollback(work:(sql:Sql)=>Promise<void>){const end=Error('rollback');try{await f.db.transaction(async sql=>{await work(sql);throw end;});}catch(error){if(error!==end)throw error;}}
async function rejected(sql:Sql,work:()=>Promise<unknown>,code:string){await sql.exec('savepoint rejection');await expect(work()).rejects.toMatchObject({code});await sql.exec('rollback to savepoint rejection;release savepoint rejection');}
const register=(sql:Sql,r:Registration,n=1)=>role(sql,n,'authenticated',
 'select public.register_desk_push(p_id=>$1,p_outlet_id=>$2,p_endpoint=>$3,p_p256dh=>$4,p_auth=>$5,p_application_key=>$6,p_expires_at=>$7,p_event_id=>$8) data',
 [r.id,r.outlet,r.endpoint,r.point,r.auth,r.applicationKey,r.expires,r.event]);
beforeAll(async()=>{
 f=await createPairingDatabase();await f.seed();
 const original=orderFixture('corner_shop'),seed=original.context.setup,setup={business:{...seed.business,id:deviceId(1)},outlet:{...seed.outlet,id:deviceId(11),businessId:deviceId(1)},owner:{...seed.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(11)]}};
 const made=saveOrderCommand({...original.input,sourceText:'PRIVATE SOURCE',name:'PRIVATE CUSTOMER'},{...original.context,setup},null,0,Date.now()-180000);
 order=made.order;const events=[made.event];while(order.status!=='accepted'){const next=changeOrderStatusCommand(order,nextOrderStatuses(order)[0],setup,order.revision,order.updatedAt+1);order=next.order;events.push(next.event);}
 await f.db.transaction(async sql=>{for(const record of [...events.map(e=>encodeCommandRecord('events',e,deviceId(1))),encodeCommandRecord('orders',order,deviceId(1))]){const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));}});
 const pin=await createStaffPin('0042',{businessId:deviceId(1),memberId:deviceId(105)},f.pepper);
 await f.asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[deviceId(11),deviceId(105),newKitchenId(),pin.salt,pin.verifier,pin.pepperVersion]);
 const device=await f.asRole<{token:string}>(1,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) data',[newKitchenId(),newKitchenId(),deviceId(11),'Push test','kitchen']);deviceToken=device.token;
 const attempt=await f.asRole<{attemptId:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),deviceToken,deviceId(105)]);
 const session=await f.asRole<{token:string}>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[deviceToken,attempt.attemptId,pin.verifier,newKitchenId(),newKitchenId()]);sessionToken=session.token;
},30000);
afterAll(async()=>{await f?.db.close();});

function rpc(sql:Sql):typeof fetch{let serial=Promise.resolve();return async(url,options)=>{
 const route=new URL(String(url)).pathname.split('/').at(-1)!;
 if(!['prepare_kitchen_alarms','finish_kitchen_alarm','prepare_kitchen_action','finish_kitchen_action','prepare_kitchen_push','claim_kitchen_push','finish_kitchen_push'].includes(route))throw Error('Unexpected RPC');
 const input=JSON.parse(String(options?.body)),keys=Object.keys(input);if(keys.some(k=>!/^p_[a-z][a-z0-9_]*$/.test(k)))throw Error('Unexpected argument');
 // PGlite owns one connection. Serialize each complete role/query/reset unit;
 // concurrent worker claims must never accidentally execute as fixture owner.
 const work=serial.then(()=>role(sql,null,'service_role',`select public.${route}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) data`,Object.values(input)));
 serial=work.then(()=>undefined,()=>undefined);return Response.json(await work);
};}
async function alarm(sql:Sql){
 const response=await createKitchenAlarmsHandler({key:'A'.repeat(43),store:createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',rpc(sql))})(new Request('https://rpc.test/functions/v1/kitchen-alarms',{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'Content-Type':'application/json'},body:'{}'}));
 expect(response.status,await response.clone().text()).toBe(200);
 return (await sql.query<{id:string}>("select id from public.tasks where status='open' and outlet_id=$1",[deviceId(11)])).rows[0]?.id;
}
async function acknowledge(sql:Sql){
 const current=decodeCommandRecord('orders',(await sql.query<Record<string,unknown>>('select * from public.orders where id=$1',[order.id])).rows[0]) as unknown as Order;
 const action=await prepareKitchenAction(current,'kitchen.acknowledge');
 const response=await createKitchenActionsHandler({origins:new Set(['https://desk.test']),store:createKitchenActionsStore('https://rpc.test','sb_secret_test_only',rpc(sql))})(new Request('https://rpc.test/functions/v1/kitchen-actions',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer '+deviceToken,'Content-Type':'application/json'},body:JSON.stringify({sessionToken,action})}));
 expect(response.status,await response.clone().text()).toBe(200);return response.json();
}
interface PushJob {taskId:string;generation:number;subscriptionId:string}
const prepare=(sql:Sql)=>role<{v:1;at:number;jobs:PushJob[]}>(sql,null,'service_role','select public.prepare_kitchen_push(p_application_key=>$1,p_limit=>25) data',[applicationKey]);
const claim=(sql:Sql,job:PushJob,lease=newKitchenId())=>role(sql,null,'service_role','select public.claim_kitchen_push(p_task_id=>$1,p_generation=>$2,p_subscription_id=>$3,p_lease_id=>$4,p_application_key=>$5) data',[job.taskId,job.generation,job.subscriptionId,lease,applicationKey]);
const finish=(sql:Sql,job:PushJob,lease:string,outcome:'sent'|'expired'|'retry')=>role(sql,null,'service_role','select public.finish_kitchen_push(p_task_id=>$1,p_generation=>$2,p_subscription_id=>$3,p_lease_id=>$4,p_outcome=>$5) data',[job.taskId,job.generation,job.subscriptionId,lease,outcome]);
const tick=()=>new Request('https://rpc.test/functions/v1/kitchen-push',{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'Content-Type':'application/json'},body:'{}'});
const push=(sql:Sql,provider:typeof fetch,transport=rpc(sql))=>createKitchenPushHandler({key:'A'.repeat(43),applicationKey,
 store:createKitchenPushStore('https://rpc.test','sb_secret_test_only',transport),send:createDeskPushSender(generateRequestDetails,vapid,provider)});
function desk(sql:Sql,n=1,key=applicationKey,loseRegistrationReply=false){
 let lost=false;
 const send:typeof fetch=async(url,options)=>{
  const route=new URL(String(url)).pathname.split('/').at(-1)!;
  if(!['desk_push_context','register_desk_push','read_desk_push','revoke_desk_push'].includes(route))throw Error('Unexpected authenticated RPC');
  expect(new Headers(options?.headers).get('authorization')).toBe('Bearer phone.'+n+'.signature');expect(new Headers(options?.headers).get('apikey')).toBe('sb_publishable_test_only');
  const args=JSON.parse(String(options?.body)),keys=Object.keys(args);if(keys.some(k=>!/^p_[a-z][a-z0-9_]*$/.test(k)))throw Error('Invalid named argument');
  await sql.exec('savepoint desk_rpc');
  try{
   const result=await role(sql,n,'authenticated',`select public.${route}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) data`,Object.values(args));
   await sql.exec('release savepoint desk_rpc');
   if(loseRegistrationReply&&!lost&&route==='register_desk_push'){lost=true;return new Response(null,{status:503});}
   return Response.json(result);
  }catch(error){await sql.exec('rollback to savepoint desk_rpc;release savepoint desk_rpc');const code=(error as {code?:string}).code;return Response.json({error:'Unaccepted SQL request'},{status:code==='42501'?403:code==='PT409'?409:code==='PT429'?429:400});}
 };
 const handler=createDeskNotificationsHandler({origins:new Set(['https://desk.test']),applicationKey:key,store:createDeskNotificationsStore('https://rpc.test','sb_publishable_test_only',send)});
 return (input:unknown)=>handler(new Request('https://rpc.test/functions/v1/desk-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer phone.'+n+'.signature','Content-Type':'application/json'},body:JSON.stringify(input)}));
}
const registrationBody=(r:Registration)=>({action:'register',id:r.id,outletId:r.outlet,eventId:r.event,applicationKey:r.applicationKey,
 subscription:{endpoint:r.endpoint,expirationTime:r.expires,keys:{p256dh:r.point,auth:r.auth}}});

it('registers an original desk capability with closed metadata and no endpoint, browser keys or Auth identity in public audit',async()=>rollback(async sql=>{
 const r=registration(),result=await register(sql,r);
 expect(result).toMatchObject({v:1,id:r.id,businessId:deviceId(1),outletId:r.outlet,memberId:deviceId(101),expiresAt:null,revokedAt:null});
 expect(Object.keys(result as object).sort()).toEqual(['v','id','businessId','outletId','memberId','createdAt','expiresAt','revokedAt'].sort());
 const audit=(await sql.query<{after_data:unknown}>('select after_data from public.events where id=$1',[r.event])).rows[0].after_data;
 expect(audit).toEqual(result);for(const value of [r.endpoint,r.point,r.auth,applicationKey,deviceUid(1)])expect(JSON.stringify(audit)).not.toContain(value);
 expect((await sql.query<{auth_user_id:string}>('select auth_user_id from private.desk_push_subscriptions where id=$1',[r.id])).rows[0].auth_user_id).toBe(deviceUid(1));
}));
it('retries the exact original registration once and rejects a changed key, endpoint, event or original account',async()=>rollback(async sql=>{
 const r=registration(),first=await register(sql,r);expect(await register(sql,r)).toEqual(first);
 for(const replacement of [{...r,auth:registration().auth},{...r,endpoint:registration().endpoint},{...r,event:newKitchenId()}])await rejected(sql,()=>register(sql,replacement),'PT409');
 await rejected(sql,()=>register(sql,r,2),'PT409');
 expect((await sql.query('select id from public.events where id=$1',[r.event])).rows).toHaveLength(1);
 expect((await sql.query('select id from private.desk_push_subscriptions')).rows).toHaveLength(1);
}));
it.each([3,4,5])('denies actual unassigned, foreign or anonymous account %s despite editable owner claims',async n=>rollback(async sql=>{
 await rejected(sql,()=>register(sql,registration(),n),'42501');
 expect((await sql.query('select id from private.desk_push_subscriptions')).rows).toHaveLength(0);
}));
it('does not silently retarget an active endpoint and permits explicit re-registration after its original owner revokes it',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);const replacement={...registration(),endpoint:r.endpoint};
 await rejected(sql,()=>register(sql,replacement,2),'PT409');
 const event=newKitchenId(),removed=await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,event]);
 expect(removed).toMatchObject({id:r.id,revokedAt:expect.any(Number)});expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,event])).toEqual(removed);
 await rejected(sql,()=>role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()]),'PT409');
 expect(await register(sql,replacement,2)).toMatchObject({id:replacement.id,memberId:deviceId(102)});
}));
it('keeps an explicit withdrawal authoritative when its earlier original registration arrives late',async()=>rollback(async sql=>{
 const r=registration();expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toBeNull();
 await rejected(sql,()=>register(sql,r),'PT409');expect((await sql.query('select id from private.desk_push_subscriptions where id=$1',[r.id])).rows).toHaveLength(0);
}));
it('retries only the original personal withdrawal and records no invented shop event for an absent setup',async()=>rollback(async sql=>{
 const r=registration(),event=newKitchenId();expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,event])).toBeNull();
 expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,event])).toBeNull();
 await rejected(sql,()=>role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()]),'PT409');
 await rejected(sql,()=>role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[newKitchenId(),event]),'PT409');
 expect((await sql.query<{event_id:string;had_subscription:boolean}>('select event_id,had_subscription from private.desk_push_closures where subscription_id=$1',[r.id])).rows).toEqual([{event_id:event,had_subscription:false}]);
 expect((await sql.query('select id from public.events where id=$1',[event])).rows).toHaveLength(0);
}));
it('does not let another confirmed phone account pre-close the original owner capability',async()=>rollback(async sql=>{
 const r=registration();for(const n of [2,3,4])expect(await role(sql,n,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toBeNull();
 await rejected(sql,()=>role(sql,5,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()]),'42501');
 expect(await register(sql,r)).toMatchObject({id:r.id,memberId:deviceId(101),revokedAt:null});
}));
it('bounds new unknown withdrawals without expiring prior closures or blocking a real owned subscription removal',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);
 await sql.query("insert into private.desk_push_closures(auth_user_id,subscription_id,event_id,closed_at,had_subscription) select $1,lpad(n::text,26,'0')::public.ulid,lpad((n+2000)::text,26,'0')::public.ulid,$2,false from generate_series(1001,2000) n",[deviceUid(1),Date.now()]);
 await rejected(sql,()=>role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[newKitchenId(),newKitchenId()]),'PT429');
 expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[deviceId(1001),deviceId(3001)])).toBeNull();
 expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toMatchObject({id:r.id,revokedAt:expect.any(Number)});
 expect((await sql.query<{count:number}>('select count(*)::integer count from private.desk_push_closures')).rows[0].count).toBe(1001);
}));
it('keeps a browser capability private to its original account',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);
 expect(await role(sql,2,'authenticated','select public.read_desk_push($1) data',[r.id])).toBeNull();
 expect(await role(sql,4,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toBeNull();
 expect(await role(sql,1,'authenticated','select public.read_desk_push($1) data',[r.id])).toMatchObject({id:r.id,revokedAt:null});
}));
it('allows an original manager to revoke their own capability after their outlet assignment is removed without restoring access',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r,2);await sql.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(102),r.outlet]);
 expect(await role(sql,2,'authenticated','select public.read_desk_push($1) data',[r.id])).toBeNull();
 expect(await role(sql,2,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toMatchObject({id:r.id,revokedAt:expect.any(Number)});
 await rejected(sql,()=>register(sql,registration(),2),'42501');
}));
it.each(['inactive member','banned phone','unconfirmed phone'] as const)('does not expose an active subscription after %s',async changed=>rollback(async sql=>{
 const r=registration();await register(sql,r);
 if(changed==='inactive member')await sql.query('update public.members set active=false where id=$1',[deviceId(101)]);
 else if(changed==='banned phone')await sql.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[deviceUid(1)]);
 else await sql.query('update auth.users set phone_confirmed_at=null where id=$1',[deviceUid(1)]);
 expect(await role(sql,1,'authenticated','select public.read_desk_push($1) data',[r.id])).toBeNull();
}));
it('limits live desk registrations and frees capacity after a genuine original revocation',async()=>rollback(async sql=>{
 const first=registration();await register(sql,first);for(let i=1;i<20;i++)await register(sql,registration());
 await rejected(sql,()=>register(sql,registration()),'PT429');
 await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[first.id,newKitchenId()]);
 expect(await register(sql,registration())).toMatchObject({revokedAt:null});
}));
it('forces private RLS and denies all direct client/service table access and client delivery RPCs',async()=>rollback(async sql=>{
 for(const selected of ['authenticated','anon','service_role'] as const){
  for(const table of ['desk_push_subscriptions','kitchen_push_deliveries','desk_push_closures'])expect(await role(sql,selected==='authenticated'?1:null,selected,'select has_table_privilege(current_user,$1,$2) data',['private.'+table,'select'])).toBe(false);
 }
 for(const signature of ['public.prepare_kitchen_push(text,integer)','public.claim_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text)','public.finish_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text)']){
  expect(await role(sql,1,'authenticated','select has_function_privilege(current_user,$1,$2) data',[signature,'execute'])).toBe(false);
  expect(await role(sql,null,'anon','select has_function_privilege(current_user,$1,$2) data',[signature,'execute'])).toBe(false);
 }
 expect((await sql.query<{count:number}>("select count(*)::integer count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('desk_push_subscriptions','kitchen_push_deliveries','desk_push_closures') and c.relrowsecurity and c.relforcerowsecurity")).rows[0].count).toBe(3);
}));
it('expands a real alarm once into original eligible desks and never calls an empty recipient expansion sent',async()=>rollback(async sql=>{
 const first=registration(),second=registration();await register(sql,first);await register(sql,second,2);
 await register(sql,{...registration(),outlet:deviceId(21)},4);const task=await alarm(sql),page=await prepare(sql);
 expect(page.jobs).toHaveLength(2);expect(page.jobs.every(j=>j.taskId===task&&j.generation===1)).toBe(true);
 expect(new Set(page.jobs.map(j=>j.subscriptionId))).toEqual(new Set([first.id,second.id]));
 await register(sql,registration());expect((await prepare(sql)).jobs).toEqual(page.jobs);
 expect((await sql.query('select * from private.kitchen_push_deliveries')).rows).toHaveLength(2);
 expect((await sql.query<{status:string}>('select status from private.kitchen_alarm_notifications where task_id=$1',[task])).rows[0].status).toBe('pending');
}));
it('records a no-recipient expansion as complete, without a provider result or notification event',async()=>rollback(async sql=>{
 const task=await alarm(sql);expect((await prepare(sql)).jobs).toEqual([]);
 expect((await sql.query<{status:string}>('select status from private.kitchen_alarm_notifications where task_id=$1',[task])).rows[0].status).toBe('complete');
 expect((await sql.query("select id from public.events where command like 'desk.push.%'")).rows).toHaveLength(0);
}));
it('claims one bounded lease with only original scoped identifiers in its generic notice',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);await alarm(sql);const [job]=(await prepare(sql)).jobs,lease=newKitchenId();
 const result=await claim(sql,job,lease) as {notice:unknown;subscription:unknown};
 expect(result).toMatchObject({v:1,leaseId:lease,subscription:{endpoint:r.endpoint,keys:{p256dh:r.point,auth:r.auth}}});
 expect(result.notice).toEqual({v:1,type:'kitchen-alarm',subscriptionId:r.id,businessId:deviceId(1),outletId:deviceId(11),taskId:job.taskId,generation:job.generation});
 expect(JSON.stringify(result.notice)).not.toMatch(/PRIVATE|CUSTOMER|SOURCE|orderNumber|price|payment|endpoint|auth/);
 expect(await claim(sql,job)).toBeNull();expect((await prepare(sql)).jobs).toEqual([]);
 expect((await sql.query<{attempts:number}>('select attempts from private.kitchen_push_deliveries')).rows[0].attempts).toBe(1);
}));
it('cancels unsent per-desk deliveries in the actual Got it transaction',async()=>rollback(async sql=>{
 await register(sql,registration());await alarm(sql);const [job]=(await prepare(sql)).jobs;await acknowledge(sql);
 expect(await claim(sql,job)).toBeNull();expect((await prepare(sql)).jobs).toEqual([]);
 expect((await sql.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows).toEqual([{state:'cancelled'}]);
 expect((await sql.query<{status:string}>('select status from public.tasks where id=$1',[job.taskId])).rows[0].status).toBe('resolved');
}));
it('retains an explicit in-flight accepted outcome after Got it without reopening its task or duplicating the result event',async()=>rollback(async sql=>{
 await register(sql,registration());await alarm(sql);const [job]=(await prepare(sql)).jobs,lease=newKitchenId();expect(await claim(sql,job,lease)).not.toBeNull();await acknowledge(sql);
 expect(await finish(sql,job,lease,'sent')).toEqual({state:'sent'});expect(await finish(sql,job,lease,'sent')).toEqual({state:'sent'});
 await rejected(sql,()=>finish(sql,job,lease,'expired'),'PT409');
 expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toEqual([{id:lease}]);
 expect((await sql.query<{status:string}>('select status from public.tasks where id=$1',[job.taskId])).rows[0].status).toBe('resolved');
}));
it('does not claim a desk after its real assignment is removed',async()=>rollback(async sql=>{
 await register(sql,registration(),2);await alarm(sql);const [job]=(await prepare(sql)).jobs;
 await sql.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(102),deviceId(11)]);
 expect(await claim(sql,job)).toBeNull();expect((await sql.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows).toEqual([{state:'cancelled'}]);
}));
it('revokes only the original desk pending delivery and keeps another eligible desk available',async()=>rollback(async sql=>{
 const first=registration(),second=registration();await register(sql,first);await register(sql,second,2);await alarm(sql);const {jobs}=await prepare(sql);
 await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[first.id,newKitchenId()]);
 expect(await claim(sql,jobs.find(j=>j.subscriptionId===first.id)!)).toBeNull();
 expect((await prepare(sql)).jobs).toEqual([jobs.find(j=>j.subscriptionId===second.id)!]);
 expect(await claim(sql,jobs.find(j=>j.subscriptionId===second.id)!)).not.toBeNull();
}));
it('resumes the same original task after the worker inspects a later non-preparation revision',async()=>rollback(async sql=>{
 await register(sql,registration());const task=await alarm(sql),[job]=(await prepare(sql)).jobs;
 const original=(await sql.query('select * from private.kitchen_alarm_tasks where task_id=$1',[task])).rows[0];
 await sql.query('update public.orders set revision=revision+1,updated_at=updated_at+1 where id=$1',[order.id]);
 expect(await claim(sql,job)).toBeNull();expect(await alarm(sql)).toBe(task);expect((await prepare(sql)).jobs).toEqual([job]);
 expect((await sql.query('select * from private.kitchen_alarm_tasks where task_id=$1',[task])).rows[0]).toEqual(original);
 expect(await claim(sql,job)).toMatchObject({notice:{taskId:task,generation:1}});
}));
it('defers an old content task while its newer genuine Got it awaits the alarm worker, then cancels it without a send attempt',async()=>rollback(async sql=>{
 await register(sql,registration());const old=await alarm(sql),[job]=(await prepare(sql)).jobs;
 await sql.query('update public.orders set table_label=$1,revision=revision+1 where id=$2',[JSON.stringify('New table'),order.id]);await acknowledge(sql);
 expect(await claim(sql,job)).toBeNull();
 expect((await sql.query<{state:string;attempts:number}>('select state,attempts from private.kitchen_push_deliveries')).rows).toEqual([{state:'pending',attempts:0}]);
 await alarm(sql);expect((await sql.query<{status:string}>('select status from public.tasks where id=$1',[old])).rows[0].status).toBe('resolved');
 expect((await sql.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows).toEqual([{state:'cancelled'}]);
 expect((await prepare(sql)).jobs).toEqual([]);expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toHaveLength(0);
}));
it('retires a provider-expired private capability and allows its original phone account to confirm cleanup',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);await alarm(sql);const [job]=(await prepare(sql)).jobs,lease=newKitchenId();await claim(sql,job,lease);
 expect(await finish(sql,job,lease,'expired')).toEqual({state:'expired'});
 expect(await role(sql,1,'authenticated','select public.read_desk_push($1) data',[r.id])).toBeNull();
 expect(await role(sql,1,'authenticated','select public.revoke_desk_push($1,$2) data',[r.id,newKitchenId()])).toMatchObject({id:r.id,revokedAt:expect.any(Number)});
 expect((await sql.query("select id from public.events where command='desk.push.expired'")).rows).toEqual([{id:lease}]);
}));
it('keeps a bounded durable retry and fails after eight actual claims instead of retrying forever',async()=>rollback(async sql=>{
 await register(sql,registration());await alarm(sql);const [job]=(await prepare(sql)).jobs;
 for(let i=1;i<=8;i++){
  const lease=newKitchenId();expect(await claim(sql,job,lease)).not.toBeNull();expect(await finish(sql,job,lease,'retry')).toEqual({state:i===8?'failed':'pending'});
  if(i<8){expect((await prepare(sql)).jobs).toEqual([]);await sql.exec("update private.kitchen_push_deliveries set next_at=0 where state='pending'");}
 }
 expect((await prepare(sql)).jobs).toEqual([]);expect((await sql.query<{state:string;attempts:number}>('select state,attempts from private.kitchen_push_deliveries')).rows).toEqual([{state:'failed',attempts:8}]);
}));
it('reclaims an expired lease and rejects an older result without replacing the current original delivery',async()=>rollback(async sql=>{
 await register(sql,registration());await alarm(sql);const [job]=(await prepare(sql)).jobs,first=newKitchenId(),second=newKitchenId();await claim(sql,job,first);
 await sql.exec("update private.kitchen_push_deliveries set lease_expires_at=0 where state='sending'");expect((await prepare(sql)).jobs).toEqual([job]);
 expect(await claim(sql,job,second)).not.toBeNull();expect(await finish(sql,job,first,'sent')).toEqual({state:'stale'});expect(await finish(sql,job,second,'sent')).toEqual({state:'sent'});
 expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toEqual([{id:second}]);
}));
it('runs the production HTTP worker through real service-role RPCs and an encrypted request before recording provider acceptance',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);const task=await alarm(sql);let calls=0;
 const provider:typeof fetch=async(url,options)=>{calls++;expect(url).toBe(r.endpoint);expect(options).toMatchObject({method:'POST',redirect:'error'});
  const headers=new Headers(options?.headers);expect(headers.get('Topic')).toBe(task);expect(headers.get('Content-Encoding')).toBe('aes128gcm');expect(headers.get('authorization')).toMatch(/^vapid /);
  expect(Buffer.from(options?.body as ArrayBuffer).toString()).not.toMatch(/PRIVATE|CUSTOMER|SOURCE/);return new Response(null,{status:201});};
 const response=await push(sql,provider)(tick());expect(response.status,await response.clone().text()).toBe(200);expect(await response.json()).toMatchObject({processed:1,sent:1,failed:0});expect(calls).toBe(1);
 expect((await sql.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows).toEqual([{state:'sent'}]);
 expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toHaveLength(1);
}));
it('does not resend after the real finish RPC applies but its HTTP reply is lost',async()=>rollback(async sql=>{
 await register(sql,registration());await alarm(sql);const base=rpc(sql);let dropped=false,calls=0;
 const transport:typeof fetch=async(url,options)=>{const response=await base(url,options);if(!dropped&&String(url).endsWith('/finish_kitchen_push')){dropped=true;return new Response(null,{status:503});}return response;};
 const handler=push(sql,async()=>{calls++;return new Response(null,{status:201});},transport);
 expect((await handler(tick())).status).toBe(503);expect(await (await handler(tick())).json()).toMatchObject({processed:0,sent:0,failed:0});expect(calls).toBe(1);
 expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toHaveLength(1);
}));
it('retries an unconfirmed provider request with the same recipient and task topic',async()=>rollback(async sql=>{
 const r=registration();await register(sql,r);const task=await alarm(sql),requests:{url:string;topic:string|null}[]=[];
 const handler=push(sql,async(url,options)=>{requests.push({url:String(url),topic:new Headers(options?.headers).get('Topic')});if(requests.length===1)throw Error('Lost provider reply');return new Response(null,{status:201});});
 expect(await (await handler(tick())).json()).toMatchObject({processed:1,retried:1,sent:0});
 await sql.exec("update private.kitchen_push_deliveries set next_at=0 where state='pending'");
 expect(await (await handler(tick())).json()).toMatchObject({processed:1,sent:1,failed:0});expect(requests).toEqual([{url:r.endpoint,topic:task},{url:r.endpoint,topic:task}]);
 expect((await sql.query("select id from public.events where command='desk.push.sent'")).rows).toHaveLength(1);
}));
it('keeps the provider result when real Got it arrives during the HTTP request and leaves the alarm resolved',async()=>rollback(async sql=>{
 await register(sql,registration());const task=await alarm(sql);
 const response=await push(sql,async()=>{await acknowledge(sql);return new Response(null,{status:201});})(tick());
 expect(response.status,await response.clone().text()).toBe(200);expect(await response.json()).toMatchObject({sent:1,failed:0});
 expect((await sql.query<{status:string}>('select status from public.tasks where id=$1',[task])).rows[0].status).toBe('resolved');
 expect((await sql.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows[0].state).toBe('sent');
}));
it('rechecks real outlet membership at the worker claim before any provider HTTP',async()=>rollback(async sql=>{
 await register(sql,registration(),2);await alarm(sql);const base=rpc(sql);let changed=false,calls=0;
 const transport:typeof fetch=async(url,options)=>{if(!changed&&String(url).endsWith('/claim_kitchen_push')){changed=true;await sql.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(102),deviceId(11)]);}return base(url,options);};
 const response=await push(sql,async()=>{calls++;return new Response(null,{status:201});},transport)(tick());
 expect(response.status,await response.clone().text()).toBe(200);expect(await response.json()).toMatchObject({processed:1,skipped:1,sent:0});expect(calls).toBe(0);
}));
it.each([1,2])('returns runtime notification configuration only after actual phone account %s is authorized for this outlet',async n=>rollback(async sql=>{
 const response=await desk(sql,n)({action:'configuration',outletId:deviceId(11)});expect(response.status,await response.clone().text()).toBe(200);
 expect(await response.json()).toEqual({v:1,context:{v:1,businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(n===1?101:102),role:n===1?'owner':'manager'},applicationKey});
}));
it.each([3,4,5])('denies HTTP configuration for unassigned, foreign or anonymous real account %s',async n=>rollback(async sql=>{
 const response=await desk(sql,n)({action:'configuration',outletId:deviceId(11)});expect(response.status).toBe(403);expect(await response.text()).not.toContain(applicationKey);
}));
it('recovers the original HTTP registration after its SQL result reply is lost, without another capability or public key disclosure',async()=>rollback(async sql=>{
 const r=registration(),handler=desk(sql,1,applicationKey,true),body=registrationBody(r);expect((await handler(body)).status).toBe(503);
 const response=await handler(body);expect(response.status,await response.clone().text()).toBe(200);const metadata=await response.json();expect(metadata).toMatchObject({id:r.id,outletId:r.outlet,memberId:deviceId(101)});
 for(const privateValue of [r.endpoint,r.point,r.auth,applicationKey,deviceUid(1)])expect(JSON.stringify(metadata)).not.toContain(privateValue);
 expect((await sql.query('select id from private.desk_push_subscriptions')).rows).toHaveLength(1);expect((await sql.query('select id from public.events where id=$1',[r.event])).rows).toHaveLength(1);
}));
it('lets the original phone HTTP client retire its capability after assignment removal and VAPID removal without restoring access',async()=>rollback(async sql=>{
 const r=registration(),owner=desk(sql,2);expect((await owner(registrationBody(r))).status).toBe(200);
 await sql.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(102),r.outlet]);
 expect((await owner({action:'configuration',outletId:r.outlet})).status).toBe(403);
 expect(await (await owner({action:'read',id:r.id})).json()).toBeNull();
 const response=await desk(sql,2,'')({action:'revoke',id:r.id,eventId:newKitchenId()});expect(response.status,await response.clone().text()).toBe(200);expect(await response.json()).toMatchObject({id:r.id,revokedAt:expect.any(Number)});
}));
it('does not return or revoke a different real phone account capability over HTTP',async()=>rollback(async sql=>{
 const r=registration();await desk(sql)(registrationBody(r));const other=desk(sql,2);
 expect(await (await other({action:'read',id:r.id})).json()).toBeNull();expect(await (await other({action:'revoke',id:r.id,eventId:newKitchenId()})).json()).toBeNull();
 expect(await (await desk(sql)({action:'read',id:r.id})).json()).toMatchObject({id:r.id,revokedAt:null});
}));
