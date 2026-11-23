import {afterEach,expect,it,vi} from 'vitest';
import {createStaffDeviceHandler,createStaffDeviceStore,staffDeviceLimit,type StaffDeviceStore} from '../supabase/functions/_shared/staff-device-handler';
import {parseStaffDeviceRequest,parseStaffDeviceView,parseStaffDeviceOutcome} from '../packages/core/staff-device';
import {deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
const origin='https://shop.example.invalid',device='D'.repeat(43),session='S'.repeat(43);
const body=(operation='read',intent:unknown=null)=>({sessionToken:session,operation,intent,after:null});
const request=(value:unknown=body(),headers:Record<string,string>={},path='/functions/v1/staff-device',method='POST')=>new Request('https://backend.example.invalid'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(value)}:{})});
const intent=()=>({v:1 as const,id:newInboxId(),eventId:newInboxId(),memberId:deviceId(105),outletId:deviceId(11),type:'in' as const,occurredAt:Date.now(),expectedLastId:null});
const rawView=()=>({v:1,state:'view',access:{v:1,sessionId:deviceId(201),deviceId:deviceId(202),businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(105),role:'kitchen',mode:'counter',permissions:['staff.check-in'],expiresAt:Date.now()+43200000},view:{v:1,memberId:deviceId(105),outletId:deviceId(11),shopNameJson:'"Shop"',outletNameJson:'"Counter"',timeZone:'Asia/Dhaka',nameJson:'"Karim"',nameLocalJson:'"করিম"',role:'kitchen',language:'bn',shift:null,latest:null,entries:[],next:null,serverAt:Date.now()}});
const serve=(store:StaffDeviceStore,limit?:number)=>createStaffDeviceHandler({store,origins:new Set([origin]),limit});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
it('validates the exact current own-member projection and copies no secret or unexpected metadata',async()=>{
 const raw=rawView(),send=serve({visit:async()=>raw}),response=await send(request());expect(response.status).toBe(200);expect(parseStaffDeviceView(await response.json(),null).view.nameLocal).toBe('করিম');
 for(const altered of [{...raw,view:{...raw.view,privatePhone:'PRIVATE'}},{...raw,access:{...raw.access,memberId:deviceId(104)}},{...raw,access:{...raw.access,permissions:['orders.read','staff.check-in']}},{...raw,access:{...raw.access,sessionToken:session}}]){
  const rejected=await serve({visit:async()=>altered})(request());expect(rejected.status).toBe(503);expect(await rejected.text()).not.toContain('PRIVATE');
 }
});
it('rejects selectors, method/recorder overrides, invalid cursors, origins and credentials before the store',async()=>{
 const store={visit:vi.fn()},send=serve(store);
 for(const value of [{...body(),memberId:deviceId(104)},{...body(),outletId:deviceId(12)},body('submit',{...intent(),method:'manual'}),body('submit',{...intent(),recordedBy:deviceId(101)}),{...body(),after:{at:0,id:'bad'}},body('submit'),body('read',intent())])expect((await send(request(value))).status).toBe(400);
 expect((await send(request(body(),{Origin:'https://foreign.example.invalid'}))).status).toBe(403);
 expect((await send(request(body(),{Authorization:'Bearer invalid'}))).status).toBe(401);
 expect((await send(request(body(),undefined,'/functions/v1/staff-device?member=other'))).status).toBe(400);
 expect((await send(request(body(),undefined,'/functions/v1/staff-device','GET'))).status).toBe(405);
 expect((await send(request(body(),{'Content-Type':'text/plain'}))).status).toBe(415);
 expect((await send(request({...body(),extra:'x'.repeat(9000)}))).status).toBe(413);expect(store.visit).not.toHaveBeenCalled();
});
it('returns only a whole original receipt of the actual order-phone method and recorder',async()=>{
 const i=intent(),pending={v:1,id:i.id,state:'pending',intentJson:JSON.stringify(i),checkIn:null,at:null};
 let raw:unknown=pending;const send=serve({visit:async()=>raw});expect((await send(request(body('inspect',i)))).status).toBe(202);
 const applied={...pending,state:'applied',at:Date.now(),checkIn:{id:i.id,outletId:i.outletId,memberId:i.memberId,at:i.occurredAt,type:i.type,method:'order_phone',recordedBy:i.memberId}};
 raw=applied;const response=await send(request(body('submit',i)));expect(response.status).toBe(200);expect(parseStaffDeviceOutcome(await response.json(),i).state).toBe('applied');
 for(const altered of [{...applied,checkIn:{...applied.checkIn,method:'link'}},{...applied,checkIn:{...applied.checkIn,recordedBy:deviceId(101)}},{...applied,intentJson:JSON.stringify({...i,type:'out'})},{...applied,privateKey:'PRIVATE'}]){raw=altered;expect((await send(request(body('inspect',i)))).status).toBe(503);}
});
it('propagates missing/changed and bounded rate limits without confirming a pending original',async()=>{
 for(const [raw,status] of [[{v:1,state:'missing'},401],[{v:1,state:'changed'},409],[{v:1,state:'limited',retryAfter:35},429],[{v:1,state:'limited',retryAfter:61},503]] as const){
  const response=await serve({visit:async()=>raw})(request());expect(response.status).toBe(status);expect(response.headers.get('Retry-After')).toBe(status===429?'35':null);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.text()).not.toContain(session);
 }
 const response=await serve({visit:async()=>{throw Error('PRIVATE '+device+session);}})(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');
});
it('uses a fixed server RPC with credentials in private headers/body, never a URL or caller-selected budget',async()=>{
 let captured:Request|undefined;const store=createStaffDeviceStore('https://backend.example.invalid','sb_secret_test_only',async(input,init)=>{captured=new Request(input,init);return Response.json({v:1,state:'missing'});});
 await store.visit(device,parseStaffDeviceRequest(body()),777);expect(captured?.url).toBe('https://backend.example.invalid/rest/v1/rpc/visit_staff_device');expect(captured?.headers.get('apikey')).toBe('sb_secret_test_only');expect(captured?.headers.get('Authorization')).toBeNull();expect(captured?.credentials).toBe('omit');expect(captured?.redirect).toBe('error');
 expect(await captured!.json()).toEqual({p_device_token:device,p_session_token:session,p_operation:'read',p_intent:null,p_after:null,p_request_limit:777});
 expect(staffDeviceLimit()).toBe(600);expect(staffDeviceLimit('60000')).toBe(60000);for(const v of ['0','-1','60001','1.5','1e3',' 5'])expect(()=>staffDeviceLimit(v)).toThrow();
 for(const v of ['https://u:p@backend.example.invalid','https://backend.example.invalid/path','https://backend.example.invalid/#secret','http://backend.example.invalid'])expect(()=>createStaffDeviceStore(v,'sb_secret_test_only')).toThrow();
 expect(()=>createStaffDeviceStore('https://backend.example.invalid','sb_publishable_test_only')).toThrow();
});
it.each(['headers','body'] as const)('bounds the complete backend %s lifetime even when abort is ignored',async kind=>{
 vi.useFakeTimers();let cancelled=false;const store=createStaffDeviceStore('https://backend.example.invalid','sb_secret_test_only',async()=>kind==='headers'?new Promise<Response>(()=>{}):new Response(new ReadableStream({cancel(){cancelled=true;}})));
 const checked=expect(store.visit(device,parseStaffDeviceRequest(body()),600)).rejects.toThrow('Shared-screen attendance is unavailable.');await vi.advanceTimersByTimeAsync(15000);await checked;if(kind==='body')expect(cancelled).toBe(true);
});
it('rejects malformed/oversized privileged output and bounds slow incoming request bodies',async()=>{
 for(const response of [()=>new Response('PRIVATE',{status:500}),()=>new Response('{'),()=>new Response(new Uint8Array([255])),()=>new Response(new Uint8Array(8388609))])await expect(createStaffDeviceStore('https://backend.example.invalid','sb_secret_test_only',async()=>response()).visit(device,parseStaffDeviceRequest(body()),600)).rejects.toThrow();
 vi.useFakeTimers();let cancelled=false;const store={visit:vi.fn()},req=new Request('https://backend.example.invalid/functions/v1/staff-device',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit),pending=serve(store)(req);await vi.advanceTimersByTimeAsync(5000);expect((await pending).status).toBe(408);expect(cancelled).toBe(true);expect(store.visit).not.toHaveBeenCalled();
});
it('remains unavailable unless the installer explicitly enables its private backend environment',async()=>{
 for(const enabled of [undefined,'false','true']){
  vi.resetModules();let handler:((r:Request)=>Promise<Response>)|undefined;
  vi.stubGlobal('Deno',{env:{get:(name:string)=>name==='MISE_STAFF_DEVICE_ENABLED'?enabled:undefined},serve:(fn:typeof handler)=>{handler=fn;}});
  await import('../supabase/functions/staff-device/index');expect((await handler!(request())).status).toBe(503);
 }
});
