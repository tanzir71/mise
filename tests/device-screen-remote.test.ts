import {afterEach,expect,it,vi} from 'vitest';
import {createDeviceScreenRemote,DeviceScreenRequestError} from '../apps/web/src/data/device-screen-remote';
import {assertCommandReceipt} from '../apps/web/src/data/command-request';
import {deviceLifetime,deviceSessionLifetime,deviceSecretHash,deviceVerification} from '../packages/core/device-access';
const id=(n:number)=>String(n).padStart(26,'0'),token='D'.repeat(43),connection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'},device={id:id(5),businessId:id(1),outletId:id(2),name:'Kitchen',mode:'kitchen' as const,createdAt:1000,expiresAt:1000+deviceLifetime,revokedAt:null},session={id:id(8),token:'S'.repeat(43),deviceId:id(5),memberId:id(7),createdAt:1001,expiresAt:1001+deviceSessionLifetime};
const response=(value:unknown)=>new Response(JSON.stringify(value));
function boot(value:unknown){let active=true;const send=vi.fn<typeof fetch>(async()=>response(value)),remote=createDeviceScreenRemote({connection,requestId:device.id,token},()=>{if(!active)throw Error('PRIVATE CHANGE');},send);return {remote,send,stop:()=>{active=false;}};}
afterEach(()=>vi.useRealTimers());
it('uses only the enrolled device secret and fixed credential-free URLs, with no owner Auth/cookies/redirects/cache',async()=>{
 const page={v:1,device,outletNameJson:JSON.stringify('বাংলা\0shop'),members:[{id:id(7),nameJson:'"Staff"'}],next:null},f=boot(page);expect(await f.remote.directory(device)).toEqual(page);
 const [url,options]=f.send.mock.calls[0];expect(String(url)).toBe('https://screen.test/functions/v1/device-access');expect(options).toMatchObject({method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{apikey:connection.publishableKey,Authorization:'Bearer '+token}});expect(JSON.parse(options?.body as string)).toEqual({action:'directory',after:null,limit:50});expect(options?.body).not.toContain(token);
});
it('request/poll validation remains pinned to the original ID and local random secret',async()=>{
 const hash=await deviceSecretHash(token),receipt={v:1,id:device.id,verification:deviceVerification(hash),expiresAt:5000},f=boot(receipt);expect(await f.remote.request('১২৩-৪৫৬',id(10))).toEqual(receipt);expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({action:'request',id:device.id,code:'123456',pairingId:id(10)});
 f.send.mockImplementation(async()=>response({v:1,id:device.id,state:'approved',device,outletNameJson:'"Shop"'}));expect((await f.remote.poll()).state).toBe('approved');
 f.send.mockImplementation(async()=>response({v:1,id:device.id,state:'approved',device:{...device,id:id(9)},outletNameJson:'"Shop"'}));await expect(f.remote.poll()).rejects.toThrow();
});
it('PIN requests carry the durable attempt ID; member, device and session changes cannot become access',async()=>{
 const f=boot({session});expect(await f.remote.signIn(device,id(20),id(7),'0042')).toEqual(session);expect(String(f.send.mock.calls[0][0])).toBe('https://screen.test/functions/v1/device-pin');expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({attemptId:id(20),memberId:id(7),pin:'0042'});
 for(const patch of [{deviceId:id(9)},{memberId:id(9)},{expiresAt:session.expiresAt+1}]){f.send.mockImplementation(async()=>response({session:{...session,...patch}}));await expect(f.remote.signIn(device,id(20),id(7),'0042')).rejects.toThrow();}
 const access={v:1,sessionId:session.id,deviceId:device.id,businessId:device.businessId,outletId:device.outletId,memberId:session.memberId,role:'kitchen',mode:'kitchen',permissions:['orders.read'],expiresAt:session.expiresAt};f.send.mockImplementation(async()=>response(access));expect(await f.remote.access(device,session)).toEqual(access);f.send.mockImplementation(async()=>response({...access,role:'owner'}));await expect(f.remote.access(device,session)).rejects.toThrow();
});
it('reset retries use the original ID and retired attempt, and cannot accept another screen’s receipt',async()=>{
 const f=boot({id:id(20),deviceId:device.id,signedOut:true});expect(await f.remote.reset(id(20),id(21))).toEqual({id:id(20),deviceId:device.id,signedOut:true});expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({action:'reset',id:id(20),attemptId:id(21)});
 f.send.mockImplementation(async()=>response({id:id(20),deviceId:id(9),signedOut:true}));await expect(f.remote.reset(id(20),id(21))).rejects.toMatchObject({kind:'review'});
});
it('a changed local generation rejects both late replies and already returned ephemeral receipts',async()=>{
 const f=boot({id:id(20),deviceId:device.id,signedOut:true}),receipt=await f.remote.reset(id(20),null);f.stop();expect(()=>assertCommandReceipt(receipt)).toThrow();await expect(f.remote.reset(id(20),null)).rejects.toMatchObject({kind:'review'});expect(f.send).toHaveBeenCalledTimes(1);
 const g=boot({session});g.send.mockImplementation(async()=>{g.stop();return response({session});});await expect(g.remote.signIn(device,id(20),id(7),'0042')).rejects.toMatchObject({kind:'review'});
});
it('errors with credentials/backend details remain generic; only bounded PIN retry time is retained',async()=>{
 const f=boot(null);for(const [status,kind] of [[401,'auth'],[403,'auth'],[409,'review'],[500,'retry']] as const){f.send.mockImplementation(async()=>new Response('PRIVATE '+token,{status}));const error=await f.remote.directory(device).catch(e=>e);expect(error).toBeInstanceOf(DeviceScreenRequestError);expect(error.kind).toBe(kind);expect(error.message).not.toContain(token);expect(error.message).not.toContain('PRIVATE');}
 f.send.mockImplementation(async()=>new Response(JSON.stringify({error:'PRIVATE',retryAt:900001}),{status:429}));await expect(f.remote.signIn(device,id(20),id(7),'0042')).rejects.toMatchObject({kind:'backoff',retryAt:900001});
});
it.each(['fetch','body'])('the total deadline stops a stalled %s even when a mock ignores abort',async phase=>{
 vi.useFakeTimers();const f=boot(null);let cancelled=false;f.send.mockImplementation(phase==='fetch'?()=>new Promise(()=>{}):async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})));
 const work=expect(f.remote.directory(device)).rejects.toMatchObject({kind:'retry'});await vi.advanceTimersByTimeAsync(30000);await work;if(phase==='body')expect(cancelled).toBe(true);
});
it('abort, malformed/oversized payloads and invalid selections fail before granting access',async()=>{
 const f=boot(null),controller=new AbortController();controller.abort();await expect(f.remote.directory(device,null,50,controller.signal)).rejects.toMatchObject({kind:'retry'});expect(f.send).not.toHaveBeenCalled();
 for(const reply of [()=>new Response('{bad'),()=>new Response('null',{headers:{'Content-Length':'8000001'}}),()=>new Response(new Uint8Array(8000001))]){f.send.mockImplementation(async()=>reply());await expect(f.remote.directory(device)).rejects.toMatchObject({kind:'retry'});}
 const before=f.send.mock.calls.length;await expect(f.remote.directory({...device,id:id(9)})).rejects.toThrow();await expect(f.remote.directory(device,null,101)).rejects.toThrow();await expect(f.remote.signIn(device,id(20),id(7),'bad')).rejects.toThrow();expect(f.send).toHaveBeenCalledTimes(before);
});
