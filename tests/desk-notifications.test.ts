import {createECDH,randomBytes} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {expect,it,vi,afterEach} from 'vitest';
import {createDeskNotificationsHandler,createDeskNotificationsStore,DeskPushDenied,type DeskNotificationsStore} from '../supabase/functions/_shared/desk-notifications-handler';
const id=(n:number)=>String(n).padStart(26,'0'),applicationKey=generateVAPIDKeys().publicKey,jwt='original.phone.signature';
const metadata={v:1,id:id(1),businessId:id(2),outletId:id(3),memberId:id(4),createdAt:1000,expiresAt:null,revokedAt:null};
const request=(input:unknown,headers:Record<string,string>={},method='POST')=>new Request('https://api.test/functions/v1/desk-notifications',{
 method,headers:{origin:'https://desk.test',authorization:'Bearer '+jwt,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(input)}:{})});
function fixture(key:string|undefined=applicationKey){
 const browser=createECDH('prime256v1');browser.generateKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-test-only',expirationTime:null,keys:{p256dh:browser.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const store={context:vi.fn<DeskNotificationsStore['context']>(async()=>({v:1,businessId:id(2),outletId:id(3),memberId:id(4),role:'owner'})),
  register:vi.fn<DeskNotificationsStore['register']>(async()=>metadata),read:vi.fn<DeskNotificationsStore['read']>(async()=>metadata),revoke:vi.fn<DeskNotificationsStore['revoke']>(async()=>({...metadata,revokedAt:2000}))};
 const registration={action:'register',id:id(1),outletId:id(3),eventId:id(5),applicationKey,subscription};
 return {store,subscription,registration,handler:createDeskNotificationsHandler({store,applicationKey:key,origins:new Set(['https://desk.test'])})};
}
afterEach(()=>vi.useRealTimers());
it('returns only the runtime public application key after the real scoped context read',async()=>{
 const f=fixture(),response=await f.handler(request({action:'configuration',outletId:id(3)}));expect(response.status).toBe(200);
 expect(await response.json()).toEqual({v:1,context:{v:1,businessId:id(2),outletId:id(3),memberId:id(4),role:'owner'},applicationKey});
 expect(f.store.context).toHaveBeenCalledWith(jwt,id(3));expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('access-control-allow-origin')).toBe('https://desk.test');
});
it('registers the exact original desk, event and endpoint under the caller JWT and excludes capabilities from its reply',async()=>{
 const f=fixture(),response=await f.handler(request(f.registration));expect(response.status).toBe(200);expect(await response.json()).toEqual(metadata);
 expect(f.store.register).toHaveBeenCalledWith(jwt,id(1),id(3),id(5),applicationKey,f.subscription);
});
it('rejects a stale application key before storing a capability',async()=>{
 const f=fixture(),response=await f.handler(request({...f.registration,applicationKey:generateVAPIDKeys().publicKey}));expect(response.status).toBe(409);expect(f.store.register).not.toHaveBeenCalled();
});
it('keeps read and original revocation available when VAPID configuration is unavailable',async()=>{
 const f=fixture('');expect((await f.handler(request({action:'configuration',outletId:id(3)}))).status).toBe(503);
 expect((await f.handler(request({action:'read',id:id(1)}))).status).toBe(200);expect((await f.handler(request({action:'revoke',id:id(1),eventId:id(5)}))).status).toBe(200);
 expect(f.store.revoke).toHaveBeenCalledWith(jwt,id(1),id(5));
});
it.each(['','Bearer sb_secret_not_a_phone_session','Bearer a.b.c extra'])('does not use missing or invalid original phone authorization: %s',async authorization=>{
 const f=fixture();expect((await f.handler(request({action:'read',id:id(1)},{authorization}))).status).toBe(401);expect(f.store.read).not.toHaveBeenCalled();
});
it('blocks foreign origins and offers a scoped preflight without authorizing data access',async()=>{
 const f=fixture();expect((await f.handler(request({action:'read',id:id(1)},{origin:'https://other.test'}))).status).toBe(403);
 const preflight=await f.handler(request(null,{},'OPTIONS'));expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe('https://desk.test');expect(f.store.read).not.toHaveBeenCalled();
});
it.each([{action:'configuration',outletId:id(3),memberId:id(4)},{action:'read',id:id(1),outletId:id(3)},{action:'revoke',id:id(1),eventId:id(1)},{action:'send',text:'PRIVATE MESSAGE'},{action:'read',id:'missing'}])('rejects extra identities, invalid IDs and caller-created messages: %j',async input=>{
 const f=fixture();expect((await f.handler(request(input))).status).toBe(400);expect(f.store.read).not.toHaveBeenCalled();expect(f.store.revoke).not.toHaveBeenCalled();
});
it('rejects arbitrary provider destinations and extra subscription fields before SQL',async()=>{
 const f=fixture();for(const subscription of [{...f.subscription,endpoint:'https://127.0.0.1/private'},{...f.subscription,owner:id(4)}])expect((await f.handler(request({...f.registration,subscription}))).status).toBe(400);
 expect(f.store.register).not.toHaveBeenCalled();
});
it('returns null when the original account no longer has an eligible subscription',async()=>{
 const f=fixture();f.store.read.mockResolvedValueOnce(null);expect(await (await f.handler(request({action:'read',id:id(1)}))).json()).toBeNull();
});
it.each([401,403,409,429] as const)('preserves safe authorization/conflict outcome %s without provider details',async status=>{
 const f=fixture();f.store.register.mockRejectedValueOnce(new DeskPushDenied(status));const response=await f.handler(request(f.registration));expect(response.status).toBe(status);const text=await response.text();expect(text).not.toMatch(/fcm|p256dh/);expect(text).not.toContain(jwt);
});
it('rejects a backend reply containing private capability or a different target',async()=>{
 const f=fixture();for(const result of [{...metadata,endpoint:f.subscription.endpoint},{...metadata,id:id(9)}]){
  f.store.register.mockResolvedValueOnce(result);const response=await f.handler(request(f.registration));expect(response.status).toBe(503);expect(await response.text()).not.toContain(f.subscription.endpoint);
 }
});
it('does not describe removal as complete when the actual metadata remains active',async()=>{
 const f=fixture();f.store.revoke.mockResolvedValueOnce(metadata);expect((await f.handler(request({action:'revoke',id:id(1),eventId:id(5)}))).status).toBe(503);
});
it('keeps privileged error bodies and original JWTs out of the response',async()=>{
 const f=fixture();f.store.context.mockRejectedValueOnce(Error('PRIVATE '+jwt));const response=await f.handler(request({action:'configuration',outletId:id(3)}));expect(response.status).toBe(503);const text=await response.text();expect(text).not.toContain('PRIVATE');expect(text).not.toContain(jwt);
});
it('forwards concurrent original JWTs independently using only the publishable API key',async()=>{
 const calls:{route:string;authorization:string|null;body:unknown}[]=[],send:typeof fetch=async(url,init)=>{const headers=new Headers(init?.headers);expect(headers.get('apikey')).toBe('sb_publishable_test_only');expect(init?.redirect).toBe('error');calls.push({route:new URL(String(url)).pathname,authorization:headers.get('authorization'),body:JSON.parse(String(init?.body))});return Response.json(null);};
 const store=createDeskNotificationsStore('https://rpc.test','sb_publishable_test_only',send);
 await Promise.all([store.context('first.phone.signature',id(3)),store.revoke('second.phone.signature',id(1),id(5))]);
 expect(calls).toEqual([{route:'/rest/v1/rpc/desk_push_context',authorization:'Bearer first.phone.signature',body:{p_outlet_id:id(3)}},{route:'/rest/v1/rpc/revoke_desk_push',authorization:'Bearer second.phone.signature',body:{p_id:id(1),p_event_id:id(5)}}]);
 expect(()=>createDeskNotificationsStore('https://rpc.test','sb_secret_not_publishable')).toThrow();
});
it('maps actual forbidden SQL HTTP without reading its private error body',async()=>{
 const store=createDeskNotificationsStore('https://rpc.test','sb_publishable_test_only',async()=>new Response('PRIVATE',{status:403}));await expect(store.context(jwt,id(3))).rejects.toMatchObject({status:403});
});
it('bounds hung RPC headers with the original request aborted',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;const send:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});};
 const pending=createDeskNotificationsStore('https://rpc.test','sb_publishable_test_only',send).context(jwt,id(3)),rejected=expect(pending).rejects.toThrow('unavailable');await vi.advanceTimersByTimeAsync(5000);await rejected;expect(signal?.aborted).toBe(true);
});
it('bounds and cancels an RPC response that stalls while streaming',async()=>{
 vi.useFakeTimers();let cancelled=false;const send:typeof fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
 const pending=createDeskNotificationsStore('https://rpc.test','sb_publishable_test_only',send).read(jwt,id(1)),rejected=expect(pending).rejects.toThrow('unavailable');await vi.advanceTimersByTimeAsync(5000);await rejected;expect(cancelled).toBe(true);
});
