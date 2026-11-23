import {parseKhataRequest,parseKhataView,parseKhataOutcome,type KhataRequest} from '../../../packages/core/customer-khata.ts';
import {customerApiOrigin} from '../../../packages/core/customer-link-url.ts';
import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
export interface KhataLimits {global:number;link:number}
export interface CustomerKhataStore {visit(request:KhataRequest,limits:KhataLimits):Promise<unknown>}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bad=()=>Error('Khata requests are unavailable.');
export function khataLimits(global?:string,link?:string):KhataLimits {
 const parse=(v:string|undefined,fallback:number)=>{if(v===undefined||v==='')return fallback;if(!/^[1-9]\d{0,4}$/.test(v)||Number(v)>60000)throw bad();return Number(v);};return {global:parse(global,3000),link:parse(link,60)};
}
export function createCustomerKhataHandler(deps:{store:CustomerKhataStore;origins:ReadonlySet<string>;limits?:KhataLimits}){
 const origins=new Set(deps.origins),limits={...deps.limits??khataLimits()};if(!origins.size||[...origins].some(o=>new URL(o).origin!==o)||![limits.global,limits.link].every(n=>Number.isInteger(n)&&n>=1&&n<=60000))throw bad();
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),secure=(r:Response)=>{r.headers.set('Referrer-Policy','no-referrer');r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");r.headers.set('Access-Control-Expose-Headers','Retry-After');return r;},reply=(status:number,v:unknown,headers?:Record<string,string>)=>secure(http.reply(status,v,headers));
  if(http.blocked)return secure(http.blocked);const url=new URL(request.url);if(url.search||!url.pathname.endsWith('/public/khata'))return reply(400,{error:'Use the complete khata link.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))return reply(415,{error:'Use JSON.'});let input:KhataRequest;
  try{input=parseKhataRequest(await readAuthBody(request,32768));}catch(e){return reply(e instanceof AuthBodyError?e.status:400,{error:'Keep the original khata request.'});}
  try{
   const raw=await deps.store.visit(input,limits);if(!object(raw)||raw.v!==1)throw bad();
   if(raw.state==='view'){if(input.operation!=='read')throw bad();return reply(200,parseKhataView(raw,input.after,true));}
   if(['created','closed','pending'].includes(raw.state as string)){if(!input.intent||input.operation==='read')throw bad();const out=parseKhataOutcome(raw,input.intent);return reply(out.state==='pending'?202:200,out);}
   if(raw.state==='limited'){if(!Number.isInteger(raw.retryAfter)||Number(raw.retryAfter)<1||Number(raw.retryAfter)>60)throw bad();return reply(429,{error:'Wait before checking this original again.'},{'Retry-After':String(raw.retryAfter)});}
   if(raw.state==='missing')return reply(404,{error:'This khata link is unavailable. Ask the shop for a current link.'});
   if(raw.state==='changed')return reply(409,{error:'Keep the original request and check it before another change.'});
   return reply(503,{error:'The khata request is unconfirmed. Copy it for the shop.'});
  }catch{return reply(503,{error:'The khata request is unconfirmed. Copy it for the shop.'});}
 };
}
export function createCustomerKhataStore(api:string,key:string,send:typeof fetch=fetch):CustomerKhataStore {
 const root=customerApiOrigin(api)+'/';if(!key.trim())throw bad();return {async visit(input,limits){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(bad());},15000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/visit_customer_khata',root),{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({p_token:input.token,p_operation:input.operation,p_intent_json:input.intent===null?null:JSON.stringify(input.intent),p_after_sequence:input.after,p_global_limit:limits.global,p_link_limit:limits.link}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal}),deadline]);
   if(!response.ok)throw bad();const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>8388608))throw bad();const reader=response.body?.getReader();if(!reader)throw bad();const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;if(size>8388608)throw bad();chunks.push(part.value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }};
}
