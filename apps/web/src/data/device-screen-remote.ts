import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {deviceSecretHash,isDeviceId,isDeviceToken,pairingCode,parseDeviceDirectory,parsePairingOutcome,parsePairingRequest,parseSharedDevice,parseStaffDeviceAccess,parseStaffDeviceSession,type SharedDevice,type StaffDeviceSession} from '@mise/core/device-access';
import {bindCommandReceipt} from './command-request';
import {parseKitchenPage,parseKitchenChanges,type KitchenCursor} from '@mise/core/kitchen-tickets';
import {parseKitchenAction,parseKitchenReceipt,type KitchenAction} from '@mise/core/kitchen';
import type {StaffDeviceAccess} from '@mise/core/device-access';
import {parseKitchenCloseIntent,parseKitchenTapRecovery,parseRetainedKitchenTap,type KitchenCloseIntent,type RetainedKitchenTap} from '@mise/core/kitchen-recovery';
import {parseStaffDeviceView,parseStaffDeviceOutcome} from '@mise/core/staff-device';
import {parseStaffDeviceBoard} from '@mise/core/staff-device-board';
import {parseAttendanceIntent,type AttendanceIntent} from '@mise/core/staff-attendance';
import {parseStaffCursor,type StaffHistoryCursor} from '@mise/core/staff-links';

export class DeviceScreenRequestError extends Error {
 constructor(readonly kind:'auth'|'review'|'retry'|'backoff',readonly retryAt:number|null=null){
  super(kind==='auth'?'Check this screen’s enrollment or sign in with your PIN again.':kind==='review'?'The screen changed. Reopen its current setup before continuing.':kind==='backoff'?'This screen has reached its request limit. Wait before trying again.':'This request is unconfirmed. Keep the original screen setup and try again.');
 }
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const responseLimit=8000000;
/** Device-only transport. Owner Auth and shop storage are never consulted.
 * The caller must also compare its durable journal revision before saving a
 * response: an in-memory receipt cannot replace an IndexedDB transaction. */
export function createDeviceScreenRemote(input:{connection:CloudConnection;requestId:string;token:string},assertCurrent:()=>void,send:typeof fetch=fetch){
 const config=parseCloudConnection(input.connection),requestId=input.requestId,token=input.token;
 if(!isDeviceId(requestId)||!isDeviceToken(token)||typeof assertCurrent!=='function')throw new DeviceScreenRequestError('review');
 function current(){try{const value:unknown=assertCurrent();if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw Error();}}catch{throw new DeviceScreenRequestError('review');}}
 function checked<T extends object>(value:T):T{current();return bindCommandReceipt(value,current);}
 function pinned(value:SharedDevice){const d=parseSharedDevice(value);if(d.id!==requestId||d.revokedAt!==null)throw new DeviceScreenRequestError('review');return d;}
 function session(value:StaffDeviceSession,device:SharedDevice){return parseStaffDeviceSession(value,{deviceId:device.id,memberId:value.memberId});}
 async function call(route:'device-access'|'device-pin'|'kitchen-tickets'|'kitchen-actions'|'kitchen-recovery'|'staff-device',body:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
  // Serialize before the first await, so form/selection mutations cannot alter
  // an already prepared request. No credential is ever added to the URL.
  const serialized=JSON.stringify(body),controller=new AbortController(),lifetime=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),30000);let response:Response|undefined;
  const abortable=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
   const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new DeviceScreenRequestError('retry'));};
   if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});
   promise.then(value=>{lifetime.removeEventListener('abort',stop);resolve(value);},error=>{lifetime.removeEventListener('abort',stop);reject(error);});
  });
  try{
   if(lifetime.aborted)throw new DeviceScreenRequestError('retry');current();
   response=await abortable(send(new URL('functions/v1/'+route,config.apiUrl+'/'),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:lifetime,headers:{apikey:config.publishableKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:serialized}));
   current();
   if([401,403].includes(response.status))throw new DeviceScreenRequestError('auth');
   if([400,409,413,415].includes(response.status))throw new DeviceScreenRequestError('review');
   if(!response.ok&&response.status!==429)throw new DeviceScreenRequestError('retry');
   const maximum=route==='kitchen-tickets'?32*1024*1024:responseLimit;
   const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new DeviceScreenRequestError('retry');
   const reader=response.body?.getReader();if(!reader)throw new DeviceScreenRequestError('retry');const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await abortable(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw new DeviceScreenRequestError('retry');chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));current();
   if(lifetime.aborted)throw new DeviceScreenRequestError('retry');
   if(response.status===429){
    // Provider/error bodies never escape this boundary. Only a bounded time is
    // retained to disable PIN retries; it never grants a session.
    const retryHeader=response.headers.get('Retry-After'),retryAt=route==='staff-device'?Date.now()+((retryHeader&&/^[1-9]\d?$/.test(retryHeader)&&Number(retryHeader)<=60?Number(retryHeader):60)*1000):object(value)&&typeof value.retryAt==='number'&&Number.isSafeInteger(value.retryAt)&&value.retryAt>=0&&value.retryAt<=8640000000000000?value.retryAt:null;
    throw new DeviceScreenRequestError('backoff',retryAt);
   }
   return value;
  }catch(error){void response?.body?.cancel().catch(()=>{});if(error instanceof DeviceScreenRequestError)throw error;throw new DeviceScreenRequestError('retry');}
  finally{clearTimeout(timer);controller.abort();}
 }
 return {
  async staffView(device:SharedDevice,input:StaffDeviceSession,after:StaffHistoryCursor|null=null,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original),cursor=parseStaffCursor(after);
   return checked(parseStaffDeviceView(await call('staff-device',{sessionToken:saved.token,operation:'read',intent:null,after:cursor},signal),cursor,{device:original,session:saved}));
  },
  async staffBoard(device:SharedDevice,input:StaffDeviceSession,after:string|null=null,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original);if(after!==null&&!isDeviceId(after))throw new DeviceScreenRequestError('review');
   return checked(parseStaffDeviceBoard(await call('staff-device',{sessionToken:saved.token,operation:'board',after},signal),after,{device:original,session:saved}));
  },
  async staffAttendance(device:SharedDevice,input:StaffDeviceSession,operation:'submit'|'inspect'|'close',source:AttendanceIntent,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original),intent=parseAttendanceIntent(source);
   if(intent.memberId!==saved.memberId||intent.outletId!==original.outletId)throw new DeviceScreenRequestError('review');
   return checked(parseStaffDeviceOutcome(await call('staff-device',{sessionToken:saved.token,operation,intent,after:null},signal),intent));
  },
  async tickets(device:SharedDevice,input:StaffDeviceSession,after:KitchenCursor|null=null,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original),cursor=after===null?null:{...after};
   const value=await call('kitchen-tickets',{action:'page',sessionToken:saved.token,after:cursor,limit:50},signal);
   return checked(await parseKitchenPage(value,{device:original,session:saved},cursor));
  },
  async ticketChanges(device:SharedDevice,input:StaffDeviceSession,afterSeq:number,untilSeq:number|null=null,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original);
   if(!Number.isSafeInteger(afterSeq)||afterSeq<0||untilSeq!==null&&(!Number.isSafeInteger(untilSeq)||untilSeq<afterSeq))throw new DeviceScreenRequestError('review');
   const value=await call('kitchen-tickets',{action:'changes',sessionToken:saved.token,afterSeq,untilSeq,limit:50},signal);
   return checked(await parseKitchenChanges(value,{device:original,session:saved},afterSeq,untilSeq));
  },
  async kitchenAction(device:SharedDevice,input:StaffDeviceSession,access:StaffDeviceAccess,inputAction:KitchenAction,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original),actor=parseStaffDeviceAccess(access,{device:original,session:saved}),action=parseKitchenAction(inputAction);
   return checked(parseKitchenReceipt(await call('kitchen-actions',{sessionToken:saved.token,action},signal),{action,access:actor}));
  },
  async recoverKitchenTap(device:SharedDevice,input:StaffDeviceSession,inputOriginal:RetainedKitchenTap,inputResolution:KitchenCloseIntent|null=null,signal?:AbortSignal){
   const originalDevice=pinned(device),saved=session(input,originalDevice),original=parseRetainedKitchenTap(inputOriginal);
   let resolution;
   if(inputResolution!==null){
    const actor=parseStaffDeviceAccess(inputResolution.access,{device:originalDevice,session:saved});
      const intent=parseKitchenCloseIntent(inputResolution,original.action,actor,original.memberId);
    resolution={id:intent.id,sessionId:actor.sessionId,memberId:actor.memberId,occurredAt:intent.occurredAt};
   }
   const value=await call('kitchen-recovery',resolution?{action:'close',sessionToken:saved.token,original,resolution}:{action:'lookup',sessionToken:saved.token,original},signal);
   return checked(parseKitchenTapRecovery(value,original,{device:originalDevice,session:saved}));
  },
  async request(code:string,pairingId:string|null,signal?:AbortSignal){
   const original={code:pairingCode(code),pairingId};if(pairingId!==null&&!isDeviceId(pairingId))throw new DeviceScreenRequestError('review');
   const hash=await deviceSecretHash(token);current();const value=await call('device-access',{action:'request',id:requestId,...original},signal);
   return checked(parsePairingRequest(value,{id:requestId,tokenHash:hash}));
  },
  async poll(signal?:AbortSignal){const hash=await deviceSecretHash(token);current();return checked(parsePairingOutcome(await call('device-access',{action:'poll',id:requestId},signal),{id:requestId,tokenHash:hash}));},
  async directory(device:SharedDevice,after:string|null=null,limit=50,signal?:AbortSignal){
   const original=pinned(device);if(after!==null&&!isDeviceId(after)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DeviceScreenRequestError('review');
   return checked(parseDeviceDirectory(await call('device-access',{action:'directory',after,limit},signal),original,after,limit));
  },
  async signIn(device:SharedDevice,attemptId:string,memberId:string,pin:string,signal?:AbortSignal){
   const original=pinned(device);if(!isDeviceId(attemptId)||!isDeviceId(memberId)||attemptId===original.id||typeof pin!=='string'||!/^\d{4}$/.test(pin))throw new DeviceScreenRequestError('review');
   const value=await call('device-pin',{attemptId,memberId,pin},signal);if(!object(value)||!exact(value,'session'))throw new DeviceScreenRequestError('review');
   return checked(parseStaffDeviceSession(value.session,{deviceId:original.id,memberId}));
  },
  async access(device:SharedDevice,input:StaffDeviceSession,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original);return checked(parseStaffDeviceAccess(await call('device-access',{action:'session',sessionToken:saved.token},signal),{device:original,session:saved}));
  },
  async logout(device:SharedDevice,input:StaffDeviceSession,signal?:AbortSignal){
   const original=pinned(device),saved=session(input,original),value=await call('device-access',{action:'logout',sessionToken:saved.token},signal);
   if(!object(value)||!exact(value,'sessionId,signedOut')||value.sessionId!==saved.id||value.signedOut!==true)throw new DeviceScreenRequestError('review');return checked({sessionId:saved.id,signedOut:true as const});
  },
  async reset(id:string,attemptId:string|null,signal?:AbortSignal){
   if(!isDeviceId(id)||attemptId!==null&&!isDeviceId(attemptId)||id===attemptId)throw new DeviceScreenRequestError('review');
   const value=await call('device-access',{action:'reset',id,attemptId},signal);
   if(!object(value)||!exact(value,'id,deviceId,signedOut')||value.id!==id||value.deviceId!==requestId||value.signedOut!==true)throw new DeviceScreenRequestError('review');
   return checked({id,deviceId:requestId,signedOut:true as const});
  },
 };
}
