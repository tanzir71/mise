import {afterEach,expect,it,vi} from 'vitest';
import {createKitchenRecoveryHandler,createKitchenRecoveryStore} from '../supabase/functions/_shared/kitchen-recovery-handler';
import {newKitchenId,prepareKitchenAction} from '../packages/core/kitchen';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
const origin='https://desk.test';
afterEach(()=>vi.useRealTimers());
async function fixture(){
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),original={action,sessionId:f.session.id,memberId:f.session.memberId};
 const pending={v:1,access:f.access,at:f.now,original,outcome:'pending',receipt:null,closure:null};
 const recover=vi.fn(async()=>pending as unknown),handler=createKitchenRecoveryHandler({origins:new Set([origin]),store:{recover}});
 const body={action:'lookup',sessionToken:f.session.token,original};
 function request(value:unknown=body,headers:Record<string,string>={},method='POST'){
  return new Request('https://api.test/functions/v1/kitchen-recovery',{method,headers:{origin,Authorization:'Bearer '+'D'.repeat(43),'Content-Type':'application/json',...headers},...(method==='POST'?{body:typeof value==='string'?value:JSON.stringify(value)}:{})});
 }
 const resolution={id:newKitchenId(),sessionId:f.session.id,memberId:f.session.memberId,occurredAt:f.now};
 return {...f,action,original,pending,body,resolution,recover,handler,request};
}
it('returns only a closed pending contract with current scoped read access and no private credentials',async()=>{
 const f=await fixture(),response=await f.handler(f.request());expect(response.status).toBe(200);expect(await response.json()).toEqual(f.pending);
 expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('access-control-allow-origin')).toBe(origin);
 expect(f.recover).toHaveBeenCalledWith('D'.repeat(43),f.session.token,f.original,null);
});
const requestGuards:{label:string;method:string;status:number;headers:Record<string,string>}[]=[{label:'preflight',method:'OPTIONS',status:204,headers:{}},{label:'method',method:'GET',status:405,headers:{}},
 {label:'foreign origin',method:'POST',status:403,headers:{origin:'https://foreign.test'}},{label:'missing secret',method:'POST',status:401,headers:{Authorization:''}},
 {label:'bad secret',method:'POST',status:401,headers:{Authorization:'Bearer bad'}},{label:'JSON',method:'POST',status:415,headers:{'Content-Type':'text/plain'}}];
it.each(requestGuards)('$label guard runs before SQL',async({method,status,headers})=>{
 const f=await fixture(),response=await f.handler(f.request(f.body,headers,method));expect(response.status).toBe(status);expect(f.recover).not.toHaveBeenCalled();
});
it.each(['{broken',' '.repeat(2049)])('rejects malformed or oversized input before SQL',async body=>{
 const f=await fixture(),response=await f.handler(f.request(body));expect(response.status).toBe(body.startsWith('{')?400:413);expect(f.recover).not.toHaveBeenCalled();
});
it('validates the exact close request and sends no caller-selected authority or preparation write',async()=>{
 const f=await fixture();await f.handler(f.request({...f.body,action:'close',resolution:f.resolution}));
 expect(f.recover).toHaveBeenCalledWith('D'.repeat(43),f.session.token,f.original,f.resolution);
 for(const patch of [{memberId:newKitchenId()},{access:f.access},{outletId:f.access.outletId},{resolution:null},{original:{...f.original,total:0}}]){
  f.recover.mockClear();const response=await f.handler(f.request({...f.body,...patch}));expect(response.status).toBe(400);expect(f.recover).not.toHaveBeenCalled();
 }
});
it('rejects malformed close identities and added status or financial mutations',async()=>{
 const f=await fixture();for(const resolution of [{...f.resolution,id:f.action.id},{...f.resolution,occurredAt:1.2},{...f.resolution,memberId:'other'},
  {...f.resolution,status:'ready'},{...f.resolution,total:0}]){expect((await f.handler(f.request({...f.body,action:'close',resolution}))).status).toBe(400);}
 expect(f.recover).not.toHaveBeenCalled();
});
it('a live denial returns no original source or provider diagnostics',async()=>{
 const f=await fixture();f.recover.mockResolvedValue(null);const response=await f.handler(f.request());expect(response.status).toBe(401);expect(await response.text()).not.toContain(f.action.id);
});
it('a malformed or mismatched backend outcome cannot confirm or close the original tap',async()=>{
 const f=await fixture();for(const patch of [{token:'PRIVATE'},{outcome:'accepted',receipt:{}},{original:{...f.original,sessionId:newKitchenId()}},
  {access:{...f.access,permissions:[]}}, {receipt:{id:f.action.id}}]){f.recover.mockResolvedValue({...f.pending,...patch});const response=await f.handler(f.request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');}
});
it('network diagnostics and server-key values stay out of handler errors',async()=>{
 const f=await fixture();f.recover.mockRejectedValue(Error('sb_secret_private_example https://private-provider.test'));
 const response=await f.handler(f.request());expect(response.status).toBe(503);expect(await response.text()).not.toMatch(/sb_secret_|private-provider/);
});
it('uses the exact named SQL arguments and a fixed RPC with a header-only service key',async()=>{
 const f=await fixture(),calls:{url:string;init:RequestInit}[]=[],store=createKitchenRecoveryStore('https://rpc.test','sb_secret_test_only',async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json(f.pending);});
 expect(await store.recover('D'.repeat(43),f.session.token,f.original,f.resolution)).toEqual(f.pending);
 expect(calls[0].url).toBe('https://rpc.test/rest/v1/rpc/recover_kitchen_tap');expect(calls[0].init.headers).toEqual({apikey:'sb_secret_test_only','Content-Type':'application/json'});
 expect(JSON.parse(calls[0].init.body as string)).toEqual({p_device_token:'D'.repeat(43),p_session_token:f.session.token,p_original:f.original,p_resolution:f.resolution});
});
it.each([400,409,500])('maps upstream %s to a generic closed error without its response details',async status=>{
 const f=await fixture(),store=createKitchenRecoveryStore('https://rpc.test','sb_secret_test_only',async()=>new Response('PRIVATE SQL source',{status}));
 const handler=createKitchenRecoveryHandler({origins:new Set([origin]),store}),response=await handler(f.request());expect(response.status).toBe(status===500?503:409);expect(await response.text()).not.toContain('PRIVATE');
});
it('bounds upstream bytes and rejects incomplete or invalid UTF-8 response data',async()=>{
 const f=await fixture();for(const response of [new Response('x'.repeat(16385)),new Response(new Uint8Array([255,254])),new Response(null)]){
  const handler=createKitchenRecoveryHandler({origins:new Set([origin]),store:createKitchenRecoveryStore('https://rpc.test','sb_secret_test_only',async()=>response)});
  expect((await handler(f.request())).status).toBe(503);
 }
});
it('aborts the fixed upstream request at its existing five-second deadline',async()=>{
 const f=await fixture();vi.useFakeTimers();let signal:AbortSignal|undefined;
 const store=createKitchenRecoveryStore('https://rpc.test','sb_secret_test_only',async(_url,init)=>{signal=init!.signal as AbortSignal;return new Promise<Response>(()=>{});});
 const outcome=expect(store.recover('D'.repeat(43),f.session.token,f.original,null)).rejects.toMatchObject({status:503});
 await vi.advanceTimersByTimeAsync(5001);await outcome;expect(signal?.aborted).toBe(true);
});
