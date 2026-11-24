import {afterEach,expect,it,vi} from 'vitest';
import {parseStaffStockPage,parseStaffStockRequest} from '../packages/core/staff-stock';
import {parseStaffDeviceAccess} from '../packages/core/device-access';
import {createStaffStockHandler,createStaffStockStore,staffStockLimit,type StaffStockStore} from '../supabase/functions/_shared/staff-stock-handler';
import {validateBackupRow} from '../packages/core/backup-schema';
const id=(n:number)=>String(n).padStart(26,'0'),origin='https://shop.example.invalid',device='D'.repeat(43),session='S'.repeat(43);
const body=()=>({operation:'read',sessionToken:session,after:null,limit:50});
const request=(value:unknown=body(),headers:Record<string,string>={},path='/functions/v1/staff-stock',method='POST')=>new Request('https://backend.example.invalid'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(value)}:{})});
const item=()=>({id:id(301),outletId:id(11),revision:1,name:'চাল\u0000\ud800',nameLocal:'চাল',unit:'kg',category:'Dry goods',aliases:['rice'],onHand:1.005,target:20,packSize:.001,lowAt:2,lastCountedAt:null,eventId:id(401),createdAt:1,updatedAt:2});
const rawPage=()=>({v:1,state:'stock',access:{v:1,sessionId:id(201),deviceId:id(202),businessId:id(1),outletId:id(11),memberId:id(105),role:'kitchen',mode:'kitchen',permissions:['stock.read'],expiresAt:43200001},outletName:'Kitchen',serverAt:10,items:[item()],next:null});
const serve=(store:StaffStockStore,limit?:number)=>createStaffStockHandler({store,origins:new Set([origin]),limit});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
it('preserves literal stock source and thousandths in a closed supplier-free response',async()=>{
 const page=parseStaffStockPage(rawPage(),null,50);expect(page.items[0]).toMatchObject({name:'চাল\u0000\ud800',onHand:1.005,packSize:.001,aliases:['rice']});
 expect(parseStaffStockPage(page)).toEqual(page);const response=await serve({read:async()=>rawPage()})(request());expect(response.status).toBe(200);expect(await response.json()).toEqual(page);
 for(const key of ['Cache-Control','Pragma','Referrer-Policy','Content-Security-Policy','X-Content-Type-Options'])expect(response.headers.get(key)).toBeTruthy();
 expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('reads complete maximum imported literal labels without the smaller response cap dropping a valid item',async()=>{
 const label='\0'.repeat(1_000_000),p=rawPage(),row=p.items[0];
 row.name=label;row.nameLocal=label;
 validateBackupRow('stockItems',{id:row.id,outletId:row.outletId,revision:row.revision,name:label,nameLocal:label,unit:'kg',category:'Dry goods',aliases:['rice'],onHand:row.onHand,target:row.target,packSize:row.packSize,lowAt:row.lowAt,eventId:row.eventId,createdAt:row.createdAt,updatedAt:row.updatedAt},'maximum stock reader source');
 const wire=JSON.stringify(p);expect(new TextEncoder().encode(wire).byteLength).toBeGreaterThan(8388608);
 const store=createStaffStockStore('https://backend.example.invalid','sb_secret_test_only',async()=>new Response(wire,{headers:{'Content-Type':'application/json'}}));
 const page=parseStaffStockPage(await store.read(device,parseStaffStockRequest(body()),600),null,50);
 expect(page.items[0].name).toBe(label);expect(page.items[0].nameLocal).toBe(label);expect(page.items).toHaveLength(1);
});
it('validates every stock page, item, permission and continuation without accepting hidden metadata',()=>{
 const p=rawPage(),row=item();
 for(const changed of [{...p,supplierPhone:'PRIVATE'},{...p,access:{...p.access,permissions:[]}},{...p,access:{...p.access,permissions:['stock.update']}},{...p,access:{...p.access,role:'rider'}},{...p,access:{...p.access,mode:'counter'}},{...p,serverAt:p.access.expiresAt},{...p,next:id(999)},{...p,items:[],next:row.id},
  ...[{...row,supplierId:id(500)},{...row,price:50},{...row,outletId:id(12)},{...row,aliases:[{phone:'PRIVATE'}]},{...row,onHand:1.0001},{...row,target:-1},{...row,packSize:0},{...row,lowAt:1e12},{...row,lastCountedAt:3},{...row,revision:0},{...row,eventId:'bad'},{...row,unit:null}].map(r=>({...p,items:[r]}))])expect(()=>parseStaffStockPage(changed,null,50)).toThrow();
 expect(()=>parseStaffStockPage({...p,items:[row,row]},null,50)).toThrow();expect(()=>parseStaffStockPage(p,row.id,50)).toThrow();
 expect(()=>parseStaffStockPage(p,null,0)).toThrow();
 const full={...p,next:row.id};expect(parseStaffStockPage(full,null,1).next).toBe(row.id);
 const deviceMetadata={id:id(999),businessId:id(1),outletId:id(11),name:'Screen',mode:'kitchen' as const,createdAt:1,expiresAt:90*86400000+1,revokedAt:null};
 expect(()=>parseStaffStockPage(p,null,50,{device:deviceMetadata,session:{id:id(201),token:session,deviceId:deviceMetadata.id,memberId:id(105),createdAt:1,expiresAt:43200001}})).toThrow();
 expect(parseStaffDeviceAccess({...p.access,role:'staff',mode:'counter'}).permissions).toEqual(['stock.read']);
});
it('admits no caller-selected outlet/member, mutation, credential query or unbounded request',async()=>{
 const store={read:vi.fn()},handler=serve(store);
 for(const changed of [{...body(),memberId:id(104)},{...body(),outletId:id(12)},{...body(),role:'owner'},{...body(),operation:'adjust'},{...body(),after:'bad'},{...body(),limit:0},{...body(),limit:101},{...body(),limit:1.5},{...body(),sessionToken:'bad'}])expect((await handler(request(changed))).status).toBe(400);
 expect((await handler(request(body(),undefined,'/functions/v1/staff-stock?token=x'))).status).toBe(400);
 expect((await handler(request(body(),undefined,'/functions/v1/staff-stock','GET'))).status).toBe(405);
 expect((await handler(request(body(),{Origin:'https://foreign.example.invalid'}))).status).toBe(403);
 expect((await handler(request(body(),{Authorization:'Bearer sb_secret_test_only'}))).status).toBe(401);
 expect((await handler(request(body(),{'Content-Type':'text/plain'}))).status).toBe(415);
 expect((await handler(request({...body(),extra:'x'.repeat(2100)}))).status).toBe(413);expect(store.read).not.toHaveBeenCalled();
});
it('passes only validated stock pages and generic refusal/budget/failure outcomes',async()=>{
 let raw:unknown={v:1,state:'missing'};const handler=serve({read:async()=>raw});expect((await handler(request())).status).toBe(401);
 raw={v:1,state:'limited',retryAfter:45};const limited=await handler(request());expect(limited.status).toBe(429);expect(limited.headers.get('Retry-After')).toBe('45');
 for(const value of [null,{v:1,state:'missing',secret:'PRIVATE'},{v:1,state:'limited',retryAfter:61},{...rawPage(),items:[{...item(),supplierPhone:'PRIVATE'}]}]){
  raw=value;const response=await handler(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');
 }
 expect((await serve({read:async()=>{throw Error('PRIVATE');}})(request())).status).toBe(503);
});
it('uses exactly the fixed service RPC with a private installation key and bounded cursor',async()=>{
 let captured:Request|undefined;const store=createStaffStockStore('https://backend.example.invalid','sb_secret_test_only',async(url,options)=>{captured=new Request(url,options);return Response.json(rawPage());});
 await store.read(device,parseStaffStockRequest({...body(),after:id(300),limit:1}),777);
 expect(captured!.url).toBe('https://backend.example.invalid/rest/v1/rpc/read_staff_stock_page');expect(captured!.headers.get('apikey')).toBe('sb_secret_test_only');expect(captured!.headers.get('Authorization')).toBeNull();expect(captured!.credentials).toBe('omit');expect(captured!.redirect).toBe('error');expect(captured!.cache).toBe('no-store');
 expect(await captured!.json()).toEqual({p_device_token:device,p_session_token:session,p_after_id:id(300),p_limit:1,p_request_limit:777});
 expect(staffStockLimit()).toBe(600);expect(staffStockLimit('60000')).toBe(60000);for(const value of ['0','-1','60001','1.5','1e3',' 5'])expect(()=>staffStockLimit(value)).toThrow();
 for(const value of ['https://u:p@backend.example.invalid','https://backend.example.invalid/path','https://backend.example.invalid/#secret','http://backend.example.invalid'])expect(()=>createStaffStockStore(value,'sb_secret_test_only')).toThrow();
 expect(()=>createStaffStockStore('https://backend.example.invalid','sb_publishable_test_only')).toThrow();expect(()=>createStaffStockHandler({store,origins:new Set()})).toThrow();
});
it.each(['headers','body'] as const)('bounds the whole privileged %s response even if abort is ignored',async kind=>{
 vi.useFakeTimers();let cancelled=false;const store=createStaffStockStore('https://backend.example.invalid','sb_secret_test_only',async()=>kind==='headers'?new Promise<Response>(()=>{}):new Response(new ReadableStream({cancel(){cancelled=true;}})));
 const checked=expect(store.read(device,parseStaffStockRequest(body()),600)).rejects.toThrow('Shared-screen stock is unavailable.');await vi.advanceTimersByTimeAsync(15000);await checked;if(kind==='body')expect(cancelled).toBe(true);
});
it('rejects malformed, oversized and slow input/output without returning private diagnostics',async()=>{
 for(const response of [()=>new Response('PRIVATE',{status:500}),()=>new Response('{'),()=>new Response(new Uint8Array([255])),()=>{const chunk=new Uint8Array(8388608);let sent=0;return new Response(new ReadableStream({pull(c){if(sent++<9)c.enqueue(chunk);else c.close();}}));}])await expect(createStaffStockStore('https://backend.example.invalid','sb_secret_test_only',async()=>response()).read(device,parseStaffStockRequest(body()),600)).rejects.toThrow();
 vi.useFakeTimers();let cancelled=false;const store={read:vi.fn()},req=new Request('https://backend.example.invalid/functions/v1/staff-stock',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit),pending=serve(store)(req);await vi.advanceTimersByTimeAsync(5000);expect((await pending).status).toBe(408);expect(cancelled).toBe(true);expect(store.read).not.toHaveBeenCalled();
});
it('stays disabled unless each installation explicitly supplies its own complete backend configuration',async()=>{
 for(const enabled of [undefined,'false','true']){
  vi.resetModules();let handler:((r:Request)=>Promise<Response>)|undefined;
  vi.stubGlobal('Deno',{env:{get:(name:string)=>name==='MISE_STAFF_STOCK_ENABLED'?enabled:undefined},serve:(fn:typeof handler)=>{handler=fn;}});
  await import('../supabase/functions/staff-stock/index');expect((await handler!(request())).status).toBe(503);
 }
});
