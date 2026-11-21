import {expect,it,vi} from 'vitest';
import {createCustomerReviewHandler,createCustomerReviewStore,type CustomerReviewStore} from '../supabase/functions/_shared/customer-review';
import {commandReviewHeader} from '../packages/core/command-resolution';
import {customerReviewBodyLimit} from '../packages/core/customer-review-source';
import {prepareCustomerReviewView,customerReviewResponseLimit,customerReviewContextLimit} from '../packages/core/customer-review-view';
import {customerFingerprint} from '../packages/core/customer-commands';
import {fixture,id,replayContext} from './customer-review-fixture';

const origin='https://shop.test',jwt='user.original.signature';
function mock(){
 const store:CustomerReviewStore={admit:vi.fn(async()=>{}),prepare:vi.fn(async()=>({done:false,review:{checked:true}})),resolve:vi.fn(async()=>({checked:true}))};
 return {store,handler:createCustomerReviewHandler({store,origins:new Set([origin])})};
}
function request(body:unknown,options:{query?:string;method?:string;origin?:string;jwt?:string|null;outlet?:string|null;type?:string;raw?:string|Uint8Array;length?:number}={}){
 const method=options.method??'POST',headers=new Headers({Origin:options.origin??origin,'Content-Type':options.type??'application/json'});
 if(options.jwt!==null)headers.set('Authorization','Bearer '+(options.jwt??jwt));
 if(options.outlet!==null)headers.set(commandReviewHeader,options.outlet??(body as {command:{outletId:string}}).command.outletId);
 if(options.length!==undefined)headers.set('Content-Length',String(options.length));
 const payload=options.raw instanceof Uint8Array?new Uint8Array(options.raw):options.raw??JSON.stringify(body);
 return new Request('https://function.test/commands?'+(options.query??'review=customer-read'),{method,headers,...(method==='GET'||method==='OPTIONS'?{}:{body:payload})});
}
it.each([
 ['missing JWT',{jwt:null},401],['invalid JWT',{jwt:'not-a-bearer-token'},401],['oversized JWT',{jwt:'a.'+'a'.repeat(8200)+'.z'},401],
 ['wrong origin',{origin:'https://other.test'},403],['wrong method',{method:'GET'},405],['missing outlet',{outlet:null},400],['invalid outlet',{outlet:'unknown'},400],
 ['wrong mode',{query:'review=customer-delete'},400],['another family',{query:'review=stock-read'},400],['duplicate mode',{query:'review=customer-read&review=customer-read'},400],['extra query',{query:'review=customer-read&role=owner'},400],['wrong media type',{type:'text/plain'},415],
] as const)('rejects %s before reading or admitting a customer payload',async(_name,options,status)=>{
 const {handler,store}=mock(),f=fixture('update-contact'),response=await handler(request(f.packet,options));expect(response.status).toBe(status);expect(store.admit).not.toHaveBeenCalled();expect(store.prepare).not.toHaveBeenCalled();expect(store.resolve).not.toHaveBeenCalled();expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('admits the reviewed outlet before parsing a body and does not expose admission errors',async()=>{
 const f=fixture('update-contact'),calls:string[]=[],store=createCustomerReviewStore('https://database.test','sb_publishable_test_only','sb_secret_test_only',async(url)=>{calls.push(new URL(String(url)).pathname);return new Response(JSON.stringify({message:'Private database failure details'}),{status:403});}),handler=createCustomerReviewHandler({store,origins:new Set([origin])}),response=await handler(request(f.packet,{raw:'{'}));
 expect(response.status).toBe(403);expect(calls).toEqual(['/rest/v1/rpc/admit_customer_review']);expect(await response.text()).not.toContain('Private database');
});
it('refuses a header/body outlet mismatch without preparing a comparison',async()=>{
 const f=fixture('update-contact'),{handler,store}=mock(),response=await handler(request(f.packet,{outlet:id(800000)}));expect(response.status).toBe(400);expect(store.admit).toHaveBeenCalledWith(jwt,id(800000));expect(store.prepare).not.toHaveBeenCalled();
});
it.each(['malformed JSON','invalid UTF-8','unknown authority','changed command','changed source'])('refuses %s after admission without any customer write',async kind=>{
 const f=fixture('update-contact'),{handler,store}=mock();let body:unknown=f.packet;const options:{raw?:string|Uint8Array}={};
 if(kind==='malformed JSON')options.raw='{';else if(kind==='invalid UTF-8')options.raw=new Uint8Array([255]);else if(kind==='unknown authority')body={...f.packet,actorId:id(800000),role:'owner'};else if(kind==='changed command')body={...f.packet,command:{...f.command,customerId:id(800000)}};else body={...f.packet,sourceJson:f.packet.sourceJson+' '};
 const response=await handler(request(body,options));expect(response.status).toBe(400);expect(store.admit).toHaveBeenCalledOnce();expect(store.prepare).not.toHaveBeenCalled();expect(store.resolve).not.toHaveBeenCalled();
});
it.each(['declared','actual'])('enforces the %s complete-body bound after admission',async kind=>{
 const f=fixture('update-contact'),{handler,store}=mock(),response=await handler(request(f.packet,kind==='declared'?{length:customerReviewBodyLimit+1}:{raw:new Uint8Array(customerReviewBodyLimit+1)}));expect(response.status).toBe(413);expect(store.prepare).not.toHaveBeenCalled();
});
it('exposes only the approved review header and POST method in CORS preflight',async()=>{
 const f=fixture('update-contact'),{handler,store}=mock(),response=await handler(request(f.packet,{method:'OPTIONS'}));expect(response.status).toBe(204);expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);expect(response.headers.get('Access-Control-Allow-Headers')).toContain(commandReviewHeader.toLowerCase());expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');expect(store.admit).not.toHaveBeenCalled();
});
it.each(['https://user:password@database.test','https://database.test/other','https://database.test/?key=hidden','https://database.test/#fragment','http://database.test'])('refuses an unsafe deployment root %s',url=>{
 expect(()=>createCustomerReviewStore(url,'sb_publishable_test_only','sb_secret_test_only')).toThrow();
});
it('keeps the entire maximum imported note in a bounded response despite another JSON escaping layer',async()=>{
 const f=fixture('update-contact'),note='\\'.repeat(1_000_000),context=replayContext(f,{customer:{...f.customer,notes:note}}),current={stateHash:'c'.repeat(64),contextJson:context.contextJson,balances:[{accountId:f.account.id,balance:0}],phoneTaken:false,available:true},
  view=prepareCustomerReviewView({v:1,id:f.packet.id,replacementId:f.packet.replacementId,commandId:f.command.id,commandHash:await customerFingerprint(f.command),sourceHash:f.packet.sourceHash,businessId:context.businessId,outletId:context.outletId,actorId:context.actorId,token:'t'.repeat(43),at:context.at,expiresAt:context.at+120000},current,f.packet),{handler,store}=mock();
 vi.mocked(store.prepare).mockResolvedValue({done:false,review:view});const response=await handler(request(f.packet)),text=await response.text(),size=new TextEncoder().encode(text).length;
 expect(response.status).toBe(200);expect(new TextEncoder().encode(context.contextJson).length).toBeLessThan(customerReviewContextLimit);expect(size).toBeGreaterThan(4_000_000);expect(size).toBeLessThan(customerReviewResponseLimit);expect(JSON.parse(JSON.parse(text).review.current.contextJson).customer.notes).toBe(note);
});
