import {afterEach,expect,it,vi} from 'vitest';
import {parseStaffStockIntent,staffStockIntentHash,staffStockHash,staffStockRpcFields,type StaffStockIntent} from '../packages/core/staff-stock-actions';
import {createStaffStockActionsHandler,createStaffStockActionsStore,StaffStockActionStoreError,type StaffStockActionsStore} from '../supabase/functions/_shared/staff-stock-actions-handler';
const id=(n:number)=>String(n).padStart(26,'0'),origin='https://shop.example.invalid',device='D'.repeat(43),session='S'.repeat(43),token='T'.repeat(43);
function intent():StaffStockIntent{return parseStaffStockIntent({v:1,origin:{v:1,businessId:id(1),outletId:id(11),deviceId:id(202),sessionId:id(201),memberId:id(105),role:'kitchen',mode:'kitchen',permissions:['stock.adjust','stock.read','stock.undo'],expiresAt:43200001},screenRevision:id(90001),readAt:500,outletName:'Kitchen',command:{type:'stock.adjust',id:id(50001),outletId:id(11),occurredAt:1000,change:{id:id(301),revision:1,reason:'used',quantity:1.005,source:'manual',note:' literal\u0000\ud800 '},moveId:id(60001)},items:[{id:id(301),outletId:id(11),revision:1,name:'চাল\u0000\ud800',nameLocal:'চাল',unit:'kg',category:'Dry goods',aliases:[],onHand:10.005,target:20,packSize:1,lowAt:2,lastCountedAt:null,eventId:id(10301),createdAt:1,updatedAt:100}],undo:null});}
const request=(body:unknown={operation:'inspect',sessionToken:session,intent:intent()},headers:Record<string,string>={},path='/functions/v1/staff-stock-actions',method='POST')=>new Request('https://backend.example.invalid'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
const pending=(original:StaffStockIntent,hash:string)=>({v:1,id:original.command.id,state:'pending',intentHash:hash,receipt:null,at:null});
const quote=(original:StaffStockIntent,hash:string)=>({state:'review',reviewHash:'b'.repeat(64),token,review:{v:1,id:id(70001),intentHash:hash,access:original.origin,at:2000,expiresAt:62000,items:original.items,lines:[{itemId:id(301),revision:1,before:10.005,after:9,lastCountedAt:null}],withdrawn:[]}});
function store():StaffStockActionsStore{return {admit:vi.fn(async()=>({state:'allowed'})),visit:vi.fn(async(_device,_session,operation,original,hash)=>operation==='prepare'?quote(original,hash):operation==='close'?{...pending(original,hash),state:'closed',at:3000}:pending(original,hash)),finish:vi.fn(async()=>null)};}
const serve=(source:StaffStockActionsStore)=>createStaffStockActionsHandler({store:source,origins:new Set([origin]),newId:()=>id(70001)});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
it('admits the actual device before consuming any complete source and respects its budget',async()=>{
 for(const reply of [{state:'missing'},{state:'limited',retryAfter:45},{state:'allowed',secret:'PRIVATE'}]){
  const source=store();source.admit=vi.fn(async()=>reply);const req=request();let touched=false;Object.defineProperty(req,'body',{get(){touched=true;throw Error('body consumed');}});
  const response=await serve(source)(req);expect(response.status).toBe(reply.state==='missing'?401:reply.state==='limited'?429:503);expect(touched).toBe(false);expect(source.visit).not.toHaveBeenCalled();expect(await response.text()).not.toContain('PRIVATE');
  if(reply.state==='limited')expect(response.headers.get('Retry-After')).toBe('45');
 }
});
it('keeps prepare separate from confirmation and returns only the complete checked current comparison',async()=>{
 const source=store(),original=intent(),response=await serve(source)(request({operation:'prepare',sessionToken:session,intent:original}));
 expect(response.status).toBe(200);expect(await response.json()).toEqual(quote(original,await staffStockIntentHash(original)));expect(source.finish).not.toHaveBeenCalled();
 for(const field of ['Cache-Control','Pragma','Referrer-Policy','Content-Security-Policy','X-Content-Type-Options'])expect(response.headers.get(field)).toBeTruthy();
});
it('rejects selectors, unsupported mutations, credential queries and foreign callers before privileged visits',async()=>{
 const source=store(),handler=serve(source),body={operation:'inspect',sessionToken:session,intent:intent()};
 for(const value of [{...body,operation:'submit'},{...body,actorId:id(101)},{...body,p_plan:{}},{...body,outletId:id(12)},{...body,sessionToken:'bad'},{...body,operation:'commit'},{...body,intent:{...intent(),supplierId:id(999)}}])expect((await handler(request(value))).status).toBe(400);
 expect((await handler(request(body,{},'/functions/v1/staff-stock-actions?token=private'))).status).toBe(400);
 expect((await handler(request(body,{Origin:'https://foreign.example.invalid'}))).status).toBe(403);
 expect((await handler(request(body,{Authorization:'Bearer sb_secret_test_only'}))).status).toBe(401);
 expect((await handler(request(body,{'Content-Type':'text/plain'}))).status).toBe(415);expect((await handler(request(body,{},undefined,'GET'))).status).toBe(405);expect(source.visit).not.toHaveBeenCalled();
});
it('validates the actual inspection before dispatching an explicit confirmation',async()=>{
 const original=intent(),hash=await staffStockIntentHash(original),body={operation:'commit',sessionToken:session,intent:original,ticketId:id(70001),token,reviewHash:'b'.repeat(64)};
 for(const result of [null,{...pending(original,hash),intentHash:'c'.repeat(64)},{...pending(original,hash),secret:'PRIVATE'},{state:'missing'}]){
  const source=store();source.visit=vi.fn(async()=>result);const response=await serve(source)(request(body));expect(response.status).toBe(result&&'state'in result&&result.state==='missing'?401:503);expect(source.finish).not.toHaveBeenCalled();expect(await response.text()).not.toContain('PRIVATE');
 }
 const source=store();source.visit=vi.fn(async()=>({...pending(original,hash),state:'closed',at:3000}));const response=await serve(source)(request(body));expect(response.status).toBe(200);expect((await response.json() as {state:string}).state).toBe('closed');expect(source.finish).not.toHaveBeenCalled();
});
it('binds small outcome hashes to the complete original rather than echoing or truncating large source',async()=>{
 const original=intent(),hash=await staffStockIntentHash(original),source=store(),response=await serve(source)(request({operation:'inspect',sessionToken:session,intent:original}));
 expect(await response.json()).toEqual(pending(original,hash));expect(source.visit).toHaveBeenCalledWith(device,session,'inspect',original,hash,null);
 const fields=await staffStockRpcFields(original,hash);expect(fields.p_original_json).toBe(JSON.stringify(original));expect(fields.p_facts[0]).toMatchObject({unitHash:await staffStockHash('kg'),noteJson:JSON.stringify('literal\u0000\ud800')});expect(fields.p_facts[0]).not.toHaveProperty('unitJson');
 await expect(staffStockRpcFields(original,'c'.repeat(64))).rejects.toThrow();
});
it('uses only the fixed RPCs, exact derived source/scope and a private backend key',async()=>{
 const captured:Request[]=[],source=createStaffStockActionsStore('https://backend.example.invalid','sb_secret_test_only',async(url,options)=>{captured.push(new Request(url,options));return Response.json({state:'allowed'});}),original=intent(),hash=await staffStockIntentHash(original);
 await source.admit(device,700);await source.visit(device,session,'prepare',original,hash,id(70001));await source.finish(device,{operation:'commit',sessionToken:session,intent:original,ticketId:id(70001),token,reviewHash:'b'.repeat(64)},hash);
 expect(captured.map(r=>new URL(r.url).pathname)).toEqual(['/rest/v1/rpc/admit_staff_stock_body','/rest/v1/rpc/visit_staff_stock_original','/rest/v1/rpc/finish_staff_stock_action']);
 for(const req of captured){expect(req.headers.get('apikey')).toBe('sb_secret_test_only');expect(req.headers.get('Authorization')).toBeNull();expect(req.credentials).toBe('omit');expect(req.redirect).toBe('error');expect(req.cache).toBe('no-store');expect(new URL(req.url).search).toBe('');}
 expect(await captured[1].json()).toEqual({p_device_token:device,p_session_token:session,p_operation:'prepare',...await staffStockRpcFields(original,hash),p_ticket_id:id(70001)});
 expect(await captured[2].json()).toEqual({p_device_token:device,p_session_token:session,p_ticket_id:id(70001),p_token:token,p_review_hash:'b'.repeat(64),p_source_hash:hash});
 for(const url of ['https://u:p@backend.example.invalid','https://backend.example.invalid/path','https://backend.example.invalid/#private','http://backend.example.invalid'])expect(()=>createStaffStockActionsStore(url,'sb_secret_test_only')).toThrow();expect(()=>createStaffStockActionsStore('https://backend.example.invalid','sb_publishable_test_only')).toThrow();
});
it.each(['headers','body'] as const)('bounds the complete privileged %s lifetime even if the source ignores abort',async kind=>{
 vi.useFakeTimers();let cancelled=false;const source=createStaffStockActionsStore('https://backend.example.invalid','sb_secret_test_only',async()=>kind==='headers'?new Promise<Response>(()=>{}):new Response(new ReadableStream({cancel(){cancelled=true;}})));
 const result=expect(source.admit(device,600)).rejects.toThrow('Staff stock request unavailable.');await vi.advanceTimersByTimeAsync(60000);await result;if(kind==='body')expect(cancelled).toBe(true);
});
it('closes malformed/oversized RPC output and masks private errors while preserving useful retry status',async()=>{
 for(const make of [()=>new Response('{'),()=>new Response(new Uint8Array([255])),()=>{const chunk=new Uint8Array(8388608);let n=0;return new Response(new ReadableStream({pull(c){if(n++<9)c.enqueue(chunk);else c.close();}}));}])await expect(createStaffStockActionsStore('https://backend.example.invalid','sb_secret_test_only',async()=>make()).admit(device,600)).rejects.toThrow();
 for(const status of [401,409,429,503] as const){const source=store();source.admit=vi.fn(async()=>{throw new StaffStockActionStoreError(status);});const response=await serve(source)(request());expect(response.status).toBe(status);expect(await response.text()).not.toContain('sb_secret');}
 const source=store();source.admit=vi.fn(async()=>{throw Error('PRIVATE');});const response=await serve(source)(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');
});
it('keeps the new endpoint disabled without both installation-owned feature choices and private settings',async()=>{
 for(const enabled of [undefined,'false','true']){vi.resetModules();let handler:((r:Request)=>Promise<Response>)|undefined;vi.stubGlobal('Deno',{env:{get:(name:string)=>name==='MISE_STAFF_STOCK_WRITES_ENABLED'?enabled:undefined},serve:(fn:typeof handler)=>{handler=fn;}});await import('../supabase/functions/staff-stock-actions/index');expect((await handler!(request())).status).toBe(503);}
});
it('rejects oversized declarations and cancels a stalled original body without dispatching a visit',async()=>{
 const source=store();expect((await serve(source)(request(undefined,{'Content-Length':String(64*1024*1024+1)}))).status).toBe(413);expect(source.visit).not.toHaveBeenCalled();
 vi.useFakeTimers();let cancelled=false;const req=new Request('https://backend.example.invalid/functions/v1/staff-stock-actions',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+device,'Content-Type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit),result=serve(source)(req);await vi.advanceTimersByTimeAsync(5000);expect((await result).status).toBe(408);expect(cancelled).toBe(true);expect(source.visit).not.toHaveBeenCalled();
});
