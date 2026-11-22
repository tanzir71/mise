import {expect,it,vi} from 'vitest';
import {newInboxId} from '../packages/core/inbox';
import {orderFixture,ORDER_AT} from './order-fixture';
import {saveOrderCommand} from '../packages/core/orders';
import {parseCustomerLinkRequest,projectCustomerLink,type CustomerLinkRequest} from '../packages/core/customer-links';
import {createPublicCapabilityHandler,createPublicCapabilityStore,publicReadLimits} from '../supabase/functions/_shared/public-capability-handler';

const token='a'.repeat(43),origin='https://shop.example',base='https://backend.example/';
const request:CustomerLinkRequest={kind:'order',token,afterSequence:0,pageSize:50};
function data(order=orderFixture().order){return {v:1,kind:'order',shopNameJson:JSON.stringify('Shop বাংলা\u0000\ud800'),outletNameJson:JSON.stringify('Outlet'),shopLink:null,marketCode:'BD',order:{id:order.id,number:order.number,businessType:order.businessType,type:order.type,status:order.status,statusChangedAt:order.statusChangedAt,scheduledFor:order.scheduledFor??null,currency:order.currency,subtotal:order.subtotal,deliveryFee:order.deliveryFee,discount:order.discount,total:order.total,linesJson:JSON.stringify(order.lines),timezone:order.timezone,paymentStatus:order.payment.status}};}
const incoming=(body:unknown={kind:'order',token},headers:Record<string,string>={})=>new Request(base+'functions/v1/public-read',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const handler=(read=vi.fn(async()=>({v:1,state:'ok',data:data()})))=>({read,serve:createPublicCapabilityHandler({store:{read},origins:new Set([origin])})});

it.each(['restaurant','online_shop','food_stall','corner_shop']as const)('projects real %s domain lines, prices and literal Unicode without copying private upstream fields',businessType=>{
 const order=orderFixture(businessType).order,raw=data(order),line={...order.lines[0],merchantNote:'PRIVATE INTERNAL',token,authorization:'PRIVATE AUTH'};
 Object.assign(raw,{token,debug:'PRIVATE BACKEND'});Object.assign(raw.order,{customerPhone:'PRIVATE PHONE',sourceText:'PRIVATE SOURCE',notes:['PRIVATE MERCHANT']});raw.order.linesJson=JSON.stringify([line]);
 const result=projectCustomerLink(raw,request);expect(result.kind).toBe('order');if(result.kind!=='order')throw Error();
 expect(result.shop.name).toBe('Shop বাংলা\u0000\ud800');expect(result.order.lines).toEqual(order.lines);expect(result.order.total).toBe(order.total);expect(result.order.paymentStatus).toBe(order.payment.status);
 for(const value of [token,'PRIVATE INTERNAL','PRIVATE AUTH','PRIVATE PHONE','PRIVATE SOURCE','PRIVATE MERCHANT','PRIVATE BACKEND'])expect(JSON.stringify(result)).not.toContain(value);
 expect(result).not.toHaveProperty('businessId');expect(result.order).not.toHaveProperty('handledBy');
});
it('retains all 200 priced lines, original quantities and null totals for unpriced corner-shop work',()=>{
 const fixture=orderFixture(),lines=Array.from({length:200},(_,index)=>({...fixture.input.lines[0],name:'Line '+index,qty:0.001,unitPrice:1})),order=saveOrderCommand({...fixture.input,lines},fixture.context,null,0,ORDER_AT).order;
 const full=projectCustomerLink(data(order),request);expect(full.kind==='order'&&full.order.lines).toEqual(order.lines);expect(full.kind==='order'&&full.order.total).toBe(0);
 const pending=saveOrderCommand({...fixture.input,lines:[{...fixture.input.lines[0],unitPrice:null}]},fixture.context,null,0,ORDER_AT).order,result=projectCustomerLink(data(pending),request);
 expect(result.kind==='order'&&result.order.total).toBeNull();expect(result.kind==='order'&&result.order.lines[0].unitPrice).toBeNull();
});
it.each([{kind:'order',token,afterSequence:0},{kind:'order',token,pageSize:50},{kind:'khata',token,afterSequence:null},{kind:'khata',token,pageSize:null},{kind:'khata',token,afterSequence:9007199254740992},{kind:'khata',token,pageSize:101},{kind:'order',token,globalLimit:60000},{kind:'khata',token,accountId:newInboxId()},{kind:'order',token:'short'}])('rejects malformed or caller-selected read parameters %#',value=>{expect(()=>parseCustomerLinkRequest(value)).toThrow();});
it('uses complete default paging and accepts only a safe integer khata cursor',()=>{expect(parseCustomerLinkRequest({kind:'order',token})).toEqual(request);expect(parseCustomerLinkRequest({kind:'khata',token,afterSequence:9007199254740991,pageSize:100})).toEqual({kind:'khata',token,afterSequence:9007199254740991,pageSize:100});});
it.each(['id','businessType','statusChangedAt','currency','total','linesJson']as const)('fails closed for corrupted public order field %s',field=>{
 const raw=data();Object.assign(raw.order,{[field]:field==='total'?Number.MAX_SAFE_INTEGER:field==='linesJson'?'not JSON':null});expect(()=>projectCustomerLink(raw,request)).toThrow();
});
it('does not accept duplicate original line IDs or altered line totals',()=>{
 const raw=data(),line=JSON.parse(raw.order.linesJson)[0];raw.order.linesJson=JSON.stringify([line,line]);expect(()=>projectCustomerLink(raw,request)).toThrow();raw.order.linesJson=JSON.stringify([{...line,lineTotal:line.lineTotal+1}]);expect(()=>projectCustomerLink(raw,request)).toThrow();
});
it('retains literal khata names and exact deltas while rejecting a corrupt ledger page',()=>{
 const raw={v:1,kind:'khata',shopNameJson:JSON.stringify('Shop'),outletNameJson:JSON.stringify('Outlet'),shopLink:null,marketCode:'BD',account:{id:newInboxId(),customerNameJson:JSON.stringify('নাম\u0000\ud800'),currency:'BDT',balance:600,entries:[{id:newInboxId(),sequence:8,type:'payment',amount:400,delta:-400,at:ORDER_AT,reversalOf:null,methodNameJson:JSON.stringify('Cash'),note:'PRIVATE LEDGER',createdBy:'PRIVATE ACTOR'}],nextSequence:8,hasMore:false,timezone:'Asia/Dhaka',limit:999999,phone:'PRIVATE PHONE'}};
 const input:CustomerLinkRequest={kind:'khata',token,afterSequence:7,pageSize:2},result=projectCustomerLink(raw,input);expect(result.kind==='khata'&&result.account.customerName).toBe('নাম\u0000\ud800');expect(result.kind==='khata'&&result.account.entries[0].delta).toBe(-400);
 for(const value of ['PRIVATE LEDGER','PRIVATE ACTOR','PRIVATE PHONE'])expect(JSON.stringify(result)).not.toContain(value);
 raw.account.entries[0].delta=400;expect(()=>projectCustomerLink(raw,input)).toThrow();raw.account.entries[0].delta=-400;raw.account.nextSequence=9;expect(()=>projectCustomerLink(raw,input)).toThrow();
});
it('returns no-store JSON with an explicit origin, no referrer and no sniffable active content',async()=>{
 const {serve,read}=handler(),response=await serve(incoming());expect(response.status).toBe(200);expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");expect(read).toHaveBeenCalledWith(request,{global:3000,link:60});
});
it('preflights only configured origins and never reads a capability for invalid origins, methods, URL queries or media types',async()=>{
 const {serve,read}=handler();expect((await serve(new Request(base,{method:'OPTIONS',headers:{Origin:origin}}))).status).toBe(204);
 expect((await serve(incoming(undefined,{Origin:'https://foreign.example'})))).toMatchObject({status:403});expect((await serve(new Request(base,{method:'GET',headers:{Origin:origin}}))).status).toBe(405);
 expect((await serve(new Request(base+'?token='+token,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}))).status).toBe(400);
 expect((await serve(incoming(undefined,{'Content-Type':'text/plain'}))).status).toBe(415);expect(read).not.toHaveBeenCalled();
});
it('rejects oversized, malformed and invalid UTF-8 bodies before data access',async()=>{
 const {serve,read}=handler();expect((await serve(incoming({kind:'order',token,padding:'x'.repeat(1024)}))).status).toBe(413);
 for(const body of ['{',new Uint8Array([0xff])])expect((await serve(new Request(base,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body}))).status).toBe(400);
 expect(read).not.toHaveBeenCalled();
});
it('keeps missing, limited and failed backend outcomes generic and exposes only a bounded Retry-After',async()=>{
 const read=vi.fn<()=>Promise<unknown>>().mockResolvedValueOnce({v:1,state:'missing',token}).mockResolvedValueOnce({v:1,state:'limited',retryAfter:37,token}).mockRejectedValueOnce(Error('PRIVATE BACKEND '+token)).mockResolvedValueOnce({v:1,state:'limited',retryAfter:61});
 const serve=createPublicCapabilityHandler({store:{read},origins:new Set([origin])});
 for(const expected of [404,429,503,503]){const response=await serve(incoming());expect(response.status).toBe(expected);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Retry-After')).toBe(expected===429?'37':null);const body=await response.text();expect(body).not.toContain(token);expect(body).not.toContain('PRIVATE BACKEND');}
});
it('has installation-controlled defaults and rejects malformed limits rather than silently using them',()=>{
 expect(publicReadLimits()).toEqual({global:3000,link:60});expect(publicReadLimits('','')).toEqual({global:3000,link:60});expect(publicReadLimits('42','7')).toEqual({global:42,link:7});
 for(const value of ['0','60001','1.5','-2',' 60','1e3','NaN'])expect(()=>publicReadLimits(value,'60')).toThrow();
 expect(()=>createPublicCapabilityHandler({store:{read:vi.fn()},origins:new Set([origin]),limits:{global:0,link:1}})).toThrow();
});
it('uses one fixed HTTPS RPC, sends only a server apikey and cannot forward arbitrary caller parameters',async()=>{
 const send=vi.fn<typeof fetch>(async()=>Response.json({v:1,state:'missing'})),secret='sb_secret_test_only',store=createPublicCapabilityStore('https://project.example',secret,send);
 expect(await store.read(request,{global:42,link:7})).toEqual({v:1,state:'missing'});const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://project.example/rest/v1/rpc/read_public_capability');expect(options?.redirect).toBe('error');expect(new Headers(options?.headers).get('apikey')).toBe(secret);expect(new Headers(options?.headers).has('Authorization')).toBe(false);
 expect(JSON.parse(options?.body as string)).toEqual({p_token:token,p_kind:'order',p_after_sequence:0,p_page_size:50,p_global_limit:42,p_link_limit:7});expect(options?.signal?.aborted).toBe(true);
 for(const url of ['http://project.example','https://u:p@project.example','https://project.example/path','https://project.example?token=x'])expect(()=>createPublicCapabilityStore(url,secret,send)).toThrow();
});
it('does not leak upstream redirects, error bodies, malformed JSON or invalid UTF-8',async()=>{
 for(const response of [new Response('PRIVATE BACKEND',{status:500}),new Response(null,{status:302,headers:{Location:'https://foreign.example'}}),new Response('{'),new Response(new Uint8Array([0xff]))]){
  const store=createPublicCapabilityStore('https://project.example','sb_secret_test_only',vi.fn(async()=>response));await expect(store.read(request,{global:3,link:1})).rejects.toThrow();
 }
});
it('cancels a backend body that exceeds the complete eight MiB response budget',async()=>{
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel(){cancelled=true;}});
 const store=createPublicCapabilityStore('https://project.example','sb_secret_test_only',vi.fn(async()=>new Response(stream)));await expect(store.read(request,{global:3,link:1})).rejects.toThrow('Customer links are unavailable.');expect(cancelled).toBe(true);
});
it('bounds a backend that stalls before headers or partway through its response',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try{for(const partial of [false,true]){
  let signal:AbortSignal|undefined;const send:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;return partial?new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}})):new Promise<Response>(()=>{});};
  const pending=createPublicCapabilityStore('https://project.example','sb_secret_test_only',send).read(request,{global:3,link:1}),assertion=expect(pending).rejects.toThrow('Customer links are unavailable.');await vi.advanceTimersByTimeAsync(5001);await assertion;expect(signal?.aborted).toBe(true);
 }}finally{vi.useRealTimers();}
});
