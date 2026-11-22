import {createECDH,randomBytes} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {expect,it,vi,afterEach} from 'vitest';
import {createKitchenPushHandler,createKitchenPushStore,type KitchenPushStore,type KitchenPushJob} from '../supabase/functions/_shared/kitchen-push-handler';
const key='A'.repeat(43),applicationKey=generateVAPIDKeys().publicKey,id=(n:number)=>String(n).padStart(26,'0');
const job:KitchenPushJob={taskId:id(1),generation:1,subscriptionId:id(2)};
const request=(input:unknown={},headers:Record<string,string>={},method='POST')=>new Request('https://push.test/functions/v1/kitchen-push',{
 method,headers:{authorization:'Bearer '+key,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(input)}:{})});
function fixture(jobs:KitchenPushJob[]=[]){
 const browser=createECDH('prime256v1');browser.generateKeys();
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-test-only',expirationTime:null,keys:{p256dh:browser.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const store={prepare:vi.fn<KitchenPushStore['prepare']>(async()=>({v:1,at:1000,jobs})),claim:vi.fn<KitchenPushStore['claim']>(async(job,lease)=>({v:1,leaseId:lease,subscription,
  notice:{v:1,type:'kitchen-alarm',...job,businessId:id(3),outletId:id(4)}})),finish:vi.fn<KitchenPushStore['finish']>(async(_job,_lease,outcome)=>({state:outcome==='retry'?'pending':outcome}))};
 const send=vi.fn<(subscription:unknown,notice:unknown)=>Promise<'sent'|'expired'|'retry'>>(async()=> 'sent' as const);
 return {store,send,subscription,handler:createKitchenPushHandler({key,applicationKey,store,send})};
}
afterEach(()=>vi.useRealTimers());
it.each(['','Bearer '+'B'.repeat(43),'Bearer '+key+' extra'])('rejects invalid scheduler authorization before reading private recipients: %s',async authorization=>{
 const f=fixture(),response=await f.handler(request({}, {authorization}));expect(response.status).toBe(401);expect(f.store.prepare).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
});
it('rejects browser-origin invocation even with the internal credential',async()=>{
 const f=fixture();expect((await f.handler(request({}, {origin:'https://desk.test'}))).status).toBe(403);expect(f.store.prepare).not.toHaveBeenCalled();
});
it('requires POST and JSON without reading a recipient',async()=>{
 const f=fixture();expect((await f.handler(request({}, {},'GET'))).status).toBe(405);expect((await f.handler(request({}, {'Content-Type':'text/plain'}))).status).toBe(415);expect(f.store.prepare).not.toHaveBeenCalled();
});
it.each([{limit:0},{limit:26},{limit:1.5},{outletId:id(4)},{at:999999999},{message:'caller text'}])('rejects caller-selected scope, clock, text or an unbounded batch: %j',async input=>{
 const f=fixture();expect((await f.handler(request(input))).status).toBe(400);expect(f.store.prepare).not.toHaveBeenCalled();
});
it('returns counts only for an empty tick',async()=>{
 const f=fixture(),response=await f.handler(request({limit:3}));expect(response.status).toBe(200);expect(f.store.prepare).toHaveBeenCalledWith(applicationKey,3);
 expect(await response.json()).toEqual({v:1,processed:0,sent:0,expired:0,retried:0,skipped:0,failed:0,remaining:0});expect(response.headers.get('cache-control')).toBe('no-store');
});
it('finishes only the claimed original job and lease after the actual sender result',async()=>{
 const f=fixture([job]),response=await f.handler(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({processed:1,sent:1,failed:0});
 const lease=f.store.claim.mock.calls[0][1];expect(f.store.finish).toHaveBeenCalledWith(job,lease,'sent');expect(f.send).toHaveBeenCalledOnce();
});
it.each(['expired','retry'] as const)('retains the original recipient and records sender outcome %s',async outcome=>{
 const f=fixture([job]);f.send.mockResolvedValueOnce(outcome);expect(await (await f.handler(request())).json()).toMatchObject({processed:1,[outcome==='retry'?'retried':'expired']:1,failed:0});
 expect(f.store.finish).toHaveBeenCalledWith(job,f.store.claim.mock.calls[0][1],outcome);
});
it('does not send when the original SQL claim is no longer eligible',async()=>{
 const f=fixture([job]);f.store.claim.mockResolvedValueOnce(null);expect(await (await f.handler(request())).json()).toMatchObject({processed:1,skipped:1,sent:0});expect(f.send).not.toHaveBeenCalled();expect(f.store.finish).not.toHaveBeenCalled();
});
it('rejects duplicate prepared jobs before claiming or sending',async()=>{
 const f=fixture([job,job]),response=await f.handler(request());expect(response.status).toBe(503);expect(f.store.claim).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
});
it.each(['wrong task','extra private text','wrong lease'] as const)('does not send a malformed private claim: %s',async changed=>{
 const f=fixture([job]);f.store.claim.mockImplementationOnce(async(_job,lease)=>({v:1,leaseId:changed==='wrong lease'?id(9):lease,subscription:f.subscription,
  notice:{v:1,type:'kitchen-alarm',...job,businessId:id(3),outletId:id(4),...(changed==='wrong task'?{taskId:id(9)}:{}),...(changed==='extra private text'?{customer:'PRIVATE CUSTOMER'}:{})}}));
 const response=await f.handler(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');expect(f.send).not.toHaveBeenCalled();expect(f.store.finish).not.toHaveBeenCalled();
});
it('keeps privileged RPC and provider failures out of its response',async()=>{
 const f=fixture([job]);f.send.mockRejectedValueOnce(Error('PRIVATE '+key));const response=await f.handler(request());expect(response.status).toBe(503);expect(await response.text()).not.toMatch(/PRIVATE|AAAA|fcm/);expect(f.store.finish).not.toHaveBeenCalled();
});
it('bounds concurrent provider requests to four',async()=>{
 const jobs=Array.from({length:12},(_,i)=>({...job,subscriptionId:id(i+10)})),f=fixture(jobs);let active=0,maximum=0;
 f.send.mockImplementation(async()=>{active++;maximum=Math.max(active,maximum);await new Promise(resolve=>setTimeout(resolve,1));active--;return 'sent';});
 expect(await (await f.handler(request())).json()).toMatchObject({processed:12,sent:12,remaining:0});expect(maximum).toBe(4);
});
it('leaves unstarted jobs durable after the tick start budget expires',async()=>{
 vi.useFakeTimers();const jobs=Array.from({length:12},(_,i)=>({...job,subscriptionId:id(i+10)})),f=fixture(jobs);
 f.send.mockImplementation(async()=>{vi.setSystemTime(Date.now()+11000);return 'sent';});
 expect(await (await f.handler(request())).json()).toMatchObject({processed:4,sent:4,remaining:8});expect(f.store.claim).toHaveBeenCalledTimes(4);
});
it('keeps named RPC arguments, service credentials and current original identities in the server adapter',async()=>{
 const calls:{route:string;body:unknown}[]=[],send:typeof fetch=async(url,init)=>{expect(init).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_secret_test_only'}});calls.push({route:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});return Response.json(null);};
 const store=createKitchenPushStore('https://rpc.test','sb_secret_test_only',send),lease=id(8);await store.prepare(applicationKey,3);await store.claim(job,lease,applicationKey);await store.finish(job,lease,'sent');
 expect(calls).toEqual([{route:'/rest/v1/rpc/prepare_kitchen_push',body:{p_application_key:applicationKey,p_limit:3}},
  {route:'/rest/v1/rpc/claim_kitchen_push',body:{p_task_id:job.taskId,p_generation:1,p_subscription_id:job.subscriptionId,p_lease_id:lease,p_application_key:applicationKey}},
  {route:'/rest/v1/rpc/finish_kitchen_push',body:{p_task_id:job.taskId,p_generation:1,p_subscription_id:job.subscriptionId,p_lease_id:lease,p_outcome:'sent'}}]);
});
it('bounds an RPC that never returns headers and aborts its request',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;const send:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});};
 const pending=createKitchenPushStore('https://rpc.test','sb_secret_test_only',send).prepare(applicationKey,3),rejected=expect(pending).rejects.toThrow('unavailable');await vi.advanceTimersByTimeAsync(5000);await rejected;expect(signal?.aborted).toBe(true);
});
it('bounds and cancels a successful HTTP response whose body stalls',async()=>{
 vi.useFakeTimers();let cancelled=false;const send:typeof fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
 const pending=createKitchenPushStore('https://rpc.test','sb_secret_test_only',send).prepare(applicationKey,3),rejected=expect(pending).rejects.toThrow('unavailable');await vi.advanceTimersByTimeAsync(5000);await rejected;expect(cancelled).toBe(true);
});
it('rejects an oversized RPC body without returning its contents',async()=>{
 const send:typeof fetch=async()=>new Response('PRIVATE'.repeat(20000));await expect(createKitchenPushStore('https://rpc.test','sb_secret_test_only',send).prepare(applicationKey,3)).rejects.toThrow('unavailable');
});
