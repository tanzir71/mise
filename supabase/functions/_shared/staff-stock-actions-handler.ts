import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {newInboxId} from '../../../packages/core/inbox.ts';
import {isDeviceId} from '../../../packages/core/device-access.ts';
import {parseStaffStockActionRequest,parseStaffStockPrepared,parseOwnStaffStockOutcome,staffStockIntentHash,staffStockRpcFields,staffStockActionBodyLimit,type StaffStockActionRequest,type StaffStockIntent} from '../../../packages/core/staff-stock-actions.ts';
import {staffStockLimit} from './staff-stock-handler.ts';
export class StaffStockActionStoreError extends Error {constructor(readonly status:401|409|429|503){super('Staff stock request unavailable.');}}
export interface StaffStockActionsStore {
 admit(device:string,limit:number):Promise<unknown>;
 visit(device:string,session:string,operation:'prepare'|'inspect'|'close',intent:StaffStockIntent,hash:string,ticketId:string|null):Promise<unknown>;
 finish(device:string,input:Extract<StaffStockActionRequest,{operation:'commit'}>,hash:string):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function createStaffStockActionsHandler(deps:{store:StaffStockActionsStore;origins:ReadonlySet<string>;limit?:number;newId?:()=>string}){
 const origins=new Set(deps.origins),limit=deps.limit??staffStockLimit(),newId=deps.newId??newInboxId;
 if(!origins.size||[...origins].some(v=>new URL(v).origin!==v)||!Number.isInteger(limit)||limit<1||limit>60000)throw new StaffStockActionStoreError(503);
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),secure=(r:Response)=>{r.headers.set('Referrer-Policy','no-referrer');r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");r.headers.set('Access-Control-Expose-Headers','Retry-After');return r;};
  const reply=(code:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(code,value,headers));
  if(http.blocked)return secure(http.blocked);
  const url=new URL(request.url),device=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(url.search||!url.pathname.endsWith('/staff-stock-actions'))return reply(400,{error:'Use this screen’s stock review.'});
  if(!device)return reply(401,{error:'Use your own PIN on this enrolled screen.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  try{
   // An actual enrolled device and its shared server-minute budget are checked
   // before reading a potentially large complete imported source.
   const admitted=await deps.store.admit(device,limit);
   if(object(admitted)&&exact(admitted,'state')&&admitted.state==='missing')return reply(401,{error:'Use your own PIN on this enrolled screen.'});
   if(object(admitted)&&exact(admitted,'state,retryAfter')&&admitted.state==='limited'&&Number.isInteger(admitted.retryAfter)&&Number(admitted.retryAfter)>=1&&Number(admitted.retryAfter)<=60)return reply(429,{error:'This screen is busy. Keep the original request and try shortly.'},{'Retry-After':String(admitted.retryAfter)});
   if(!object(admitted)||!exact(admitted,'state')||admitted.state!=='allowed')throw new StaffStockActionStoreError(503);
   let input:StaffStockActionRequest;
   try{input=parseStaffStockActionRequest(await readAuthBody(request,staffStockActionBodyLimit));}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the complete original stock request.'});}
   const hash=await staffStockIntentHash(input.intent);
   let result:unknown;
   if(input.operation==='commit'){
    // Inspection after a lost reply needs only own-original recovery rights.
    result=await deps.store.visit(device,input.sessionToken,'inspect',input.intent,hash,null);
    if(!(object(result)&&exact(result,'state')&&result.state==='missing')){
     const inspected=parseOwnStaffStockOutcome(result,input.intent,hash);
     if(inspected.state==='pending')result=await deps.store.finish(device,input,hash);
    }
   }else{
    const ticket=input.operation==='prepare'?newId():null;if(ticket!==null&&!isDeviceId(ticket))throw new StaffStockActionStoreError(503);
    result=await deps.store.visit(device,input.sessionToken,input.operation,input.intent,hash,ticket);
   }
   if(object(result)&&exact(result,'state')&&result.state==='missing')return reply(401,{error:'Stock access changed. Keep the original request or tell the manager by hand.'});
   if(input.operation==='prepare'&&object(result)&&result.state==='review')return reply(200,parseStaffStockPrepared(result,input.intent,hash));
   const outcome=parseOwnStaffStockOutcome(result,input.intent,hash);
   if(input.operation==='commit'&&outcome.state==='pending'||input.operation==='close'&&outcome.state==='pending')throw new StaffStockActionStoreError(503);
   return reply(200,outcome);
  }catch(error){const status=error instanceof StaffStockActionStoreError?error.status:503;
   return reply(status,{error:status===401?'Use your own PIN again. Keep the original stock request.':status===409?'This stock comparison changed. Keep the original request and review it again.':status===429?'Finish saved reviews or try again shortly.':'Stock is unconfirmed. Keep the original request or tell the manager by hand.'},status===429?{'Retry-After':'60'}:{});
  }
 };
}
/** No client-selected RPC, owner JWT or provider credential. Complete source
 * stays in one private text parameter; unit hashes avoid copying large units
 * twice. Responses contain native quantity reviews or small original receipts. */
export function createStaffStockActionsStore(apiUrl:string,key:string,send:typeof fetch=fetch):StaffStockActionsStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(key))throw new StaffStockActionStoreError(503);
 async function call(route:'admit_staff_stock_body'|'visit_staff_stock_original'|'finish_staff_stock_action',body:Record<string,unknown>){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new StaffStockActionStoreError(503));},60000);});
  try{
   const wire=JSON.stringify(body);if(new TextEncoder().encode(wire).byteLength>128*1024*1024)throw new StaffStockActionStoreError(503);
   response=await Promise.race([send(new URL('rest/v1/rpc/'+route,root),{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',body:wire,signal:controller.signal}),deadline]);
   if(!response.ok)throw new StaffStockActionStoreError(response.status===401||response.status===403?401:response.status===409?409:response.status===429?429:503);
   const reader=response.body?.getReader();if(!reader)throw new StaffStockActionStoreError(503);const parts:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>64*1024*1024)throw new StaffStockActionStoreError(503);parts.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }catch(error){if(error instanceof StaffStockActionStoreError)throw error;throw new StaffStockActionStoreError(503);}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 return {
  admit:(device,limit)=>call('admit_staff_stock_body',{p_device_token:device,p_request_limit:limit}),
  visit:async(device,session,operation,intent,hash,ticketId)=>call('visit_staff_stock_original',{p_device_token:device,p_session_token:session,p_operation:operation,...await staffStockRpcFields(intent,hash),p_ticket_id:ticketId}),
  finish:(device,input,hash)=>call('finish_staff_stock_action',{p_device_token:device,p_session_token:input.sessionToken,p_ticket_id:input.ticketId,p_token:input.token,p_review_hash:input.reviewHash,p_source_hash:hash}),
 };
}
