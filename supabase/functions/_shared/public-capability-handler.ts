import {parseCustomerLinkRequest,projectCustomerLink,type CustomerLinkRequest} from '../../../packages/core/customer-links.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';

export interface PublicReadLimits {global:number;link:number}
export interface PublicCapabilityStore {read(request:CustomerLinkRequest,limits:PublicReadLimits):Promise<unknown>}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const unavailable=()=>Error('Customer links are unavailable.');
export function publicReadLimits(global?:string,link?:string):PublicReadLimits {
 const parse=(value:string|undefined,fallback:number)=>{if(value===undefined||value==='')return fallback;if(!/^[1-9]\d{0,4}$/.test(value)||Number(value)>60000)throw unavailable();return Number(value);};
 return {global:parse(global,3000),link:parse(link,60)};
}
export function createPublicCapabilityHandler(deps:{store:PublicCapabilityStore;origins:ReadonlySet<string>;limits?:PublicReadLimits}) {
 const origins=new Set(deps.origins),limits={...deps.limits??publicReadLimits()};
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||![limits.global,limits.link].every(value=>Number.isInteger(value)&&value>=1&&value<=60000))throw unavailable();
 const secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
  if(http.blocked)return secure(http.blocked);
  if(new URL(request.url).search)return reply(400,{error:'Put the customer link in the request body.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:CustomerLinkRequest;
  try{input=parseCustomerLinkRequest(await readAuthBody(request,1024));}
  catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Use one complete customer link.'});}
  try{
   const result=await deps.store.read(input,limits);
   if(!object(result)||result.v!==1)throw unavailable();
   if(result.state==='missing')return reply(404,{error:'This link is unavailable. Ask the shop for a current link.'});
   if(result.state==='limited'){
    if(typeof result.retryAfter!=='number'||!Number.isInteger(result.retryAfter)||result.retryAfter<1||result.retryAfter>60)throw unavailable();
    return reply(429,{error:'Link reads are busy. Try again shortly.'},{'Retry-After':String(result.retryAfter)});
   }
   if(result.state!=='ok')throw unavailable();
   return reply(200,projectCustomerLink(result.data,input));
  }catch{return reply(503,{error:'Customer links are unavailable. Try again later or contact the shop.'});}
 };
}

/** Only this fixed RPC is reachable. Neither browser input nor the transport
 * supplies resource IDs, SQL, a clock, the role, or a caller-selected limit. */
export function createPublicCapabilityStore(url:string,serviceKey:string,send:typeof fetch=fetch):PublicCapabilityStore {
 const root=new URL(url);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw unavailable();
 return {async read(input,limits){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/read_public_capability',root),{method:'POST',redirect:'error',signal:controller.signal,
    headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify({p_token:input.token,p_kind:input.kind,p_after_sequence:input.afterSequence,p_page_size:input.pageSize,p_global_limit:limits.global,p_link_limit:limits.link})}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>8*1024*1024)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }};
}
