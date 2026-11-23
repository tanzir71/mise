import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createStaffLinkDatabase} from './staff-link-fixture';
import {createStaffLinkHandler,createStaffLinkStore,staffLinkLimits} from '../supabase/functions/_shared/staff-link-handler';
import {parseStaffView,parseStaffPublicOutcome} from '../packages/core/staff-links';
import {newInboxId} from '../packages/core/inbox';
import {deviceId} from './device-pairing-fixture';
let f:Awaited<ReturnType<typeof createStaffLinkDatabase>>;
beforeAll(async()=>{f=await createStaffLinkDatabase();},30000);beforeEach(async()=>{await f.seed();await f.issue();});afterAll(async()=>{await f?.db.close();});
const body=(operation='read',intent:unknown=null)=>({token:f.token,operation,intent,after:null});
const req=(value:unknown,origin='https://shop.example.invalid',path='/functions/v1/public/staff')=>new Request('https://backend.example.invalid'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
const handler=()=>createStaffLinkHandler({store:{visit:(input,limits)=>f.visit(input,limits)},origins:new Set(['https://shop.example.invalid'])});
const intent=()=>({v:1 as const,id:newInboxId(),eventId:newInboxId(),memberId:deviceId(105),outletId:deviceId(11),type:'in' as const,occurredAt:Date.now(),expectedLastId:null});
it('reads and records an account-free staff check-in through the actual HTTP/SQL boundary',async()=>{
 const send=handler(),read=await send(req(body()));expect(read.status).toBe(200);expect(read.headers.get('Cache-Control')).toBe('no-store');expect(read.headers.get('Referrer-Policy')).toBe('no-referrer');
 const payload=await read.json();expect(parseStaffView(payload.view,null).memberId).toBe(deviceId(105));const original=intent(),applied=await send(req(body('submit',original)));expect(applied.status).toBe(200);expect(parseStaffPublicOutcome(await applied.json(),original).state).toBe('applied');
 expect(parseStaffView((await(await send(req(body()))).json()).view,null).latest?.id).toBe(original.id);
});
it('rejects wrong origins, selectors, oversized bodies and unsupported primitives before the store',async()=>{
 const store={visit:vi.fn()},send=createStaffLinkHandler({store,origins:new Set(['https://shop.example.invalid'])});
 expect((await send(req(body(),'https://other.example.invalid'))).status).toBe(403);
 expect((await send(req({...body(),memberId:deviceId(104)}))).status).toBe(400);
 expect((await send(req(body(),undefined,'/functions/v1/public/staff?member=other'))).status).toBe(400);
 expect((await send(req({...body('submit',intent()),extra:'x'.repeat(9000)}))).status).toBe(413);
 expect((await send(req(body('submit',{...intent(),method:'manual'})))).status).toBe(400);expect(store.visit).not.toHaveBeenCalled();
});
it('returns changed or missing without confirming an unrelated identity or revealing a revoked view',async()=>{
 const send=handler(),source={...intent(),memberId:deviceId(104)};expect((await send(req(body('submit',source)))).status).toBe(409);
 await f.db.exec('update private.staff_links set revoked_at=created_at');expect((await send(req(body()))).status).toBe(404);
});
it('counts read/inspection/closure work and propagates the actual bounded Retry-After',async()=>{
 const send=createStaffLinkHandler({store:{visit:(input,limits)=>f.visit(input,limits)},origins:new Set(['https://shop.example.invalid']),limits:{global:1000,link:1}});
 expect((await send(req(body()))).status).toBe(200);const response=await send(req(body('close',intent())));expect(response.status).toBe(429);expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
});
it('will not spread unexpected service metadata into the named public view',async()=>{
 const raw=await f.visit({token:f.token,operation:'read',intent:null,after:null});const store={visit:async()=>({...raw,view:{...(raw.view as object),privatePhone:'hidden'}})};
 const response=await createStaffLinkHandler({store,origins:new Set(['https://shop.example.invalid'])})(req(body()));expect(response.status).toBe(503);expect(await response.text()).not.toContain('hidden');
});
it('fixes the server RPC and limits and puts its credential only in the private request',async()=>{
 let captured:Request|undefined;const send:typeof fetch=async(input,init)=>{captured=new Request(input,init);return Response.json({v:1,state:'missing'});};
 const store=createStaffLinkStore('https://backend.example.invalid','sb_secret_test_only',send);await store.visit({token:f.token,operation:'read',intent:null,after:null},{global:777,link:33});
 expect(captured?.url).toBe('https://backend.example.invalid/rest/v1/rpc/visit_staff_link');expect(captured?.headers.get('apikey')).toBe('sb_secret_test_only');expect(captured?.credentials).toBe('omit');expect(captured?.redirect).toBe('error');
 expect(await captured!.json()).toEqual({p_token:f.token,p_operation:'read',p_intent:null,p_after:null,p_global_limit:777,p_link_limit:33});expect(staffLinkLimits()).toEqual({global:600,link:60});
 for(const value of ['0','-1','60001','2.5','abc'])expect(()=>staffLinkLimits(value)).toThrow();
});
