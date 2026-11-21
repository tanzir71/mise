import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import {deviceSecretHash,isDeviceId,isDeviceToken,parseDeviceDirectory,parsePairingOutcome,parsePairingRequest,parseSharedDevice,parseStaffDeviceAccess} from '../../../packages/core/device-access.ts';
export interface DeviceAccessStore {
 request(id:string,code:string,pairingId:string|null,tokenHash:string):Promise<unknown>;
 poll(id:string,secret:string):Promise<unknown>;
 directory(secret:string,after:string|null,limit:number):Promise<unknown>;
 session(secret:string,sessionToken:string):Promise<unknown>;
 logout(secret:string,sessionToken:string,eventId:string):Promise<unknown>;
 reset(secret:string,id:string,attemptId:string|null):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function createDeviceAccessHandler(deps:{store:DeviceAccessStore;origins:ReadonlySet<string>;newId?:()=>string}){
 const origins=new Set(deps.origins),newId=deps.newId??deviceAuthId;
 return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
  const secret=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!secret)return reply(401,{error:'Check this screen’s original enrollment.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  let input:unknown;try{input=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the screen request.'});}
  if(!object(input)||typeof input.action!=='string')return reply(400,{error:'Choose a screen access action.'});
  const action=input.action;
  if(action==='request'&&(!exact(input,'action,id,code,pairingId')||!isDeviceId(input.id)||typeof input.code!=='string'||!/^\d{6}$/.test(input.code)||input.pairingId!==null&&!isDeviceId(input.pairingId)))return reply(400,{error:'Check the pairing code and original request.'});
  if(action==='poll'&&(!exact(input,'action,id')||!isDeviceId(input.id)))return reply(400,{error:'Keep the original screen request.'});
  if(action==='directory'&&(!exact(input,'action,after,limit')||input.after!==null&&!isDeviceId(input.after)||typeof input.limit!=='number'||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100))return reply(400,{error:'Check the staff page request.'});
  if((action==='session'||action==='logout')&&(!exact(input,'action,sessionToken')||!isDeviceToken(input.sessionToken)))return reply(400,{error:'Keep the original staff session.'});
  if(action==='reset'&&(!exact(input,'action,id,attemptId')||!isDeviceId(input.id)||input.attemptId!==null&&!isDeviceId(input.attemptId)||input.id===input.attemptId))return reply(400,{error:'Keep the original screen sign-out.'});
  if(!['request','poll','directory','session','logout','reset'].includes(action))return reply(400,{error:'Choose a screen access action.'});
  try{
   if(action==='request'){
    const id=input.id as string,tokenHash=await deviceSecretHash(secret),value=await deps.store.request(id,input.code as string,input.pairingId as string|null,tokenHash);
    return value===null?reply(400,{error:'Check the pairing code, or ask the owner for a new one.'}):reply(200,parsePairingRequest(value,{id,tokenHash}));
   }
   if(action==='poll'){
    const id=input.id as string,value=await deps.store.poll(id,secret);return value===null?reply(401,{error:'Check this screen’s original request.'}):reply(200,parsePairingOutcome(value,{id,tokenHash:await deviceSecretHash(secret)}));
   }
   if(action==='directory'){
    const value=await deps.store.directory(secret,input.after as string|null,input.limit as number);if(value===null)return reply(401,{error:'This screen needs a current enrollment.'});
    if(!object(value))throw Error('Invalid directory');return reply(200,parseDeviceDirectory(value,parseSharedDevice(value.device),input.after as string|null,input.limit as number));
   }
   if(action==='session'){
    const value=await deps.store.session(secret,input.sessionToken as string);return value===null?reply(401,{error:'Sign in with your PIN again.'}):reply(200,parseStaffDeviceAccess(value));
   }
   if(action==='reset'){
    const value=await deps.store.reset(secret,input.id as string,input.attemptId as string|null);
    if(value===null)return reply(401,{error:'Check this screen’s original enrollment.'});
    if(!object(value)||!exact(value,'id,deviceId,signedOut')||value.id!==input.id||!isDeviceId(value.deviceId)||value.signedOut!==true)throw Error('Invalid screen sign-out');
    return reply(200,{id:value.id,deviceId:value.deviceId,signedOut:true});
   }
   const value=await deps.store.logout(secret,input.sessionToken as string,newId());
   if(value===null)return reply(401,{error:'This staff session could not be confirmed.'});
   if(!object(value)||!exact(value,'sessionId,signedOut')||!isDeviceId(value.sessionId)||value.signedOut!==true)throw Error('Invalid sign-out');
   return reply(200,{sessionId:value.sessionId,signedOut:true});
  }catch{return reply(503,{error:'Screen access is unavailable. Keep the original request and try again.'});}
 };
}
/** Fixed service RPCs only. Credentials never enter URLs or response errors. */
export function createDeviceAccessStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):DeviceAccessStore{
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Screen access is not configured.');
 async function rpc(name:string,args:Record<string,unknown>){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  let abort:()=>void=()=>{};const expired=new Promise<never>((_,reject)=>{abort=()=>reject(Error('Screen access deadline reached'));controller.signal.addEventListener('abort',abort,{once:true});});
  try{
   const response=await Promise.race([send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)}),expired]);
   if(!response.ok){await response.body?.cancel();throw Error('Screen access unavailable');}
   const reader=response.body?.getReader();if(!reader)throw Error('Screen access unavailable');const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;size+=part.value.length;if(size>8000000)throw Error('Screen response exceeds its boundary');chunks.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.abort();}
 }
 return {
  request:(id,code,pairingId,tokenHash)=>rpc('request_device_pairing',{p_id:id,p_code:code,p_pairing_id:pairingId,p_token_hash:tokenHash}),
  poll:(id,secret)=>rpc('read_device_pairing',{p_request_id:id,p_device_secret:secret}),
  directory:(secret,after,limit)=>rpc('read_device_signin',{p_device_secret:secret,p_after_id:after,p_limit:limit}),
  session:(secret,sessionToken)=>rpc('read_device_session',{p_device_token:secret,p_session_token:sessionToken}),
  logout:(secret,sessionToken,eventId)=>rpc('end_device_session',{p_device_token:secret,p_session_token:sessionToken,p_event_id:eventId}),
  reset:(secret,id,attemptId)=>rpc('reset_device_signins',{p_device_secret:secret,p_id:id,p_attempt_id:attemptId}),
 };
}
