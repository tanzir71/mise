import {afterEach,expect,it,vi} from 'vitest';
import {createDeviceAccessHandler,createDeviceAccessStore,type DeviceAccessStore} from '../supabase/functions/_shared/device-access-handler';
import {deviceSecretHash,deviceVerification,deviceLifetime,deviceSessionLifetime} from '../packages/core/device-access';
const id=(n:number)=>String(n).padStart(26,'0'),secret='D'.repeat(43),session='S'.repeat(43),origin='https://shop.test';
const store=():DeviceAccessStore=>({request:vi.fn(async()=>null),poll:vi.fn(async()=>null),directory:vi.fn(async()=>null),session:vi.fn(async()=>null),logout:vi.fn(async()=>null),reset:vi.fn(async()=>null)});
const device={id:id(5),businessId:id(1),outletId:id(2),name:'Kitchen',mode:'kitchen',createdAt:1000,expiresAt:1000+deviceLifetime,revokedAt:null};
function request(body:unknown={action:'directory',after:null,limit:50},headers:Record<string,string>={},method='POST'){return new Request('https://api.test/device-access',{method,headers:{Origin:origin,Authorization:'Bearer '+secret,'Content-Type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
afterEach(()=>{vi.useRealTimers();});
it('rejects a missing/malformed device credential, foreign origin and non-POST before privileged work',async()=>{
 const service=store(),handler=createDeviceAccessHandler({store:service,origins:new Set([origin])});
 for(const authorization of ['',secret,'Bearer '+secret+'.suffix'])expect((await handler(request(undefined,{Authorization:authorization}))).status).toBe(401);
 expect((await handler(request(undefined,{Origin:'https://foreign.test'}))).status).toBe(403);expect((await handler(request(undefined,{},'GET'))).status).toBe(405);expect((await handler(request(undefined,{},'OPTIONS'))).status).toBe(204);for(const fn of Object.values(service))expect(fn).not.toHaveBeenCalled();
});
it('rejects caller roles, permissions, arbitrary scope and hashes rather than forwarding them to SQL',async()=>{
 const service=store(),handler=createDeviceAccessHandler({store:service,origins:new Set([origin])});
 for(const input of [{action:'request',id:id(5),code:'123456',pairingId:null,tokenHash:'a'.repeat(64)},{action:'request',id:id(5),code:'12345',pairingId:null},{action:'poll',id:id(5),approved:true},{action:'directory',after:null,limit:101},{action:'directory',after:null,limit:50,outletId:id(2)},{action:'session',sessionToken:session,permissions:['owner']},{action:'logout',sessionToken:'bad'},{action:'unknown'},'{bad'])expect((await handler(request(input))).status).toBe(400);
 expect((await handler(request(' '.repeat(2049)))).status).toBe(413);expect((await handler(request(undefined,{'Content-Type':'text/plain'}))).status).toBe(415);for(const fn of Object.values(service))expect(fn).not.toHaveBeenCalled();
});
it('derives the request hash from the bearer, returns only the original receipt and never issues a device credential',async()=>{
 const service=store(),hash=await deviceSecretHash(secret),receipt={v:1,id:id(5),verification:deviceVerification(hash),expiresAt:5000};service.request=vi.fn(async()=>receipt);
 const response=await createDeviceAccessHandler({store:service,origins:new Set([origin])})(request({action:'request',id:id(5),code:'123456',pairingId:id(6)}));expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);expect(service.request).toHaveBeenCalledExactlyOnceWith(id(5),'123456',id(6),hash);expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('a pairing response cannot substitute another request identity or verification',async()=>{
 for(const receipt of [{v:1,id:id(7),verification:'0000-0000-0000-0000',expiresAt:5000},{v:1,id:id(5),verification:'0000-0000-0000-0000',expiresAt:5000}]){const service=store();service.request=async()=>receipt;expect((await createDeviceAccessHandler({store:service,origins:new Set([origin])})(request({action:'request',id:id(5),code:'123456',pairingId:null}))).status).toBe(503);}
});
it('pairing polling cannot expose another device or extra credentials',async()=>{
 const service=store();service.poll=async()=>({v:1,id:id(5),state:'approved',device,outletNameJson:'"Shop"'});const handler=createDeviceAccessHandler({store:service,origins:new Set([origin])});expect((await handler(request({action:'poll',id:id(5)}))).status).toBe(200);
 service.poll=async()=>({v:1,id:id(5),state:'approved',device:{...device,id:id(6)},outletNameJson:'"Shop"'});expect((await handler(request({action:'poll',id:id(5)}))).status).toBe(503);
});
it('directory responses retain literal names and reject hidden contact or proof fields',async()=>{
 const service=store(),name='বাংলা'+String.fromCharCode(0,0xd800),page={v:1,device,outletNameJson:'"Shop"',members:[{id:id(7),nameJson:JSON.stringify(name)}],next:null};service.directory=async()=>page;
 const handler=createDeviceAccessHandler({store:service,origins:new Set([origin])}),response=await handler(request());expect(response.status).toBe(200);expect(await response.json()).toEqual(page);
 service.directory=async()=>({...page,members:[{...page.members[0],phone:'PRIVATE'}]});expect((await handler(request())).status).toBe(503);
});
it('live sessions cannot gain owner roles, counter privileges in kitchen mode or duplicate permission claims',async()=>{
 const service=store(),access={v:1,sessionId:id(8),deviceId:id(5),businessId:id(1),outletId:id(2),memberId:id(7),role:'kitchen',mode:'kitchen',permissions:['orders.acknowledge','orders.read','orders.ready'],expiresAt:1000+deviceSessionLifetime};service.session=async()=>access;const handler=createDeviceAccessHandler({store:service,origins:new Set([origin])});expect((await handler(request({action:'session',sessionToken:session}))).status).toBe(200);
 for(const patch of [{role:'owner'},{permissions:['counter.sell']},{permissions:['orders.read','orders.read']},{authUserId:'PRIVATE'}]){service.session=async()=>({...access,...patch});expect((await handler(request({action:'session',sessionToken:session}))).status).toBe(503);}
});
it('logout accepts only the scoped server outcome and keeps credentials out of responses/errors',async()=>{
 const service=store();service.logout=vi.fn(async()=>({sessionId:id(8),signedOut:true}));const handler=createDeviceAccessHandler({store:service,origins:new Set([origin]),newId:()=>id(9)}),response=await handler(request({action:'logout',sessionToken:session}));expect(response.status).toBe(200);expect(await response.json()).toEqual({sessionId:id(8),signedOut:true});expect(service.logout).toHaveBeenCalledExactlyOnceWith(secret,session,id(9));
 service.logout=async()=>{throw Error('PRIVATE '+secret+' '+session);};const failed=await handler(request({action:'logout',sessionToken:session}));expect(failed.status).toBe(503);expect(await failed.text()).toBe('{"error":"Screen access is unavailable. Keep the original request and try again."}');
});
it('the service adapter uses only fixed POST RPCs; server keys and device credentials never enter URLs',async()=>{
 const send=vi.fn<typeof fetch>(async()=>new Response('null')),api=createDeviceAccessStore('https://screen.test','sb_secret_test_only',send);await api.request(id(5),'123456',id(6),'a'.repeat(64));await api.poll(id(5),secret);await api.directory(secret,null,50);await api.session(secret,session);await api.logout(secret,session,id(9));
 expect(send.mock.calls.map(([url])=>String(url).split('/').at(-1))).toEqual(['request_device_pairing','read_device_pairing','read_device_signin','read_device_session','end_device_session']);
 for(const [url,options] of send.mock.calls){expect(String(url)).not.toContain(secret);expect(String(url)).not.toContain(session);expect(String(url)).not.toContain('sb_secret_');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_secret_test_only','Content-Type':'application/json'}});expect(options?.headers).not.toHaveProperty('Authorization');expect(options?.signal).toBeInstanceOf(AbortSignal);}
});
it('a stalled privileged response cannot outlive the original five-second RPC deadline',async()=>{
 vi.useFakeTimers();let cancelled=false;const api=createDeviceAccessStore('https://screen.test','sb_secret_test_only',async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))),work=api.session(secret,session);const checked=expect(work).rejects.toThrow('Screen access deadline');await vi.advanceTimersByTimeAsync(5000);await checked;expect(cancelled).toBe(true);
});
it('oversized/malformed responses and alternate API authorities fail without returning backend data',async()=>{
 for(const input of ['https://screen.test/path','https://u:p@screen.test','http://screen.test','https://screen.test/#fragment'])expect(()=>createDeviceAccessStore(input,'sb_secret_test_only')).toThrow();expect(()=>createDeviceAccessStore('https://screen.test','sb_publishable_test_only')).toThrow();
 for(const response of [()=>new Response('PRIVATE',{status:500}),()=>new Response('{bad'),()=>new Response(new Uint8Array(8000001))])await expect(createDeviceAccessStore('https://screen.test','sb_secret_test_only',async()=>response()).session(secret,session)).rejects.toThrow();
});
