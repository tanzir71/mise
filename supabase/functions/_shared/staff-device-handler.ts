import {parseStaffDeviceRequest,parseStaffDeviceView,parseStaffDeviceOutcome,type StaffDeviceRequest} from '../../../packages/core/staff-device.ts';
import {AuthBodyError,authHttp,readAuthBody} from './auth-http.ts';
export interface StaffDeviceStore {visit(deviceToken:string,input:StaffDeviceRequest,limit:number):Promise<unknown>}
const unavailable=()=>Error('Shared-screen attendance is unavailable.');
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function staffDeviceLimit(value?:string):number {
 if(value===undefined||value==='')return 600;
 if(!/^[1-9]\d{0,4}$/.test(value)||Number(value)>60000)throw unavailable();return Number(value);
}
export function createStaffDeviceHandler(deps:{store:StaffDeviceStore;origins:ReadonlySet<string>;limit?:number}){
 const origins=new Set(deps.origins),limit=deps.limit??staffDeviceLimit();
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||!Number.isInteger(limit)||limit<1||limit>60000)throw unavailable();
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
  const reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
  if(http.blocked)return secure(http.blocked);
  const url=new URL(request.url);if(url.search||!url.pathname.endsWith('/staff-device'))return reply(400,{error:'Use this enrolled screen’s attendance control.'});
  const deviceToken=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!deviceToken)return reply(401,{error:'Sign in on this enrolled screen with your own PIN.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:StaffDeviceRequest;
  try{input=parseStaffDeviceRequest(await readAuthBody(request,8192));}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the original check-in on this screen.'});}
  try{
   const raw=await deps.store.visit(deviceToken,input,limit);if(!object(raw)||raw.v!==1)throw unavailable();
   if(raw.state==='view'){
    if(input.operation!=='read')throw unavailable();return reply(200,parseStaffDeviceView(raw,input.after,undefined,true));
   }
   if(['pending','closed','applied'].includes(raw.state as string)){
    if(input.operation==='read'||!input.intent)throw unavailable();return reply(raw.state==='pending'?202:200,parseStaffDeviceOutcome(raw,input.intent));
   }
   if(raw.state==='limited'){
    if(!Number.isInteger(raw.retryAfter)||Number(raw.retryAfter)<1||Number(raw.retryAfter)>60)throw unavailable();
    return reply(429,{error:'This screen is busy. Keep the original and try again shortly.'},{'Retry-After':String(raw.retryAfter)});
   }
   if(raw.state==='missing')return reply(401,{error:'Attendance access changed. Use your own PIN or tell the manager by hand.'});
   if(raw.state==='changed')return reply(409,{error:'Presence or the original changed. Check or close this original before another tap.'});
   throw unavailable();
  }catch{return reply(503,{error:'The check-in is unconfirmed. Keep this original or tell the manager by hand.'});}
 };
}
/** Only this fixed service RPC accepts the device/session pair. The installer’s
 * service key stays in a private header; the deadline covers the whole body. */
export function createStaffDeviceStore(url:string,key:string,send:typeof fetch=fetch):StaffDeviceStore {
 const root=new URL(url);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(key))throw unavailable();
 return {async visit(deviceToken,input,limit){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},15000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/visit_staff_device',root),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
    headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({p_device_token:deviceToken,p_session_token:input.sessionToken,p_operation:input.operation,p_intent:input.intent,p_after:input.after,p_request_limit:limit})}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>8388608)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }};
}
