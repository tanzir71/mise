import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceId} from '../../../packages/core/device-access.ts';
import {parseDeskApplicationKey,parseDeskPushContext} from '../../../packages/core/desk-push.ts';
import {parseUrgentInboxConsent,parseUrgentInboxClosure,parseUrgentInboxNotice,parseUrgentInboxTarget,parseUrgentInboxRegistration,type UrgentInboxNotice} from '../../../packages/core/urgent-inbox.ts';
export class UrgentInboxDenied extends Error {constructor(readonly status:400|401|403|409|429){super('Urgent notification request was not accepted.');}}
export interface UrgentInboxNotificationsStore {
 context(jwt:string,outlet:string):Promise<unknown>;
 register(jwt:string,id:string,subscription:string,event:string):Promise<unknown>;
 inspect(jwt:string,id:string,subscription:string,event:string):Promise<unknown>;
 read(jwt:string,id:string):Promise<unknown>;
 withdraw(jwt:string,id:string,event:string):Promise<unknown>;
 target(jwt:string,notice:UrgentInboxNotice):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Urgent Inbox notifications are unavailable.');
/** Original phone JWT reaches SQL. Cleanup remains usable when the worker is
 * disabled or VAPID settings are absent; configuration never returns secrets. */
export function createUrgentInboxNotificationsHandler(deps:{store:UrgentInboxNotificationsStore;origins:ReadonlySet<string>;enabled:boolean;applicationKey?:string}) {
 const origins=new Set(deps.origins);let applicationKey:string|undefined;
 try{applicationKey=parseDeskApplicationKey(deps.applicationKey);}catch{/* Original cleanup does not need a delivery key. */}
 return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
  const header=request.headers.get('authorization')??'',jwt=header.length<=8192?header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
  if(!jwt)return reply(401,{error:'Sign in with the original phone account.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:unknown;try{input=await readAuthBody(request,4096);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the complete original notification choice.'});}
  if(!object(input))return reply(400,{error:'Choose an urgent notification action.'});
  if(input.action==='configuration'){
   if(!exact(input,'action,outletId')||!isDeviceId(input.outletId))return reply(400,{error:'Choose an assigned outlet.'});
  }else if(input.action==='register'||input.action==='inspect'){
   if(!exact(input,'action,id,subscriptionId,eventId')||![input.id,input.subscriptionId,input.eventId].every(isDeviceId)||new Set([input.id,input.subscriptionId,input.eventId]).size!==3)return reply(400,{error:'Keep the original consent and desk.'});
  }else if(input.action==='read'||input.action==='withdraw'){
   if(!exact(input,input.action==='read'?'action,id':'action,id,eventId')||!isDeviceId(input.id)||input.action==='withdraw'&&(!isDeviceId(input.eventId)||input.id===input.eventId))return reply(400,{error:'Keep the original consent and event.'});
  }else if(input.action==='target'){
   if(!exact(input,'action,notice'))return reply(400,{error:'Keep the original alert.'});try{parseUrgentInboxNotice(input.notice);}catch{return reply(400,{error:'Keep the original alert.'});}
  }else return reply(400,{error:'Choose an urgent notification action.'});
  try{
   if(input.action==='configuration'){
    if(!deps.enabled||!applicationKey)throw unavailable();const context=parseDeskPushContext(await deps.store.context(jwt,input.outletId as string));if(context.outletId!==input.outletId)throw unavailable();return reply(200,{v:1,context,applicationKey});
   }
   if(input.action==='register'){
    if(!deps.enabled||!applicationKey)throw unavailable();const result=parseUrgentInboxConsent(await deps.store.register(jwt,input.id as string,input.subscriptionId as string,input.eventId as string));
    if(result.id!==input.id||result.subscriptionId!==input.subscriptionId||result.revokedAt!==null)throw unavailable();return reply(200,result);
   }
   if(input.action==='inspect'){const raw=await deps.store.inspect(jwt,input.id as string,input.subscriptionId as string,input.eventId as string);return reply(200,raw===null?null:parseUrgentInboxRegistration(raw,input.id as string,input.subscriptionId as string,input.eventId as string));}
   if(input.action==='withdraw')return reply(200,parseUrgentInboxClosure(await deps.store.withdraw(jwt,input.id as string,input.eventId as string),input.id as string,input.eventId as string));
   if(input.action==='read'){const raw=await deps.store.read(jwt,input.id as string);if(raw===null)return reply(200,null);const result=parseUrgentInboxConsent(raw);if(result.id!==input.id)throw unavailable();return reply(200,result);}
   if(!deps.enabled)throw unavailable();const notice=parseUrgentInboxNotice(input.notice);return reply(200,parseUrgentInboxTarget(await deps.store.target(jwt,notice),notice));
  }catch(error){
   if(error instanceof UrgentInboxDenied)return reply(error.status,{error:error.status===401?'Sign in with the original phone account.':error.status===403?'Use the original consent and a current assigned account.':error.status===429?'Keep this original withdrawal and retry later.':'Review the original notification choice before retrying.'});
   return reply(503,{error:'Urgent notifications are unavailable or unconfirmed. Keep the original choice and use Inbox.'});
  }
 };
}
export function createUrgentInboxNotificationsStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch):UrgentInboxNotificationsStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw unavailable();
 async function rpc(jwt:string,name:string,body:Record<string,unknown>){
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if([400,401,403,409,429].includes(response.status))throw new UrgentInboxDenied(response.status as 400|401|403|409|429);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>262144)throw unavailable();chunks.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 return {context:(jwt,outlet)=>rpc(jwt,'desk_push_context',{p_outlet_id:outlet}),register:(jwt,id,subscription,event)=>rpc(jwt,'register_urgent_inbox',{p_id:id,p_subscription_id:subscription,p_event_id:event}),inspect:(jwt,id,subscription,event)=>rpc(jwt,'inspect_urgent_inbox',{p_id:id,p_subscription_id:subscription,p_event_id:event}),read:(jwt,id)=>rpc(jwt,'read_urgent_inbox',{p_id:id}),withdraw:(jwt,id,event)=>rpc(jwt,'withdraw_urgent_inbox',{p_id:id,p_event_id:event}),target:(jwt,n)=>rpc(jwt,'read_urgent_inbox_target',{p_consent_id:n.consentId,p_subscription_id:n.subscriptionId,p_task_id:n.taskId,p_generation:n.generation})};
}
