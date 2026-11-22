import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {kitchenDispatchFixture,type KitchenDispatchFixture} from './kitchen-dispatch-fixture';
import {createKitchenAlarmsHandler} from '../supabase/functions/_shared/kitchen-alarms-handler';
import {createKitchenDispatchHandler} from '../supabase/functions/_shared/kitchen-dispatch-handler';
let f:KitchenDispatchFixture;
beforeAll(async()=>{f=await kitchenDispatchFixture();},30000);
beforeEach(async()=>{await f.reset();});
afterAll(async()=>{await f?.close();});
const rows=async(table:string)=>{if(!['net.http_request_queue','cron.job','private.kitchen_dispatch_state','private.kitchen_alarm_retries'].includes(table))throw Error('Unexpected fixture table');return(await f.db.query<Record<string,unknown>>('select * from '+table)).rows;};

it('installs disabled with no extension or credential and can be disabled before provisioning',async()=>{
 const bare=await createPairingDatabase();try{
  expect((await bare.db.query<{data:unknown}>('select private.dispatch_kitchen_work() data')).rows[0].data).toEqual({state:'disabled'});
  expect((await bare.db.query<{data:unknown}>('select private.configure_kitchen_dispatch(false) data')).rows[0].data).toMatchObject({enabled:false});
  await expect(bare.db.query('select private.configure_kitchen_dispatch(true)')).rejects.toThrow('dependencies');
 }finally{await bare.db.close();}
});
it.each(['anon','authenticated','service_role'] as const)('does not expose scheduler control, grant ledger or private configuration to %s',async role=>{
 for(const query of ['select private.dispatch_kitchen_work() data','select private.configure_kitchen_dispatch(true) data','select private.read_kitchen_dispatch_status() data','select * from private.kitchen_dispatch_grants'])await expect(f.asRole(null,role,query)).rejects.toThrow();
 const access=await f.db.query<{allowed:boolean}>("select has_function_privilege($1,'private.kitchen_dispatch_configuration(uuid,uuid)','execute') allowed",[role]);expect(access.rows[0].allowed).toBe(false);
});
it('keeps private values out of Cron command metadata and performs zero HTTP enqueues across idle ticks',async()=>{
 await f.configure();for(let index=0;index<40;index++)expect(await f.dispatch()).toEqual({state:'idle'});
 expect(await rows('net.http_request_queue')).toEqual([]);const jobs=await rows('cron.job');expect(jobs).toMatchObject([{jobname:'mise-kitchen-dispatch',schedule:'1 second',command:'select private.dispatch_kitchen_work()'}]);
 expect(JSON.stringify(jobs)).not.toContain(f.key);expect(JSON.stringify(jobs)).not.toContain('worker.test');expect(JSON.stringify(jobs)).not.toContain('sb_publishable');
});
it('refuses API roles with SQL login and unsafe Vault reads before accepting private configuration',async()=>{
 await f.db.exec('alter role anon login');await expect(f.configure()).rejects.toThrow('role access');expect((await rows('private.kitchen_dispatch_state'))[0].enabled).toBe(false);expect(await rows('cron.job')).toEqual([]);
 await f.db.exec('alter role anon nologin;grant select on vault.decrypted_secrets to authenticated');await expect(f.configure()).rejects.toThrow('permissions');
});
it('rejects malformed private configuration without returning its original value',async()=>{
 for(const value of ['["PRIVATE"]','{"apiUrl":"https://worker.test/path","publishableKey":"sb_publishable_test_only"}','{"apiUrl":"https://worker.test","publishableKey":"sb_publishable_test_only","credential":"PRIVATE"}']){
  await f.db.query('update vault.secrets set secret=$1 where id=$2',[value,f.configId]);await expect(f.configure()).rejects.toThrow('configuration');expect(await rows('cron.job')).toEqual([]);
 }
});
it('does not overwrite or remove an unrelated Cron job with the same name',async()=>{
 await f.db.query('insert into cron.job(jobname,schedule,command,username) values($1,$2,$3,current_user)',['mise-kitchen-dispatch','30 seconds','select 42']);await expect(f.configure()).rejects.toThrow('Another scheduler');await expect(f.configure(false)).rejects.toThrow('Another scheduler');expect(await rows('cron.job')).toMatchObject([{command:'select 42'}]);
});
it('rolls queue and dispatch metadata back together, then enqueues the original due work on retry',async()=>{
 await f.configure();const order=await f.addOrder(),before=await f.currentOrder(order.id),sentinel=Error('rollback');
 try{await f.db.transaction(async tx=>{expect((await tx.query<{data:unknown}>('select private.dispatch_kitchen_work() data')).rows[0].data).toEqual({state:'queued'});throw sentinel;});}catch(error){if(error!==sentinel)throw error;}
 expect(await rows('net.http_request_queue')).toEqual([]);expect((await f.db.query('select * from private.kitchen_dispatch_grants')).rows).toEqual([]);expect((await rows('private.kitchen_dispatch_state'))[0].request_id).toBeNull();expect(await f.dispatch()).toEqual({state:'queued'});expect(await f.currentOrder(order.id)).toEqual(before);
 const queue=await rows('net.http_request_queue');expect(queue).toMatchObject([{url:'https://worker.test/functions/v1/kitchen-dispatch',timeout_milliseconds:40000}]);expect((queue[0].headers as Record<string,string>).Authorization).toMatch(/^Bearer v1\./);expect(JSON.stringify(queue)).not.toContain(f.key);expect(JSON.stringify(queue)).not.toContain('apikey');
 const visible=await f.asRole(1,'authenticated','select headers as data from net.http_request_queue');expect(visible).toEqual(queue[0].headers);expect(JSON.stringify(visible)).not.toContain(f.key);
});
it('counts a failed transport once while waiting and lets fresh ready work bypass its backoff',async()=>{
 await f.configure();await f.addOrder();await f.dispatch();const state=(await rows('private.kitchen_dispatch_state'))[0];
 await f.db.query("insert into net._http_response(id,status_code,timed_out) values($1,503,false)",[state.request_id]);await f.db.exec('update private.kitchen_dispatch_state set queued_at=floor(extract(epoch from clock_timestamp())*1000)::bigint-1100,next_at=0');
 expect(await f.dispatch()).toEqual({state:'waiting'});expect(await f.dispatch()).toEqual({state:'waiting'});expect((await rows('private.kitchen_dispatch_state'))[0]).toMatchObject({failures:1,outcome:'retry'});expect(await rows('net.http_request_queue')).toHaveLength(1);
 await f.addOrder(2042);expect(await f.dispatch()).toEqual({state:'queued'});expect(await rows('net.http_request_queue')).toHaveLength(2);expect((await rows('private.kitchen_dispatch_state'))[0].failures).toBe(0);
});
it('stops unauthorized transport without erasing any original work or notification choice',async()=>{
 await f.configure();const order=await f.addOrder();await f.dispatch();const state=(await rows('private.kitchen_dispatch_state'))[0];await f.db.query('insert into net._http_response(id,status_code,timed_out) values($1,401,false)',[state.request_id]);await f.db.exec('update private.kitchen_dispatch_state set queued_at=0');
 expect(await f.dispatch()).toEqual({state:'unavailable'});expect((await rows('private.kitchen_dispatch_state'))[0]).toMatchObject({enabled:false,outcome:'unauthorized'});expect(await f.signature()).not.toBeNull();expect((await f.currentOrder(order.id)).status).toBe('accepted');
});
it('disables and resumes its own fixed job without dropping due work',async()=>{
 await f.configure();const order=await f.addOrder();await f.configure(false);expect(await f.dispatch()).toEqual({state:'disabled'});expect(await rows('cron.job')).toEqual([]);expect(await f.signature()).not.toBeNull();await f.configure();expect(await f.dispatch()).toEqual({state:'queued'});expect((await f.currentOrder(order.id)).status).toBe('accepted');
});
it('rejects request-selected scope, clocks, messages, foreign origins and wrong authorization before SQL',async()=>{
 for(const request of [await f.request({orderId:deviceId(1)}),await f.request({clock:0}),await f.request({message:'PRIVATE'}),await f.request({limit:0}),await f.request({limit:26}),new Request(await f.request(),{headers:{'Content-Type':'application/json',Authorization:'Bearer '+'B'.repeat(43)}}),new Request(await f.request(),{headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.key,origin:'https://desk.test'}})])expect((await f.handler(request)).status).toBeGreaterThanOrEqual(400);
 expect(f.rpc).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
});
it('executes the committed due request through actual SQL and Web Push encryption within one coordinated tick',async()=>{
 await f.configure();await f.register();const order=await f.addOrder(),before=await f.currentOrder(order.id),start=performance.now();expect(await f.dispatch()).toEqual({state:'queued'});const response=await f.bridge();expect(response.status).toBe(200);
 const result=await response.json();expect(result).toMatchObject({v:1,alarms:{raised:1,failed:0},push:{sent:1,failed:0},unconfirmedBatches:0});expect(performance.now()-start).toBeLessThan(5000);expect(f.packets).toHaveLength(1);expect(f.packets[0].headers.get('content-encoding')).toBe('aes128gcm');
 const body=Buffer.from(await f.packets[0].arrayBuffer()).toString('latin1');expect(body).not.toContain('PRIVATE CUSTOMER');expect(body).not.toContain('PRIVATE SOURCE');expect((await f.currentOrder(order.id)).payment).toEqual(before.payment);expect((await f.currentOrder(order.id)).total).toBe(before.total);
 expect(await f.dispatch()).toEqual({state:'idle'});expect(await rows('net.http_request_queue')).toEqual([]);
});
it('retains a failed inspection barrier while backoff leaves unrelated new alarms and deliveries available',async()=>{
 await f.register();const old=await f.addOrder();const alarmHandler=createKitchenAlarmsHandler({key:f.key,store:f.alarms});expect((await alarmHandler(f.internalRequest())).status).toBe(200);expect((await f.push.prepare(f.vapid.publicKey,25) as {jobs:unknown[]}).jobs).toHaveLength(1);
 await f.db.query('update public.orders set lines=$1 where id=$2',[JSON.stringify(old.lines.map(line=>({...line,note:'Changed preparation'}))),old.id]);const prepared=await f.alarms.prepare(25) as {jobs:{businessId:string;outletId:string;orderId:string;version:number;stamp:string}[]},source=prepared.jobs[0];
 expect(await f.alarms.defer!(source)).toMatchObject({state:'deferred',attempts:1});expect((await f.push.prepare(f.vapid.publicKey,25) as {jobs:unknown[]}).jobs).toEqual([]);expect(await f.signature()).toBeNull();expect(await rows('private.kitchen_alarm_retries')).toHaveLength(1);
 const fresh=await f.addOrder(2042),response=await f.handler(await f.request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({alarms:{raised:1},push:{sent:1}});expect(f.packets).toHaveLength(1);expect((await f.currentOrder(fresh.id)).status).toBe('accepted');
});
it('does not let a late failed attempt postpone newer order content and clears a previous failure on actual progress',async()=>{
 const order=await f.addOrder(),prepared=await f.alarms.prepare(25) as {jobs:{businessId:string;outletId:string;orderId:string;version:number;stamp:string}[]},source=prepared.jobs[0];await f.alarms.defer!(source);
 await f.db.query('update public.orders set lines=$1 where id=$2',[JSON.stringify(order.lines.map(line=>({...line,note:'New source'}))),order.id]);expect(await rows('private.kitchen_alarm_retries')).toEqual([]);expect(await f.alarms.defer!(source)).toEqual({state:'stale'});expect(await f.signature()).not.toBeNull();expect((await f.handler(await f.request())).status).toBe(200);
});
it.each([{status:201,state:'sent',sent:1,skipped:0},{status:503,state:'cancelled',sent:0,skipped:1}])('a genuine Got it closes the task during in-flight HTTP $status without changing money or scheduling another delivery',async expected=>{
 await f.register();const order=await f.addOrder(),before=await f.currentOrder(order.id);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});f.transport.mockImplementation(async()=>{entered();await gate;return new Response(null,{status:expected.status});});
 const pending=f.handler(await f.request());try{
  await started;await f.acknowledge(order.id);release();const response=await pending;expect(response.status).toBe(200);expect(await response.json()).toMatchObject({push:{sent:expected.sent,skipped:expected.skipped,retried:0,failed:0}});
  const after=await f.currentOrder(order.id);expect(after.payment).toEqual(before.payment);expect(after.total).toBe(before.total);expect((await f.db.query<{n:number}>("select count(*)::int n from public.tasks where status='open'")).rows[0].n).toBe(0);
  // A provider's genuine acceptance is transport history, not an ACK. A
  // failed in-flight request is cancelled rather than retried after Got it.
  expect((await f.db.query<{state:string}>('select state from private.kitchen_push_deliveries')).rows[0].state).toBe(expected.state);
  expect((await f.handler(await f.request())).status).toBe(200);expect(await f.signature()).toBeNull();expect(f.transport).toHaveBeenCalledOnce();
 }finally{release();await pending;}
});
it('does not invent processed recipients when push preparation fails but still retains confirmed alarm outcomes',async()=>{
 await f.addOrder();const handler=createKitchenDispatchHandler({key:f.key,applicationKey:f.vapid.publicKey,alarms:f.alarms,push:{...f.push,prepare:vi.fn(async()=>{throw Error('PRIVATE');})},send:async()=> 'sent'}),response=await handler(await f.request());expect(response.status).toBe(503);const result=await response.json();expect(result.alarms).toMatchObject({raised:1,failed:0});expect(result.push).toMatchObject({processed:0,sent:0,failed:0});expect(result.unconfirmedBatches).toBeGreaterThan(0);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('delivers a genuinely raised task while an unrelated later inspection is still held',async()=>{
 await f.register();await f.addOrder();const second=await f.addOrder(2042);let release!:()=>void,held=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 const handler=createKitchenDispatchHandler({key:f.key,applicationKey:f.vapid.publicKey,alarms:{...f.alarms,finish:async work=>{if(work.orderId===second.id){held=true;await gate;}return f.alarms.finish(work);}},push:f.push,send:async()=>{await f.transport('https://provider.test');return 'sent';}}),pending=handler(await f.request());
 try{
  await expect.poll(()=>held&&f.transport.mock.calls.length===1,{timeout:4000}).toBe(true);
  expect((await f.db.query<{n:number}>("select count(*)::int n from public.tasks where status='open'")).rows[0].n).toBe(1);release();const response=await pending;expect(response.status).toBe(200);expect(await response.json()).toMatchObject({alarms:{raised:2},push:{sent:2},unconfirmedBatches:0});expect(f.transport).toHaveBeenCalledTimes(2);
 }finally{release();await pending;}
});
it('keeps failed inspection work due and backs it off without inventing a task or blocking independent work',async()=>{
 await f.register();const first=await f.addOrder(),second=await f.addOrder(2042);const handler=createKitchenDispatchHandler({key:f.key,applicationKey:f.vapid.publicKey,alarms:{...f.alarms,finish:async work=>{if(work.orderId===first.id)throw Error('PRIVATE inspection failure');return f.alarms.finish(work);}},push:f.push,send:async()=> 'sent'}),response=await handler(await f.request());
 expect(response.status).toBe(503);const result=await response.json();expect(result).toMatchObject({alarms:{raised:1,failed:1},push:{sent:1,failed:0}});expect(JSON.stringify(result)).not.toContain('PRIVATE');
 expect(await rows('private.kitchen_alarm_retries')).toMatchObject([{order_id:first.id,attempts:1}]);expect((await f.db.query<{next_at:number}>('select next_at from private.kitchen_alarm_work where order_id=$1',[first.id])).rows[0].next_at).not.toBeNull();expect((await f.db.query<{order_id:string}>('select order_id from private.kitchen_alarm_tasks')).rows).toEqual([{order_id:second.id}]);
});
it('stops starting inspections and claims at the shared deadline while leaving unstarted originals due',async()=>{
 const first=await f.addOrder(),second=await f.addOrder(2042),now=Date.now();let elapsed=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now+elapsed);
 try{
  const finish=vi.fn(f.alarms.finish),handler=createKitchenDispatchHandler({key:f.key,applicationKey:f.vapid.publicKey,alarms:{...f.alarms,finish:async work=>{const outcome=await finish(work);elapsed=10001;return outcome;}},push:f.push,send:async()=> 'sent'}),response=await handler(await f.request());
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({alarms:{processed:1,raised:1,remaining:1},push:{processed:0}});expect(finish).toHaveBeenCalledOnce();expect(finish.mock.calls[0][0].orderId).toBe(first.id);expect((await f.db.query<{next_at:number}>('select next_at from private.kitchen_alarm_work where order_id=$1',[second.id])).rows[0].next_at).not.toBeNull();
 }finally{clock.mockRestore();}
 expect((await f.handler(await f.request())).status).toBe(200);expect(await f.signature()).toBeNull();
});
it('consumes a signed grant once and rejects its exact concurrent replay before another alarm inspection',async()=>{
 await f.register();await f.addOrder();const request=await f.request(),responses=await Promise.all([f.handler(request.clone()),f.handler(request.clone())]);expect(responses.map(response=>response.status).sort()).toEqual([200,409]);expect(f.transport).toHaveBeenCalledOnce();
 const claims=f.rpc.mock.calls.filter(([url])=>String(url).endsWith('/claim_kitchen_dispatch'));expect(claims).toHaveLength(2);expect(f.rpc.mock.calls.filter(([url])=>String(url).endsWith('/prepare_kitchen_alarms'))).toHaveLength(1);
 expect((await f.db.query<{n:number}>('select count(*)::int n from private.kitchen_dispatch_grants where consumed_at is not null')).rows[0].n).toBe(1);
});
it('requires a genuine private grant in addition to a valid HMAC and stops queued proofs after disable or reconfiguration',async()=>{
 const unissued=await f.request();await f.db.exec('truncate private.kitchen_dispatch_grants');expect((await f.handler(unissued)).status).toBe(409);
 const beforeDisable=await f.request();await f.configure(false);expect((await f.handler(beforeDisable.clone())).status).toBe(409);await f.configure();expect((await f.handler(beforeDisable.clone())).status).toBe(409);
 expect(f.rpc.mock.calls.every(([url])=>String(url).endsWith('/claim_kitchen_dispatch'))).toBe(true);
});
it('refuses changed batches and expired signed proofs before any database call',async()=>{
 const request=await f.request();expect((await f.handler(new Request(request.clone(),{body:'{"limit":1}'}))).status).toBe(401);
 const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now+60001);try{expect((await f.handler(request.clone())).status).toBe(401);}finally{clock.mockRestore();}expect(f.rpc).not.toHaveBeenCalled();
});
it('checks expiry again in SQL and denies direct anonymous grant consumption',async()=>{
 const request=await f.request(),parts=request.headers.get('authorization')!.split('.'),nonce=parts[2],issuedAt=Number(parts[1])-61000;
 await f.db.query('update private.kitchen_dispatch_grants set issued_at=$1::bigint,expires_at=$1::bigint+60000 where nonce=$2::uuid',[issuedAt,nonce]);expect(await f.alarms.claimDispatch!(nonce,issuedAt,25)).toBe(false);
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(null,role,'select public.claim_kitchen_dispatch($1,$2,$3) data',[nonce,issuedAt,25])).rejects.toThrow();
});
