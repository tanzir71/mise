import {createECDH,randomBytes} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {expect,it,vi} from 'vitest';
import {createDeskRemote} from '../apps/web/src/data/desk-remote';
import {assertCommandReceipt,createDeskAlarmRequest,type CommandAuthorization} from '../apps/web/src/data/command-request';
import {testCommandAccount} from './command-account-fixture';
import {deskId as id,deskPage,deskScope as scope} from './desk-task-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},applicationKey=generateVAPIDKeys().publicKey;
const metadata={v:1,id:id(5),businessId:scope.businessId,outletId:scope.outletId,memberId:scope.memberId,createdAt:1000,expiresAt:null,revokedAt:null};
function boot(value:unknown=deskPage([])){
 let auth:CommandAuthorization={jwt:'original.phone.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};const original={...auth};
 const account={...testCommandAccount(config,async()=>auth.jwt),getAuth:vi.fn(async()=>({...auth})),assertCurrent:(v:CommandAuthorization)=>{if(v.userId!==original.userId||v.generation!==original.generation||auth.userId!==original.userId||auth.generation!==original.generation)throw Error('Original phone changed');}};
 const send=vi.fn<typeof fetch>(async()=>Response.json(value)),remote=createDeskRemote(config,account,scope,send);
 return {account,send,remote,setAuth:(patch:Partial<CommandAuthorization>)=>{auth={...auth,...patch};}};
}
function subscription(){const point=createECDH('prime256v1');point.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-only',expirationTime:null,keys:{p256dh:point.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};}
it('follows all original cursor/version pages and exposes only the complete list with a current-account receipt guard',async()=>{
 const f=boot();let calls=0;f.send.mockImplementation(async()=>Response.json(++calls===1?deskPage([1,2],true):deskPage([3])));
 const list=await f.remote.tasks();expect(list.tasks.map(t=>t.orderId)).toEqual([id(201),id(202),id(203)]);expect(list.next).toBeNull();expect(f.send).toHaveBeenCalledTimes(2);
 const requests=f.send.mock.calls.map(([url,options])=>({url:String(url),body:JSON.parse(String(options?.body))}));expect(requests).toEqual([
  {url:'https://cloud.test/rest/v1/rpc/read_kitchen_alarm_task_page',body:{p_outlet_id:scope.outletId,p_after_due:null,p_after_id:null,p_version:null,p_limit:50}},
  {url:'https://cloud.test/rest/v1/rpc/read_kitchen_alarm_task_page',body:{p_outlet_id:scope.outletId,p_after_due:1000,p_after_id:id(102),p_version:12,p_limit:50}}]);
 expect(JSON.stringify(list)).not.toMatch(/original.phone.signature|sb_publishable/);f.setAuth({generation:2});expect(()=>assertCommandReceipt(list)).toThrow();
});
it('does not complete a partial list after a changed task version or settings-only revision',async()=>{
 for(const patch of [{version:13},{settings:{enabled:true,minutes:4,revision:1}}]){
  const f=boot();let calls=0;f.send.mockImplementation(async()=>Response.json(++calls===1?deskPage([1,2],true):{...deskPage([3]),...patch}));
  await expect(f.remote.tasks()).rejects.toThrow('complete task list');expect(calls).toBe(2);
 }
});
it('does not reinterpret HTTP conflict or lost continuation as an empty complete Inbox',async()=>{
 for(const status of [409,503]){const f=boot();let calls=0;f.send.mockImplementation(async()=>++calls===1?Response.json(deskPage([1],true)):new Response('PRIVATE',{status}));await expect(f.remote.tasks()).rejects.toMatchObject({kind:status===409?'review':'retry'});}
});
it('rejects an empty continuation, repeated task or changed order target instead of clearing unseen highlights',async()=>{
 for(const page of [deskPage([]),deskPage([1]),{...deskPage([3]),tasks:[{...deskPage([3]).tasks[0],actionsJson:JSON.stringify([{kind:'open-order',orderId:id(999)},{kind:'copy',text:'Review'}])}]}]){
  const f=boot();let calls=0;f.send.mockImplementation(async()=>Response.json(++calls===1?deskPage([1],true):page));await expect(f.remote.tasks()).rejects.toThrow('complete task list');
 }
});
it('cannot reuse a different phone generation between continuation requests',async()=>{
 const f=boot();let authCalls=0;f.account.getAuth.mockImplementation(async()=>{if(++authCalls===3)f.setAuth({generation:2});return {jwt:'original.phone.signature',userId:'00000000-0000-4000-8000-000000000001',generation:authCalls>=3?2:1};});
 f.send.mockResolvedValue(Response.json(deskPage([1],true)));await expect(f.remote.tasks()).rejects.toMatchObject({kind:'auth'});expect(f.send).toHaveBeenCalledTimes(1);
});
it('rejects a different outlet, actor or role in the authoritative page context',async()=>{
 for(const patch of [{outletId:id(9)},{memberId:id(9)},{role:'manager'}]){const f=boot({...deskPage([]),access:{...scope,...patch}});await expect(f.remote.tasks()).rejects.toThrow();}
});
it('uses the fixed owner endpoint and returns only a validated runtime application key for the original context',async()=>{
 const f=boot({v:1,context:scope,applicationKey});expect(await f.remote.configuration()).toEqual({v:1,context:scope,applicationKey});expect(String(f.send.mock.calls[0][0])).toBe('https://cloud.test/functions/v1/desk-notifications');
 expect(JSON.parse(String(f.send.mock.calls[0][1]?.body))).toEqual({action:'configuration',outletId:scope.outletId});
});
it('freezes original registration IDs and complete browser subscription before asynchronous phone authorization',async()=>{
 const f=boot(metadata),source={id:metadata.id,eventId:id(6),applicationKey,subscription:subscription()},original=structuredClone(source);
 f.account.getAuth.mockImplementation(async()=>{source.eventId=id(9);source.subscription.keys.auth='changed';return {jwt:'original.phone.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};});
 expect(await f.remote.register(source)).toEqual({action:'register',id:metadata.id,eventId:original.eventId,subscription:metadata});expect(JSON.parse(String(f.send.mock.calls[0][1]?.body))).toEqual({action:'register',...original,outletId:scope.outletId});
});
it('cannot confirm a registration reply after the original phone changes',async()=>{
 const f=boot(metadata);f.send.mockImplementation(async()=>{f.setAuth({generation:2});return Response.json(metadata);});await expect(f.remote.register({id:metadata.id,eventId:id(6),applicationKey,subscription:subscription()})).rejects.toMatchObject({kind:'auth'});
});
it('rejects capability, wrong-member and wrong-outlet fields in registration metadata',async()=>{
 for(const patch of [{endpoint:'https://fcm.googleapis.com/private'},{memberId:id(9)},{outletId:id(9)}]){const f=boot({...metadata,...patch});await expect(f.remote.register({id:metadata.id,eventId:id(6),applicationKey,subscription:subscription()})).rejects.toThrow();}
});
it('keeps an explicit original revocation ID and treats only actual revoked metadata as removal',async()=>{
 const f=boot({...metadata,revokedAt:2000}),result=await f.remote.revoke(metadata.id,id(6));expect(result).toMatchObject({action:'revoke',id:metadata.id,eventId:id(6),subscription:{id:metadata.id,revokedAt:2000}});
 expect(JSON.parse(String(f.send.mock.calls[0][1]?.body))).toEqual({action:'revoke',id:metadata.id,eventId:id(6)});
 await expect(boot(metadata).remote.revoke(metadata.id,id(6))).rejects.toMatchObject({kind:'review'});f.setAuth({generation:2});expect(()=>assertCommandReceipt(result)).toThrow();
});
it('keeps a guarded absence result rather than losing its original-account proof',async()=>{
 const f=boot(null),result=await f.remote.read(metadata.id);expect(result).toEqual({action:'read',id:metadata.id,subscription:null});f.setAuth({generation:2});expect(()=>assertCommandReceipt(result)).toThrow();
});
it('freezes the exact original warning settings and audit event across asynchronous authorization',async()=>{
 const source={enabled:false,minutes:7,revision:2,eventId:id(6)},f=boot({enabled:false,minutes:7,revision:3,expectedRevision:2,updatedAt:3000});
 f.account.getAuth.mockImplementation(async()=>{source.minutes=99;return {jwt:'original.phone.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};});
 expect(await f.remote.setSettings(source)).toMatchObject({enabled:false,minutes:7,revision:3,expectedRevision:2});
 expect(JSON.parse(String(f.send.mock.calls[0][1]?.body))).toEqual({p_outlet_id:scope.outletId,p_expected_revision:2,p_enabled:false,p_minutes:7,p_event_id:id(6)});
});
it('rejects a settings result for a different original intent or revision',async()=>{
 const f=boot({enabled:true,minutes:9,revision:3,expectedRevision:2,updatedAt:3000});await expect(f.remote.setSettings({enabled:true,minutes:7,revision:2,eventId:id(6)})).rejects.toMatchObject({kind:'review'});
});
it('never broadens the desk transport to an arbitrary RPC or service-privileged operation',()=>{
 const f=boot();expect(()=>createDeskAlarmRequest(config,f.account,'finish_kitchen_push' as never,f.send)).toThrow();expect(f.send).not.toHaveBeenCalled();
});
