import {parseStaffPublicRequest,parseStaffPublicOutcome,projectStaffView,type StaffPublicRequest} from '../../../packages/core/staff-links.ts';
import {AuthBodyError,authHttp,readAuthBody} from './auth-http.ts';
export interface StaffLinkLimits {global:number;link:number}
export interface StaffLinkStore {visit(input:StaffPublicRequest,limits:StaffLinkLimits):Promise<unknown>}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const unavailable=()=>Error('Staff links are unavailable.');
export function staffLinkLimits(global?:string,link?:string):StaffLinkLimits {
 const parse=(value:string|undefined,fallback:number)=>{if(value===undefined||value==='')return fallback;if(!/^[1-9]\d{0,4}$/.test(value)||Number(value)>60000)throw unavailable();return Number(value);};
 return {global:parse(global,600),link:parse(link,60)};
}
export function createStaffLinkHandler(deps:{store:StaffLinkStore;origins:ReadonlySet<string>;limits?:StaffLinkLimits}){
 const origins=new Set(deps.origins),limits={...deps.limits??staffLinkLimits()};
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||![limits.global,limits.link].every(v=>Number.isInteger(v)&&v>=1&&v<=60000))throw unavailable();
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
  const reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
  if(http.blocked)return secure(http.blocked);
  const url=new URL(request.url);if(url.search||!url.pathname.endsWith('/public/staff'))return reply(400,{error:'Use the complete staff link.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:StaffPublicRequest;
  try{input=parseStaffPublicRequest(await readAuthBody(request,8192));}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the original staff link and check-in.'});}
  try{
   const raw=await deps.store.visit(input,limits);if(!object(raw)||raw.v!==1)throw unavailable();
   if(raw.state==='view'){
    if(input.operation!=='read')throw unavailable();return reply(200,{v:1,state:'view',view:projectStaffView(raw.view,input.after)});
   }
   if(['pending','closed','applied'].includes(raw.state as string)){
    if(!input.intent||input.operation==='read')throw unavailable();return reply(raw.state==='pending'?202:200,parseStaffPublicOutcome(raw,input.intent));
   }
   if(raw.state==='limited'){
    if(!Number.isInteger(raw.retryAfter)||Number(raw.retryAfter)<1||Number(raw.retryAfter)>60)throw unavailable();
    return reply(429,{error:'This staff link is busy. Keep the original and try again shortly.'},{'Retry-After':String(raw.retryAfter)});
   }
   if(raw.state==='missing')return reply(404,{error:'This staff link is unavailable. Tell the manager by hand.'});
   if(raw.state==='changed')return reply(409,{error:'Presence or the original changed. Check or close this original before another tap.'});
   throw unavailable();
  }catch{return reply(503,{error:'The check-in is unconfirmed. Keep this original or tell the manager by hand.'});}
 };
}
/** The server chooses the only RPC, budgets and service credential. A full
 * response deadline/bound covers both headers and streamed body bytes. */
export function createStaffLinkStore(url:string,key:string,send:typeof fetch=fetch):StaffLinkStore {
 const root=new URL(url);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(key))throw unavailable();
 return {async visit(input,limits){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},15000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/visit_staff_link',root),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
    headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({p_token:input.token,p_operation:input.operation,p_intent:input.intent,p_after:input.after,p_global_limit:limits.global,p_link_limit:limits.link})}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>8388608)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }};
}
