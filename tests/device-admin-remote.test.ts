import {expect,it,vi} from 'vitest';
import {createDeviceAdminRemote} from '../apps/web/src/data/device-admin-remote';
import {assertCommandReceipt,type CommandAuthorization} from '../apps/web/src/data/command-request';
import {testCommandAccount} from './command-account-fixture';
import {deviceLifetime,pairingLifetime} from '../packages/core/device-access';
const id=(n:number)=>String(n).padStart(26,'0'),config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},scope={businessId:id(1),outletId:id(2),actorId:id(3)};
const pairing={v:1 as const,id:id(10),...{businessId:id(1),outletId:id(2)},name:'Kitchen',mode:'kitchen' as const,code:'123456',createdAt:1000,expiresAt:1000+pairingLifetime,closedAt:null,deviceId:null},claim={id:id(11),verification:'1234-5678-9ABC-DEF0',createdAt:1001,approvedAt:null},device={id:claim.id,businessId:id(1),outletId:id(2),name:'Kitchen',mode:'kitchen',createdAt:1002,expiresAt:1002+deviceLifetime,revokedAt:null};
function boot(value:unknown=pairing){let auth:CommandAuthorization={jwt:'original.owner.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};const account={...testCommandAccount(config,async()=>auth.jwt),getAuth:vi.fn(async()=>({...auth})),assertCurrent:(v:CommandAuthorization)=>{if(v.userId!==auth.userId||v.generation!==auth.generation||v.jwt!==auth.jwt)throw Error('PRIVATE ACCOUNT CHANGE');}},send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(value))),remote=createDeviceAdminRemote(config,account,scope,send);return {remote,account,send,setAuth:(patch:Partial<CommandAuthorization>)=>{auth={...auth,...patch};}};}
it('original pairing IDs, name, mode and outlet are frozen before asynchronous Auth and sent only to the fixed RPC',async()=>{
 const f=boot(),source={id:pairing.id,eventId:id(12),name:'  Kitchen  ',mode:'kitchen' as const};f.account.getAuth.mockImplementation(async()=>{source.name='Changed';return {jwt:'original.owner.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};});expect(await f.remote.start(source)).toEqual(pairing);
 const [url,options]=f.send.mock.calls[0];expect(String(url)).toBe('https://cloud.test/rest/v1/rpc/start_device_pairing');expect(options).toMatchObject({method:'POST',redirect:'error',cache:'no-store',credentials:'omit',headers:{apikey:config.publishableKey,Authorization:'Bearer original.owner.signature'}});expect(JSON.parse(options?.body as string)).toEqual({p_id:pairing.id,p_event_id:id(12),p_outlet_id:scope.outletId,p_name:'Kitchen',p_mode:'kitchen'});
});
it('changed Auth during or after a response cannot confirm a pairing in the new account/generation',async()=>{
 const f=boot();f.send.mockImplementation(async()=>{f.setAuth({generation:2});return new Response(JSON.stringify(pairing));});await expect(f.remote.start({id:pairing.id,eventId:id(12),name:'Kitchen',mode:'kitchen'})).rejects.toMatchObject({kind:'auth'});
 const g=boot(),value=await g.remote.start({id:pairing.id,eventId:id(12),name:'Kitchen',mode:'kitchen'});g.setAuth({generation:2});expect(()=>assertCommandReceipt(value)).toThrow();
});
it('the browser cannot accept a different source name, mode or outlet as the result of the original enrollment choice',async()=>{
 for(const patch of [{name:'Changed'},{mode:'counter'},{outletId:id(9)},{id:id(9)},{token:'S'.repeat(43)}]){const f=boot({...pairing,...patch});await expect(f.remote.start({id:pairing.id,eventId:id(12),name:'Kitchen',mode:'kitchen'})).rejects.toThrow();}
});
it('owner pages and inspections remain bound to the original operator and complete source',async()=>{
 const page={v:1,...scope,actorRole:'owner',kind:'devices',entries:[device],next:null},f=boot(page);expect((await f.remote.page('devices')).entries).toEqual([device]);expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({p_outlet_id:scope.outletId,p_kind:'devices',p_after_id:null,p_limit:50});
 f.send.mockImplementation(async()=>new Response(JSON.stringify({v:1,...scope,actorRole:'owner',pairing,requests:[claim]})));expect((await f.remote.inspect(pairing.id)).requests).toEqual([claim]);
 f.send.mockImplementation(async()=>new Response(JSON.stringify({...page,actorId:id(9)})));await expect(f.remote.page('devices')).rejects.toThrow();
});
it('approval sends exactly the compared verification and cannot accept a different screen/outlet/mode',async()=>{
 const f=boot(device);expect(await f.remote.approve(pairing,claim,id(12))).toEqual(device);expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({p_pairing_id:pairing.id,p_request_id:claim.id,p_verification:claim.verification,p_event_id:id(12)});
 for(const patch of [{id:id(9)},{mode:'counter'},{outletId:id(9)},{name:'Changed'}]){f.send.mockImplementation(async()=>new Response(JSON.stringify({...device,...patch})));await expect(f.remote.approve(pairing,claim,id(12))).rejects.toThrow();}
});
it('cancellation cannot report an open invitation as closed, and device removal requires a real revocation',async()=>{
 const f=boot(pairing);await expect(f.remote.cancel(pairing.id,id(12))).rejects.toThrow();f.send.mockImplementation(async()=>new Response(JSON.stringify({...pairing,closedAt:1002})));expect((await f.remote.cancel(pairing.id,id(12))).closedAt).toBe(1002);
 f.send.mockImplementation(async()=>new Response(JSON.stringify(device)));await expect(f.remote.revoke(device.id,id(12))).rejects.toThrow();f.send.mockImplementation(async()=>new Response(JSON.stringify({...device,revokedAt:1003})));expect((await f.remote.revoke(device.id,id(12))).revokedAt).toBe(1003);expect(JSON.parse(f.send.mock.calls.at(-1)![1]?.body as string)).toEqual({p_id:device.id,p_event_id:id(12)});
});
it('owner PIN changes use only the existing privileged endpoint and the current phone JWT',async()=>{
 const f=boot({memberId:id(20),revision:id(21),changedAt:1002});expect(await f.remote.pin(id(20),'set','0042')).toEqual({memberId:id(20),revision:id(21),changedAt:1002});expect(String(f.send.mock.calls[0][0])).toBe('https://cloud.test/functions/v1/staff-pin');expect(JSON.parse(f.send.mock.calls[0][1]?.body as string)).toEqual({action:'set',outletId:scope.outletId,memberId:id(20),pin:'0042'});
 f.send.mockImplementation(async()=>new Response(JSON.stringify({memberId:id(20),cleared:true})));expect(await f.remote.pin(id(20),'clear')).toEqual({memberId:id(20),cleared:true});expect(JSON.parse(f.send.mock.calls.at(-1)![1]?.body as string)).not.toHaveProperty('pin');
 await expect(f.remote.pin(id(20),'set','12')).rejects.toThrow();await expect(f.remote.pin(id(20),'clear','0042')).rejects.toThrow();
});
it('backend errors and caller aborts retain the original request without exposing response details',async()=>{
 const f=boot();f.send.mockImplementation(async()=>new Response('PRIVATE BACKEND DETAIL',{status:500}));await expect(f.remote.inspect(pairing.id)).rejects.toMatchObject({kind:'retry'});
 const controller=new AbortController();controller.abort();await expect(f.remote.page('devices',null,50,controller.signal)).rejects.toMatchObject({kind:'retry'});expect(f.send).toHaveBeenCalledTimes(1);
});
