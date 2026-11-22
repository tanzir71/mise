import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceId} from '../../../packages/core/device-access.ts';
import {parseDeskApplicationKey,parseDeskPushContext,parseDeskPushMetadata,parseDeskPushSubscription,type DeskPushSubscription} from '../../../packages/core/desk-push.ts';
export class DeskPushDenied extends Error {constructor(readonly status:400|401|403|409|429){super('Desk notification request was not accepted.');}}
export interface DeskNotificationsStore {
 context(jwt:string,outletId:string):Promise<unknown>;
 register(jwt:string,id:string,outletId:string,eventId:string,applicationKey:string,subscription:DeskPushSubscription):Promise<unknown>;
 read(jwt:string,id:string):Promise<unknown>;
 revoke(jwt:string,id:string,eventId:string):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Desk notifications are unavailable.');
/** Only the original phone JWT reaches SQL; the service identity is never used.
 * Reading/revoking one's own capability stays available without VAPID config. */
export function createDeskNotificationsHandler(deps:{store:DeskNotificationsStore;origins:ReadonlySet<string>;applicationKey?:string}){
 const origins=new Set(deps.origins);let applicationKey:string|undefined;
 try{applicationKey=parseDeskApplicationKey(deps.applicationKey);}catch{/* Cleanup remains available. */}
 return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
  const header=request.headers.get('authorization')??'',jwt=header.length<=8192?header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
  if(!jwt)return reply(401,{error:'Sign in with the original phone account.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:unknown;try{input=await readAuthBody(request,8192);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Review this desk notification request.'});}
  if(!object(input))return reply(400,{error:'Choose a desk notification action.'});
  if(input.action==='configuration'){
   if(!exact(input,'action,outletId')||!isDeviceId(input.outletId))return reply(400,{error:'Choose an assigned outlet.'});
  }else if(input.action==='register'){
   if(!exact(input,'action,id,outletId,eventId,applicationKey,subscription')||![input.id,input.outletId,input.eventId].every(isDeviceId)||input.id===input.eventId)return reply(400,{error:'Keep the original desk notification setup.'});
   try{parseDeskPushSubscription(input.subscription);}catch{return reply(400,{error:'Enable notifications again on this desk.'});}
  }else if(input.action==='read'||input.action==='revoke'){
   if(!exact(input,input.action==='read'?'action,id':'action,id,eventId')||!isDeviceId(input.id)||input.action==='revoke'&&(!isDeviceId(input.eventId)||input.id===input.eventId))return reply(400,{error:'Keep the original desk notification device.'});
  }else return reply(400,{error:'Choose a desk notification action.'});
  try{
   if(input.action==='configuration'){
    if(!applicationKey)throw unavailable();const context=parseDeskPushContext(await deps.store.context(jwt,input.outletId as string));
    if(context.outletId!==input.outletId)throw unavailable();return reply(200,{v:1,context,applicationKey});
   }
   if(input.action==='register'){
    if(!applicationKey)throw unavailable();if(input.applicationKey!==applicationKey)return reply(409,{error:'Refresh the current notification key before enabling this desk.'});
    const result=parseDeskPushMetadata(await deps.store.register(jwt,input.id as string,input.outletId as string,input.eventId as string,applicationKey,parseDeskPushSubscription(input.subscription)));
    if(result.id!==input.id||result.outletId!==input.outletId||result.revokedAt!==null)throw unavailable();return reply(200,result);
   }
   const raw=input.action==='read'?await deps.store.read(jwt,input.id as string):await deps.store.revoke(jwt,input.id as string,input.eventId as string);
   if(raw===null)return reply(200,null);const result=parseDeskPushMetadata(raw);
   if(result.id!==input.id||input.action==='revoke'&&result.revokedAt===null)throw unavailable();return reply(200,result);
  }catch(error){
   if(error instanceof DeskPushDenied)return reply(error.status,{error:error.status===401?'Sign in with the original phone account.':error.status===403?'Open an assigned outlet with your phone account.':error.status===429?(input.action==='revoke'?'Keep this original withdrawal and retry later.':'Remove an earlier notification device first.'):'Review the original notification setup before retrying.'});
   return reply(503,{error:'Desk notifications are unconfirmed. Keep the original setup and retry.'});
  }
 };
}
export function createDeskNotificationsStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch):DeskNotificationsStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw unavailable();
 async function rpc(jwt:string,name:string,body:Record<string,unknown>){
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:controller.signal,
    headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if([400,401,403,409,429].includes(response.status))throw new DeskPushDenied(response.status as 400|401|403|409|429);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>131072)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 return {context:(jwt,outlet)=>rpc(jwt,'desk_push_context',{p_outlet_id:outlet}),
  register:(jwt,id,outlet,event,applicationKey,subscription)=>rpc(jwt,'register_desk_push',{p_id:id,p_outlet_id:outlet,p_endpoint:subscription.endpoint,p_p256dh:subscription.keys.p256dh,p_auth:subscription.keys.auth,p_application_key:applicationKey,p_expires_at:subscription.expirationTime,p_event_id:event}),
  read:(jwt,id)=>rpc(jwt,'read_desk_push',{p_id:id}),revoke:(jwt,id,event)=>rpc(jwt,'revoke_desk_push',{p_id:id,p_event_id:event})};
}
