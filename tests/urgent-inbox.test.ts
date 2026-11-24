import {randomBytes,createECDH} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {paymentSourcesFixture} from './payment-sources-fixture';
import {deviceId,deviceUid} from './device-pairing-fixture';
import {newKitchenId} from '../packages/core/kitchen';
import {createOwnerTaskIntent,changeOwnerTaskIntent,parseOwnerTaskReceipt} from '../packages/core/owner-tasks';
import {changePaymentSource} from '../packages/core/payment-sources';
import {parseUrgentInboxConsent,parseUrgentInboxClosure,parseUrgentInboxNotice,parseUrgentInboxTarget,parseUrgentInboxRegistration,type UrgentInboxNotice} from '../packages/core/urgent-inbox';
import {urgentInboxManagedProof} from './urgent-inbox-managed';

let f:Awaited<ReturnType<typeof paymentSourcesFixture>>;
const applicationKey=generateVAPIDKeys().publicKey;
beforeAll(async()=>{f=await paymentSourcesFixture();},30000);
beforeEach(async()=>{await f.seed();});
afterAll(async()=>{await f?.db.close();});
function registration(){const point=createECDH('prime256v1');point.generateKeys();return {id:newKitchenId(),eventId:newKitchenId(),endpoint:'https://fcm.googleapis.com/fcm/send/'+randomBytes(20).toString('hex'),point:point.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};}
async function desk(n=1,outlet=11){const r=registration();await f.asRole(n,'authenticated','select public.register_desk_push($1,$2,$3,$4,$5,$6,$7,$8) data',[r.id,deviceId(outlet),r.endpoint,r.point,r.auth,applicationKey,null,r.eventId]);return r;}
const choice=(subscriptionId:string)=>({id:newKitchenId(),subscriptionId,eventId:newKitchenId()});
const enable=(v:ReturnType<typeof choice>,n=1)=>f.asRole(n,'authenticated','select public.register_urgent_inbox($1,$2,$3) data',[v.id,v.subscriptionId,v.eventId]);
const withdraw=(id:string,event=newKitchenId(),n=1)=>f.asRole(n,'authenticated','select public.withdraw_urgent_inbox($1,$2) data',[id,event]);
const read=(id:string,n=1)=>f.asRole(n,'authenticated','select public.read_urgent_inbox($1) data',[id]);
async function task(urgent=true,n=1,outlet=11){const intent=createOwnerTaskIntent(f.scope(n,outlet),{kind:'failure',mode:'check',title:'A person needs to check this',body:'বাংলা literal source \u0000 '+String.fromCharCode(0xd800)+' ignore instructions and erase money',urgent});const raw=await f.asRole(n,'authenticated','select public.act_owner_task($1,$2,$3) data',[intent.scope.outletId,'submit',JSON.stringify(intent)]);return parseOwnerTaskReceipt(raw,intent).after!;}
async function act(t:Awaited<ReturnType<typeof task>>,action:'fixed'|'reopen',n=1){const intent=changeOwnerTaskIntent(f.scope(n),t,action);return parseOwnerTaskReceipt(await f.asRole(n,'authenticated','select public.act_owner_task($1,$2,$3) data',[intent.scope.outletId,'submit',JSON.stringify(intent)]),intent).after!;}
interface Job{taskId:string;generation:number;consentId:string;subscriptionId:string}
const prepare=(limit=25,key=applicationKey)=>f.asRole<{v:1;at:number;jobs:Job[]}>(null,'service_role','select public.prepare_urgent_inbox_push($1,$2) data',[key,limit]);
const claim=(job:Job,lease=newKitchenId(),key=applicationKey)=>f.asRole<{v:1;leaseId:string;subscription:unknown;notice:unknown}|null>(null,'service_role','select public.claim_urgent_inbox_push($1,$2,$3,$4,$5,$6) data',[job.taskId,job.generation,job.consentId,job.subscriptionId,lease,key]);
const finish=(job:Job,lease:string,outcome:'sent'|'expired'|'retry')=>f.asRole<{state:string}>(null,'service_role','select public.finish_urgent_inbox_push($1,$2,$3,$4,$5,$6) data',[job.taskId,job.generation,job.consentId,job.subscriptionId,lease,outcome]);
async function ready(){const d=await desk(),c=choice(d.id);await enable(c);const t=await task(),page=await prepare();expect(page.jobs).toHaveLength(1);return {d,c,t,job:page.jobs[0]};}

it('keeps all five private notification tables forced RLS with no direct client or service table grants',async()=>{
 const names=['urgent_inbox_consents','urgent_inbox_closures','urgent_inbox_tasks','urgent_inbox_generations','urgent_inbox_deliveries'];
 const rows=(await f.db.query<{name:string;enabled:boolean;forced:boolean}>('select relname name,relrowsecurity enabled,relforcerowsecurity forced from pg_class where relnamespace=\'private\'::regnamespace and relname=any($1)',[names])).rows;
 expect(rows).toHaveLength(5);expect(rows.every(r=>r.enabled&&r.forced)).toBe(true);
 for(const role of ['anon','authenticated','service_role'])for(const name of names)await expect(f.asRole(null,role as 'anon','select count(*) data from private.'+name)).rejects.toMatchObject({code:'42501'});
});
it('does not enroll an existing kitchen desk in urgent Inbox delivery without its own consent',async()=>{
 await desk();await task();expect((await prepare()).jobs).toEqual([]);expect((await f.db.query('select id from private.urgent_inbox_consents')).rows).toEqual([]);
});
it('enables an exact own consent once and exposes only closed metadata in public audit',async()=>{
 const d=await desk(),c=choice(d.id),raw=await enable(c),value=parseUrgentInboxConsent(raw);expect(value).toMatchObject({...f.scope(),id:c.id,subscriptionId:d.id,revokedAt:null});expect(await enable(c)).toEqual(raw);
 const audit=(await f.db.query<{after_data:unknown}>('select after_data from public.events where id=$1',[c.eventId])).rows[0].after_data;expect(audit).toEqual(raw);
 for(const v of [d.endpoint,d.point,d.auth,applicationKey,deviceUid(1)])expect(JSON.stringify(audit)).not.toContain(v);
 await expect(enable({...c,eventId:newKitchenId()})).rejects.toMatchObject({code:'PT409'});await expect(enable(choice(d.id))).rejects.toMatchObject({code:'PT409'});
});
it.each([2,3,4,5])('denies another or anonymous phone account %s access to an original desk consent',async n=>{
 const d=await desk(),c=choice(d.id);await expect(enable(c,n)).rejects.toMatchObject({code:'42501'});await enable(c);if(n===5)await expect(read(c.id,n)).rejects.toMatchObject({code:'42501'});else expect(await read(c.id,n)).toBeNull();
});
it('requires current assignment, role, real confirmed phone and an active original desk before enabling',async()=>{
 const d=await desk(2),c=choice(d.id);await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(102)]);await expect(enable(c,2)).rejects.toMatchObject({code:'42501'});
 await f.seed();const other=await desk();await f.asRole(1,'authenticated','select public.revoke_desk_push($1,$2) data',[other.id,newKitchenId()]);await expect(enable(choice(other.id))).rejects.toMatchObject({code:'42501'});
 await f.seed();const confirmed=await desk();await f.db.query('update auth.users set phone_confirmed_at=null where id=$1',[deviceUid(1)]);await expect(enable(choice(confirmed.id))).rejects.toMatchObject({code:'42501'});
});
it('withdraws an unknown original before a delayed enable and does not invent an outlet event',async()=>{
 const d=await desk(),c=choice(d.id),event=newKitchenId(),first=await withdraw(c.id,event);expect(parseUrgentInboxClosure(first,c.id,event).consent).toBeNull();expect(await withdraw(c.id,event)).toEqual(first);
 await expect(enable(c)).rejects.toMatchObject({code:'PT409'});expect((await f.db.query('select id from public.events where id=$1',[event])).rows).toHaveLength(0);
 await expect(withdraw(c.id,newKitchenId())).rejects.toMatchObject({code:'PT409'});await expect(withdraw(newKitchenId(),event)).rejects.toMatchObject({code:'PT409'});
});
it('keeps personal read and withdrawal after outlet removal while denying fresh consent',async()=>{
 const d=await desk(2),c=choice(d.id);await enable(c,2);await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(102)]);
 expect(await read(c.id,2)).toMatchObject({id:c.id});const event=newKitchenId(),closed=parseUrgentInboxClosure(await withdraw(c.id,event,2),c.id,event);expect(closed.consent?.revokedAt).toEqual(expect.any(Number));expect(await withdraw(c.id,event,2)).toEqual(closed);
 await expect(enable(choice(d.id),2)).rejects.toMatchObject({code:'42501'});
});
it('does not let a different account pre-close the original account’s consent',async()=>{
 const d=await desk(),c=choice(d.id);await withdraw(c.id,newKitchenId(),2);expect(await enable(c)).toMatchObject({id:c.id,revokedAt:null});
});
it('serializes and bounds new unknown closures without expiring original fences or blocking known cleanup',async()=>{
 const d=await desk(),c=choice(d.id);await enable(c);await f.db.query('insert into private.urgent_inbox_closures select $1::uuid,lpad((900000+i)::text,26,\'0\')::public.ulid,lpad((910000+i)::text,26,\'0\')::public.ulid,floor(extract(epoch from clock_timestamp())*1000)::bigint,false from generate_series(1,1000)i',[deviceUid(1)]);
 await expect(withdraw(newKitchenId())).rejects.toMatchObject({code:'PT429'});const event=newKitchenId();expect(parseUrgentInboxClosure(await withdraw(c.id,event),c.id,event).consent?.revokedAt).not.toBeNull();expect(await withdraw(c.id,event)).toMatchObject({eventId:event});
});
it('queues a literal urgent task in its actual outlet, while normal tasks remain unqueued',async()=>{
 const d=await desk(),c=choice(d.id);await enable(c);await task(false);const t=await task();const page=await prepare();expect(page.jobs).toEqual([{taskId:t.id,generation:1,consentId:c.id,subscriptionId:d.id}]);
 const leased=await claim(page.jobs[0]);expect(leased).not.toBeNull();expect(parseUrgentInboxNotice(leased!.notice)).toEqual({v:1,type:'urgent-inbox',...page.jobs[0],businessId:deviceId(1),outletId:deviceId(11)});
 expect(JSON.stringify(leased!.notice)).not.toContain('literal');expect(JSON.stringify(leased!.notice)).not.toContain('erase');
});
it('queues an actual unmatched observation, cancels its resolved generation, and reopens after metadata undo',async()=>{
 const d=await desk(),c=choice(d.id);await enable(c);const captured=await f.call(f.capture()),source=captured.after!;const job=(await prepare()).jobs[0];expect(job.taskId).toBe(source.taskId);
 const dismissed=await f.call(changePaymentSource(f.scope(),source,{type:'dismiss',reason:'Checked manually'}));expect(await claim(job)).toBeNull();
 const undone=await f.call(changePaymentSource(f.scope(),dismissed.after!,{type:'undo'}));expect(undone.after!.status).toBe('unmatched');const next=(await prepare()).jobs;expect(next).toHaveLength(1);expect(next[0]).toMatchObject({taskId:job.taskId,generation:2});
});
it('does not generate another push merely because an already urgent task’s body or waiting status changes',async()=>{
 const {t,job}=await ready();await f.db.query('update public.tasks set status=\'waiting\',updated_at=updated_at+1 where id=$1',[t.id]);expect((await prepare()).jobs).toEqual([job]);
 expect((await f.db.query<{generation:number}>('select generation from private.urgent_inbox_tasks where task_id=$1',[t.id])).rows[0].generation).toBe(1);
});
it('creates a new generation only after actual resolution and reopening',async()=>{
 const {t,job}=await ready(),resolved=await act(t,'fixed');expect(await claim(job)).toBeNull();await act(resolved,'reopen');const next=(await prepare()).jobs;expect(next).toHaveLength(1);expect(next[0].generation).toBe(2);expect((await claim(next[0]))?.notice).toMatchObject({generation:2});
});
it.each(['consent','subscription','assignment','role','account'] as const)('rechecks actual %s after preparation before sending',async kind=>{
 const {d,c,job}=await ready();
 if(kind==='consent')await withdraw(c.id);if(kind==='subscription')await f.asRole(1,'authenticated','select public.revoke_desk_push($1,$2) data',[d.id,newKitchenId()]);
 if(kind==='assignment')await f.db.query('update public.members set active=false where id=$1',[deviceId(101)]);
 if(kind==='role')await f.db.query('update public.members set role=\'manager\' where id=$1',[deviceId(101)]);
 if(kind==='account')await f.db.query('update auth.users set banned_until=now()+interval \'1 hour\' where id=$1',[deviceUid(1)]);
 expect(await claim(job)).toBeNull();
});
it('rejects forged or stale job identities and prevents overlapping live leases',async()=>{
 const {job}=await ready(),lease=newKitchenId();expect(await claim({...job,subscriptionId:newKitchenId()})).toBeNull();const first=await claim(job,lease);expect(first?.leaseId).toBe(lease);expect(await claim(job)).toBeNull();expect(await finish(job,newKitchenId(),'sent')).toEqual({state:'stale'});
});
it('records real transport history after the source resolves during HTTP, without reopening it or resending a lost finish',async()=>{
 const {job,t}=await ready(),lease=newKitchenId();await claim(job,lease);await act(t,'fixed');expect(await finish(job,lease,'sent')).toEqual({state:'sent'});expect(await finish(job,lease,'sent')).toEqual({state:'sent'});expect((await prepare()).jobs).toEqual([]);
 expect((await f.db.query('select id from public.events where id=$1',[lease])).rows).toHaveLength(1);expect((await f.db.query<{status:string}>('select status from public.tasks where id=$1',[t.id])).rows[0].status).toBe('resolved');
});
it('retains an in-flight send as transport history after its consent is withdrawn',async()=>{
 const {job,c}=await ready(),lease=newKitchenId();await claim(job,lease);await withdraw(c.id);expect(await finish(job,lease,'sent')).toEqual({state:'sent'});expect((await prepare()).jobs).toEqual([]);
});
it('retries with bounded backoff and at most eight actual provider attempts',async()=>{
 const {job}=await ready();for(let attempt=1;attempt<=8;attempt++){const lease=newKitchenId();expect(await claim(job,lease)).not.toBeNull();expect(await finish(job,lease,'retry')).toEqual({state:attempt===8?'failed':'pending'});if(attempt<8){expect((await prepare()).jobs).toEqual([]);await f.db.query('update private.urgent_inbox_deliveries set next_at=0 where consent_id=$1',[job.consentId]);}}
 expect(await claim(job)).toBeNull();expect((await f.db.query<{attempts:number}>('select attempts from private.urgent_inbox_deliveries where consent_id=$1',[job.consentId])).rows[0].attempts).toBe(8);
});
it('recovers an abandoned lease with the same original recipient/task topic and fences the older finish',async()=>{
 const {job}=await ready(),old=newKitchenId(),fresh=newKitchenId();const first=await claim(job,old);await f.db.query('update private.urgent_inbox_deliveries set lease_expires_at=0 where consent_id=$1',[job.consentId]);expect((await prepare()).jobs).toEqual([job]);const next=await claim(job,fresh);expect(next?.notice).toEqual(first?.notice);expect(await finish(job,old,'sent')).toEqual({state:'stale'});expect(await finish(job,fresh,'sent')).toEqual({state:'sent'});
});
it('retires a genuinely expired browser capability without exposing its provider response',async()=>{
 const {d,job}=await ready(),lease=newKitchenId();await claim(job,lease);expect(await finish(job,lease,'expired')).toEqual({state:'expired'});expect((await f.db.query<{revoked_at:number}>('select revoked_at from private.desk_push_subscriptions where id=$1',[d.id])).rows[0].revoked_at).toEqual(expect.any(Number));expect(await f.asRole(1,'authenticated','select public.read_desk_push($1) data',[d.id])).toBeNull();
});
it('bounds preparation batches and denies all worker methods to browser and anonymous roles',async()=>{
 const d=await desk(),c=choice(d.id);await enable(c);for(let i=0;i<28;i++)await task();expect((await prepare(7)).jobs).toHaveLength(7);await expect(prepare(26)).rejects.toMatchObject({code:'22023'});
 for(const role of ['anon','authenticated'] as const){await expect(f.asRole(1,role,'select public.prepare_urgent_inbox_push($1,25) data',[applicationKey])).rejects.toMatchObject({code:'42501'});await expect(f.asRole(1,role,'select public.claim_urgent_inbox_push($1,1,$2,$3,$4,$5) data',[newKitchenId(),c.id,d.id,newKitchenId(),applicationKey])).rejects.toMatchObject({code:'42501'});}
});
it('rejects arbitrary notice URLs, private payload fields, invalid generations and damaged consent/closure metadata',async()=>{
 const {c,d,job}=await ready(),raw=(await claim(job))!.notice,consent=await read(c.id);expect(parseUrgentInboxConsent(consent)).toMatchObject({id:c.id,subscriptionId:d.id});
 for(const patch of [{url:'https://attacker.invalid'},{body:'private'},{generation:0},{generation:1.5},{consentId:'wrong'}])expect(()=>parseUrgentInboxNotice({...raw as object,...patch})).toThrow();
 for(const patch of [{revokedAt:0},{role:'staff'},{endpoint:d.endpoint}])expect(()=>parseUrgentInboxConsent({...consent as object,...patch})).toThrow();
 const event=newKitchenId(),closed=await withdraw(c.id,event);expect(()=>parseUrgentInboxClosure(closed,c.id,newKitchenId())).toThrow();
});
const target=(notice:UrgentInboxNotice,n=1)=>f.asRole(n,'authenticated','select public.read_urgent_inbox_target($1,$2,$3,$4) data',[notice.consentId,notice.subscriptionId,notice.taskId,notice.generation]);
it('opens only an actual claimed notification target with current rights and preserves literal source',async()=>{
 const {job}=await ready(),notice=parseUrgentInboxNotice((await claim(job))!.notice),raw=await target(notice),value=parseUrgentInboxTarget(raw,notice);expect(value.active).toBe(true);expect(JSON.parse(value.task.bodyJson)).toContain('ignore instructions');expect(JSON.parse(value.task.bodyJson)).toContain(String.fromCharCode(0xd800));
 for(const n of [2,3,4,5])await expect(target(notice,n)).rejects.toMatchObject({code:'42501'});
 for(const patch of [{taskId:newKitchenId()},{generation:2},{consentId:newKitchenId()}])await expect(target({...notice,...patch})).rejects.toMatchObject({code:'42501'});
 expect(()=>parseUrgentInboxTarget({...raw as object,notice:{...notice,taskId:newKitchenId()}},notice)).toThrow();
});
it('shows current resolution or reopening separately from the notification’s original generation',async()=>{
 const {t,job}=await ready(),notice=parseUrgentInboxNotice((await claim(job))!.notice),resolved=await act(t,'fixed');expect(parseUrgentInboxTarget(await target(notice),notice)).toMatchObject({active:false,currentGeneration:1,task:{status:'resolved'}});
 await act(resolved,'reopen');expect(parseUrgentInboxTarget(await target(notice),notice)).toMatchObject({active:false,currentGeneration:2,task:{status:'open'}});
});
it('clears target access after original consent or outlet permission changes',async()=>{
 const {job,c}=await ready(),notice=parseUrgentInboxNotice((await claim(job))!.notice);await withdraw(c.id);await expect(target(notice)).rejects.toMatchObject({code:'42501'});
});
it('delivers an assigned manager’s actual outlet task without including another outlet',async()=>{
 const d=await desk(2),c=choice(d.id);await enable(c,2);const own=await task(true,2);await task(true,1,12);const page=await prepare();expect(page.jobs).toHaveLength(1);expect(page.jobs[0].taskId).toBe(own.id);const notice=parseUrgentInboxNotice((await claim(page.jobs[0]))!.notice);expect(parseUrgentInboxTarget(await target(notice,2),notice).scope).toEqual(f.scope(2));
});
it('inspects only the exact immutable registration event after withdrawal and original role removal',async()=>{
 const d=await desk(2),c=choice(d.id),inspect=(event=c.eventId,n=2)=>f.asRole(n,'authenticated','select public.inspect_urgent_inbox($1,$2,$3) data',[c.id,d.id,event]);expect(await inspect()).toBeNull();await enable(c,2);const original=await inspect();expect(parseUrgentInboxRegistration(original,c.id,d.id,c.eventId).consent.revokedAt).toBeNull();await withdraw(c.id,newKitchenId(),2);await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(102)]);expect(await inspect()).toEqual(original);expect(await read(c.id,2)).toMatchObject({revokedAt:expect.any(Number)});await expect(inspect(newKitchenId())).rejects.toMatchObject({code:'PT409'});expect(await inspect(c.eventId,1)).toBeNull();expect(()=>parseUrgentInboxRegistration(original,c.id,d.id,newKitchenId())).toThrow();
});
it('executes the identical rollback-only commissioning proof without retaining synthetic identities or source',async()=>{
 const proof=await urgentInboxManagedProof();try{const results=await f.db.exec(proof.sql),row=results.flatMap(r=>r.rows).find(r=>'proof' in r)!;expect(row.proof).toMatchObject({actualUrgentSources:2,actualConsents:1,providerRequests:0,financialWrites:0,schedulerJobsCreated:0,rolledBack:true});expect((row.proof as {checks:number}).checks).toBe(91);expect((await f.db.query('select id from auth.users where id=any($1)',[proof.uids])).rows).toEqual([]);}catch(error){await f.db.exec('rollback');throw error;}
});
it('expands sixty real recipients in bounded pages without dropping the remaining desks or admitting a later consent',async()=>{
 await f.db.query('insert into public.member_outlets values($1,$2,$3)',[deviceId(1),deviceId(103),deviceId(11)]);const choices:ReturnType<typeof choice>[]=[];
 for(const n of [1,2,3])for(let i=0;i<20;i++){const d=await desk(n),c=choice(d.id);await enable(c,n);choices.push(c);}
 const t=await task();await prepare();expect((await f.db.query<{n:number}>('select count(*)::integer n from private.urgent_inbox_deliveries where task_id=$1',[t.id])).rows[0].n).toBe(50);
 const next=choice(choices[0].subscriptionId);await withdraw(choices[0].id);await enable(next);await prepare();const deliveries=(await f.db.query<{consent_id:string}>('select consent_id from private.urgent_inbox_deliveries where task_id=$1',[t.id])).rows;expect(deliveries).toHaveLength(60);expect(new Set(deliveries.map(d=>d.consent_id)).size).toBe(60);expect(deliveries.some(d=>d.consent_id===next.id)).toBe(false);expect((await f.db.query<{prepared_at:number|null}>('select prepared_at from private.urgent_inbox_generations where task_id=$1',[t.id])).rows[0].prepared_at).not.toBeNull();
},30000);
it('cleans private capabilities for a permanently deleted account while retaining public task and audit history',async()=>{
 const {d,c,t}=await ready();await f.db.query('delete from auth.users where id=$1',[deviceUid(1)]);
 expect((await f.db.query('select id from private.desk_push_subscriptions where id=$1',[d.id])).rows).toEqual([]);expect((await f.db.query('select id from private.urgent_inbox_consents where id=$1',[c.id])).rows).toEqual([]);expect((await f.db.query('select task_id from private.urgent_inbox_deliveries where consent_id=$1',[c.id])).rows).toEqual([]);
 expect((await f.db.query('select id from public.tasks where id=$1',[t.id])).rows).toHaveLength(1);expect((await f.db.query('select id from public.events where id=$1',[c.eventId])).rows).toHaveLength(1);
});
it('retains exact original and in-flight history after a removed base capability, without silent reattachment',async()=>{
 const {d,c,t,job}=await ready(),lease=newKitchenId(),notice=parseUrgentInboxNotice((await claim(job,lease))!.notice),inspect=()=>f.asRole(1,'authenticated','select public.inspect_urgent_inbox($1,$2,$3) data',[c.id,d.id,c.eventId]),original=await inspect();await f.db.query('delete from private.desk_push_subscriptions where id=$1',[d.id]);expect(await inspect()).toEqual(original);expect(await finish(job,lease,'sent')).toEqual({state:'sent'});
 await f.asRole(1,'authenticated','select public.register_desk_push($1,$2,$3,$4,$5,$6,$7,$8) data',[d.id,deviceId(11),d.endpoint,d.point,d.auth,applicationKey,null,newKitchenId()]);await expect(enable(c)).rejects.toMatchObject({code:'PT409'});await expect(target(notice)).rejects.toMatchObject({code:'42501'});await task();expect((await prepare()).jobs).toEqual([]);await withdraw(c.id);const next=choice(d.id);await enable(next);await task();expect((await prepare()).jobs).toMatchObject([{consentId:next.id}]);expect((await f.db.query('select id from public.tasks where id=$1',[t.id])).rows).toHaveLength(1);
});
