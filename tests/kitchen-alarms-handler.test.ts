import {expect,it,vi,afterEach} from 'vitest';
import {createKitchenAlarmsHandler,createKitchenAlarmsStore,type KitchenAlarmsStore} from '../supabase/functions/_shared/kitchen-alarms-handler';
const key='A'.repeat(43);
const request=(input:unknown={},headers:Record<string,string>={},method='POST')=>new Request('https://alarms.test/functions/v1/kitchen-alarms',{
 method,headers:{authorization:'Bearer '+key,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(input)}:{})});
const empty=()=>({prepare:vi.fn(async()=>({v:1,at:1000,jobs:[]})),finish:vi.fn(async()=>({state:'due',raised:true}))});
afterEach(()=>vi.useRealTimers());
it.each(['','Bearer '+'B'.repeat(43),'Bearer '+key+' extra'])('rejects an unauthorized scheduler before accessing shop data: %s',async authorization=>{
 const store=empty(),response=await createKitchenAlarmsHandler({key,store})(request({}, {authorization}));expect(response.status).toBe(401);expect(store.prepare).not.toHaveBeenCalled();
});
it('rejects browser-origin invocation even with the scheduler key',async()=>{
 const store=empty(),response=await createKitchenAlarmsHandler({key,store})(request({}, {origin:'https://desk.test'}));expect(response.status).toBe(403);expect(store.prepare).not.toHaveBeenCalled();
});
it.each([{limit:0},{limit:51},{limit:1.5},{outletId:'caller-scope'},{limit:2,at:999999999}])('rejects caller clock, scope or unbounded batch: %j',async input=>{
 const store=empty(),response=await createKitchenAlarmsHandler({key,store})(request(input));expect(response.status).toBe(400);expect(store.prepare).not.toHaveBeenCalled();
});
it('reports counts for an empty tick and retains no credential in the response',async()=>{
 const store=empty(),response=await createKitchenAlarmsHandler({key,store})(request({limit:3}));expect(response.status).toBe(200);expect(await response.json()).toEqual({v:1,processed:0,raised:0,stale:0,failed:0});
 expect(store.prepare).toHaveBeenCalledWith(3);expect(response.headers.get('cache-control')).toBe('no-store');
});
it('keeps privileged RPC failures out of the scheduler response',async()=>{
 const store:KitchenAlarmsStore={prepare:async()=>{throw Error('PRIVATE SQL '+key);},finish:async()=>null};
 const response=await createKitchenAlarmsHandler({key,store})(request());expect(response.status).toBe(503);const body=await response.text();expect(body).not.toContain('PRIVATE');expect(body).not.toContain(key);
});
it('does not finish a malformed source and reports its durable work as failed',async()=>{
 const store=empty();store.prepare.mockResolvedValueOnce({v:1,at:1000,jobs:[{unexpected:'private'}]} as never);
 const response=await createKitchenAlarmsHandler({key,store})(request());expect(response.status).toBe(503);expect(store.finish).not.toHaveBeenCalled();expect(await response.json()).toMatchObject({failed:1,processed:0});
});
it('requires a separate full-length scheduler credential at startup',()=>{expect(()=>createKitchenAlarmsHandler({key:'short',store:empty()})).toThrow();});
it('bounds a hung RPC without allowing a redirect',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 const send:typeof fetch=async(_url,options)=>{expect(options?.redirect).toBe('error');signal=options?.signal??undefined;return new Promise(()=>{});};
 const pending=createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',send).prepare(25);const result=expect(pending).rejects.toThrow('unavailable');
 await vi.advanceTimersByTimeAsync(5000);await result;expect(signal?.aborted).toBe(true);
});
it('bounds a response whose body stalls after valid HTTP headers',async()=>{
 vi.useFakeTimers();let cancelled=false;const send:typeof fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
 const pending=createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',send).prepare(25),result=expect(pending).rejects.toThrow('unavailable');
 await vi.advanceTimersByTimeAsync(5000);await result;expect(cancelled).toBe(true);
});
