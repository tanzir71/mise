import {parseStaffStockPage,parseStaffStockRequest,type StaffStockRequest} from '../../../packages/core/staff-stock.ts';
import {AuthBodyError,authHttp,readAuthBody} from './auth-http.ts';
export interface StaffStockStore {read(deviceToken:string,input:StaffStockRequest,budget:number):Promise<unknown>}
export const staffStockResponseLimit=64*1024*1024;
const unavailable=()=>Error('Shared-screen stock is unavailable.');
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function staffStockLimit(value?:string):number {
 if(value===undefined||value==='')return 600;
 if(!/^[1-9]\d{0,4}$/.test(value)||Number(value)>60000)throw unavailable();return Number(value);
}
export function createStaffStockHandler(deps:{store:StaffStockStore;origins:ReadonlySet<string>;limit?:number}){
 const origins=new Set(deps.origins),limit=deps.limit??staffStockLimit();
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||!Number.isInteger(limit)||limit<1||limit>60000)throw unavailable();
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
  const reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
  if(http.blocked)return secure(http.blocked);
  const url=new URL(request.url);if(url.search||!url.pathname.endsWith('/staff-stock'))return reply(400,{error:'Use this enrolled screen’s stock control.'});
  const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!token)return reply(401,{error:'Use your own PIN on this enrolled screen.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:StaffStockRequest;
  try{input=parseStaffStockRequest(await readAuthBody(request,2048));}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the stock request.'});}
  try{
   const raw=await deps.store.read(token,input,limit);if(!object(raw)||raw.v!==1)throw unavailable();
   if(raw.state==='stock')return reply(200,parseStaffStockPage(raw,input.after,input.limit));
   if(raw.state==='missing'&&Object.keys(raw).sort().join(',')==='state,v')return reply(401,{error:'Stock access changed. Use your own PIN or tell the manager by hand.'});
   if(raw.state==='limited'&&Object.keys(raw).sort().join(',')==='retryAfter,state,v'&&Number.isInteger(raw.retryAfter)&&Number(raw.retryAfter)>=1&&Number(raw.retryAfter)<=60)
    return reply(429,{error:'This screen is busy. Try again shortly.'},{'Retry-After':String(raw.retryAfter)});
   throw unavailable();
  }catch{return reply(503,{error:'Current stock is unconfirmed. Try again or tell the manager by hand.'});}
 };
}
/** A fixed service-only RPC. The installation's private key stays on its
 * backend; a deadline and byte limit cover headers and the entire response. */
export function createStaffStockStore(url:string,key:string,send:typeof fetch=fetch):StaffStockStore {
 const root=new URL(url);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(key))throw unavailable();
 return {async read(token,input,budget){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},15000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/read_staff_stock_page',root),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
    headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({p_device_token:token,p_session_token:input.sessionToken,p_after_id:input.after,p_limit:input.limit,p_request_limit:budget})}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>staffStockResponseLimit)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }};
}
