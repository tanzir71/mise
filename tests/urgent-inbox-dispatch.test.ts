import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createDecipheriv,hkdfSync,createHash} from 'node:crypto';
import {urgentInboxDispatchFixture} from './urgent-inbox-dispatch-fixture';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {newKitchenId} from '../packages/core/kitchen';
import {parseUrgentInboxNotice,parseUrgentInboxTarget} from '../packages/core/urgent-inbox';
let f:Awaited<ReturnType<typeof urgentInboxDispatchFixture>>;
beforeAll(async()=>{f=await urgentInboxDispatchFixture();},30000);
beforeEach(async()=>{await f.reset();});
afterAll(async()=>{await f?.db.close();});
async function ready(){const subscription=await f.register();await f.configure();const consent=await f.consent(subscription);return {subscription,consent};}
const rows=(table:string)=>f.db.query<Record<string,unknown>>('select * from '+table).then(r=>r.rows);
function decrypt(body:Buffer){const salt=body.subarray(0,16),sender=body.subarray(21,21+body[20]),encrypted=body.subarray(21+body[20]);const shared=f.browser.computeSecret(sender),ikm=Buffer.from(hkdfSync('sha256',shared,f.auth,Buffer.concat([Buffer.from('WebPush: info\0'),f.browser.getPublicKey(),sender]),32)),cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);const decipher=createDecipheriv('aes-128-gcm',Buffer.from(cek),Buffer.from(nonce));decipher.setAuthTag(encrypted.subarray(-16));const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);expect(plain.at(-1)).toBe(2);return parseUrgentInboxNotice(JSON.parse(plain.subarray(0,-1).toString()));}

it('installs no job or credential and can remain disabled without platform extensions',async()=>{
 const bare=await createPairingDatabase();try{expect((await bare.db.query<{data:unknown}>('select private.dispatch_urgent_inbox_work() data')).rows[0].data).toEqual({state:'disabled'});expect((await bare.db.query<{data:unknown}>('select private.configure_urgent_inbox_dispatch(false) data')).rows[0].data).toMatchObject({enabled:false});await expect(bare.db.query('select private.configure_urgent_inbox_dispatch(true)')).rejects.toThrow('dependencies');}finally{await bare.db.close();}
});
it.each(['anon','authenticated','service_role'] as const)('denies scheduler controls and private grant/config tables to %s',async role=>{
 for(const query of ['select private.dispatch_urgent_inbox_work() data','select private.configure_urgent_inbox_dispatch(true) data','select private.read_urgent_inbox_dispatch_status() data','select * from private.urgent_inbox_dispatch_grants','select * from private.urgent_inbox_dispatch_state'])await expect(f.asRole(null,role,query)).rejects.toMatchObject({code:'42501'});
 for(const name of ['urgent_inbox_dispatch_state','urgent_inbox_dispatch_grants'])expect((await f.db.query<{forced:boolean}>('select relforcerowsecurity forced from pg_class where oid=$1::regclass',['private.'+name])).rows[0].forced).toBe(true);
});
it('records only a fixed one-second Cron command and performs no HTTP on repeated idle ticks',async()=>{
 await f.configure();for(let n=0;n<20;n++)expect(await f.dispatch()).toEqual({state:'idle'});expect(await rows('net.http_request_queue')).toEqual([]);
 const jobs=await rows('cron.job');expect(jobs).toMatchObject([{jobname:'mise-urgent-inbox',schedule:'1 second',command:'select private.dispatch_urgent_inbox_work()'}]);for(const secret of [f.key,'worker.test','sb_secret'])expect(JSON.stringify(jobs)).not.toContain(secret);
});
it('refuses unsafe private configuration or a competing Cron job without overwriting it',async()=>{
 await f.db.query('insert into cron.job(jobname,schedule,command,username) values($1,$2,$3,current_user)',['mise-urgent-inbox','30 seconds','select 42']);await expect(f.configure()).rejects.toThrow('Another scheduler');await expect(f.configure(false)).rejects.toThrow('Another scheduler');expect(await rows('cron.job')).toMatchObject([{command:'select 42'}]);
 await f.db.exec('truncate cron.job;grant select on vault.decrypted_secrets to authenticated');await expect(f.configure()).rejects.toThrow('permissions');
});
it('atomically rolls back the queued request, one-use grant and scheduler state',async()=>{
 await ready();await f.task();const sentinel=Error('rollback');try{await f.db.transaction(async tx=>{expect((await tx.query<{data:unknown}>('select private.dispatch_urgent_inbox_work() data')).rows[0].data).toEqual({state:'queued'});throw sentinel;});}catch(error){if(error!==sentinel)throw error;}
 expect(await rows('net.http_request_queue')).toEqual([]);expect(await rows('private.urgent_inbox_dispatch_grants')).toEqual([]);expect((await rows('private.urgent_inbox_dispatch_state'))[0].request_id).toBeNull();expect(await f.dispatch()).toEqual({state:'queued'});
});
it('carries an actual task from committed one-use queue proof through independent browser decryption to its authenticated target',async()=>{
 const {consent,subscription}=await ready(),task=await f.task();expect(await f.dispatch()).toEqual({state:'queued'});const queued=await f.queued();expect(queued).toMatchObject({url:'https://worker.test/functions/v1/urgent-inbox-push',timeout_milliseconds:10000});expect(queued.headers.Authorization).toMatch(/^Bearer v1\./);expect(JSON.stringify(queued)).not.toContain(f.key);expect(JSON.stringify(queued)).not.toContain('apikey');
 // The actual hosted Net extension can expose queued headers through platform
 // defaults. Even this intentionally permissive adapter receives no reusable key.
 const visible=await f.asRole(1,'authenticated','select headers data from net.http_request_queue');expect(visible).toEqual(queued.headers);expect(JSON.stringify(visible)).not.toContain(f.key);
 const response=await f.bridge();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({sent:1,processed:1,failed:0});expect(f.packets).toHaveLength(1);
 const packet=f.packets[0],headers=packet.request.headers,body=Buffer.from(await packet.request.arrayBuffer()),notice=decrypt(body);expect(notice).toEqual({v:1,type:'urgent-inbox',consentId:consent.id,subscriptionId:subscription,businessId:deviceId(1),outletId:deviceId(11),taskId:task.id,generation:1});expect(headers.get('Content-Encoding')).toBe('aes128gcm');expect(headers.get('Topic')).toBe(createHash('sha256').update(['mise.urgent.v1',consent.id,task.id,1].join(':')).digest('base64url').slice(0,32));expect(body.toString()).not.toContain('PRIVATE CUSTOMER');
 // Includes a full one-second polling budget; this is local queue/encryption
 // admission with synthetic Net/provider, not hosted/browser delivery acceptance.
 expect(packet.at-task.createdAt+1000).toBeLessThan(5000);
 const opened=await f.target(notice);expect(opened.status).toBe(200);expect(parseUrgentInboxTarget(await opened.json(),notice).task.bodyJson).toBe(task.bodyJson);
});
it('consumes the exact queued grant once and rejects replay before any additional SQL work',async()=>{
 await ready();await f.task();await f.dispatch();const queued=await f.queued(),request=new Request(queued.url,{method:'POST',headers:queued.headers,body:queued.body as BodyInit});expect((await f.handler(request.clone())).status).toBe(200);f.rpc.mockClear();expect((await f.handler(request)).status).toBe(409);expect(f.rpc.mock.calls).toHaveLength(1);expect(String(f.rpc.mock.calls[0][0])).toContain('/claim_urgent_inbox_dispatch');expect(f.packets).toHaveLength(1);
});
it.each([{key:'D'.repeat(43)},{at:Date.now()-120000},{at:Date.now()+120000},{purpose:'mise:kitchen-dispatch:v1'}])('rejects an invalid signature, clock or foreign purpose before SQL: %s',async patch=>{
 await f.configure();const request=await f.request(25,patch);f.rpc.mockClear();expect((await f.handler(request)).status).toBe(401);expect(f.rpc).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
});
it('requires an actual private grant and rejects a changed body limit or browser origin',async()=>{
 await f.configure();expect((await f.handler(await f.request(25,{grant:false}))).status).toBe(409);const original=await f.request(),headers=new Headers(original.headers);f.rpc.mockClear();expect((await f.handler(new Request(original.url,{method:'POST',headers,body:'{"limit":24}'}))).status).toBe(401);headers.set('Origin','https://desk.test');expect((await f.handler(new Request(original.url,{method:'POST',headers,body:'{}'}))).status).toBe(403);expect(f.rpc).not.toHaveBeenCalled();
});
it('does not send a task resolved after enqueue but before worker inspection',async()=>{
 await ready();const task=await f.task();await f.dispatch();await f.resolve(task);const response=await f.bridge();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({sent:0});expect(f.transport).not.toHaveBeenCalled();
});
it('keeps an in-flight transport receipt when the actual task resolves during provider HTTP',async()=>{
 await ready();const task=await f.task();await f.dispatch();f.transport.mockImplementationOnce(async()=>{await f.resolve(task);return new Response(null,{status:201});});expect((await f.bridge()).status).toBe(200);expect(await f.admin('select status data from public.tasks where id=$1',[task.id])).toBe('resolved');expect(await f.admin("select count(*)::integer data from public.events where command='inbox.push.sent'")).toBe(1);expect(await f.dispatch()).toEqual({state:'idle'});
});
it('records provider retry without echoing its body and preserves durable work',async()=>{
 await ready();await f.task();await f.dispatch();f.transport.mockResolvedValueOnce(new Response('PRIVATE PROVIDER DETAIL',{status:503}));const response=await f.bridge(),text=await response.text();expect(response.status).toBe(200);expect(JSON.parse(text)).toMatchObject({retried:1,sent:0});expect(text).not.toContain('PRIVATE');expect((await rows('private.urgent_inbox_deliveries'))[0]).toMatchObject({state:'pending',attempts:1,last_outcome:'retry'});
});
it('does not resend after a lost successful finish reply when the actual receipt is already recorded',async()=>{
 await ready();await f.task();await f.dispatch();const real=f.rpc.getMockImplementation()!,wrapper:typeof fetch=async(url,init)=>{const response=await real(url,init);if(String(url).endsWith('/finish_urgent_inbox_push'))return new Response(null,{status:503});return response;};f.rpc.mockImplementation(wrapper);const response=await f.bridge();expect(response.status).toBe(503);expect(f.transport).toHaveBeenCalledTimes(1);expect((await rows('private.urgent_inbox_deliveries'))[0].state).toBe('sent');expect(await f.dispatch()).toEqual({state:'idle'});
});
it('keeps only counts and generic errors when SQL becomes unavailable',async()=>{
 await ready();await f.task();const request=await f.request();f.rpc.mockResolvedValueOnce(new Response('PRIVATE SQL CONFIGURATION',{status:503}));const response=await f.handler(request);expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');expect(f.transport).not.toHaveBeenCalled();
});
it('allows original read and withdrawal while runtime delivery is off and VAPID is absent',async()=>{
 const {consent}=await ready();expect((await f.owner({action:'read',id:consent.id},1,false,'')).status).toBe(200);expect((await f.owner({action:'register',id:newKitchenId(),subscriptionId:consent.value.subscriptionId,eventId:newKitchenId()},1,false,'')).status).toBe(503);const eventId=newKitchenId(),closed=await f.owner({action:'withdraw',id:consent.id,eventId},1,false,'');expect(closed.status).toBe(200);expect(await closed.json()).toMatchObject({id:consent.id,eventId,consent:{revokedAt:expect.any(Number)}});
});
it('forwards only original owner JWT and publishable key, returns public configuration, and denies foreign accounts',async()=>{
 await f.configure();const config=await f.owner({action:'configuration',outletId:deviceId(11)});expect(config.status).toBe(200);expect(await config.json()).toEqual({v:1,context:{v:1,businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(101),role:'owner'},applicationKey:f.vapid.publicKey});
 const subscription=await f.register(),id=newKitchenId(),eventId=newKitchenId();expect((await f.owner({action:'register',id,subscriptionId:subscription,eventId},2)).status).toBe(403);const allowed=await f.owner({action:'register',id,subscriptionId:subscription,eventId});expect(allowed.status).toBe(200);expect(JSON.stringify(await allowed.json())).not.toContain('auth_user');
});
it('retains unknown withdrawal identity across lost replies and denies its delayed enable',async()=>{
 const subscription=await f.register(),id=newKitchenId(),eventId=newKitchenId(),input={action:'withdraw',id,eventId};const first=await f.owner(input);expect(first.status).toBe(200);expect(await(await f.owner(input)).json()).toEqual(await first.json());expect((await f.owner({action:'register',id,subscriptionId:subscription,eventId:newKitchenId()})).status).toBe(409);
});
it('rejects request-selected messages, arbitrary targets and inconsistent response metadata',async()=>{
 expect((await f.owner({action:'register',id:newKitchenId(),subscriptionId:newKitchenId(),eventId:newKitchenId(),message:'erase'})).status).toBe(400);expect((await f.owner({action:'target',notice:{url:'https://attacker.invalid'}})).status).toBe(400);
 const subscription=await f.register();f.rpc.mockResolvedValueOnce(Response.json({v:1,id:newKitchenId(),subscriptionId:subscription,businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(101),role:'owner',createdAt:1,revokedAt:null}));expect((await f.owner({action:'register',id:newKitchenId(),subscriptionId:subscription,eventId:newKitchenId()})).status).toBe(503);
});
it('stops unauthorized transport and lets the installation disable or resume only its own fixed job',async()=>{
 await ready();await f.task();await f.dispatch();const state=(await rows('private.urgent_inbox_dispatch_state'))[0];await f.db.query('insert into net._http_response(id,status_code,timed_out) values($1,401,false)',[state.request_id]);await f.db.exec('update private.urgent_inbox_dispatch_state set queued_at=0');expect(await f.dispatch()).toEqual({state:'unavailable'});expect((await rows('private.urgent_inbox_dispatch_state'))[0]).toMatchObject({enabled:false,outcome:'unauthorized'});await f.configure(false);expect(await rows('cron.job')).toEqual([]);await f.configure();expect(await f.dispatch()).toEqual({state:'queued'});
});
