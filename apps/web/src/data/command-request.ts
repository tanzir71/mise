import {cloudConnectionTarget,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import {syncHash} from '@mise/core/sync-read';
import {stockReviewResponseLimit} from '@mise/core/stock-review-source';
import {customerReviewResponseLimit} from '@mise/core/customer-review-view';
import {closingReviewResponseLimit} from '@mise/core/closing-review-view';

export interface CommandAuthorization {jwt:string;userId:string;generation:number}
export interface CommandAccount {scope:string;accountHash:string;targetHash:string;getAuth:()=>Promise<CommandAuthorization>;assertCurrent:(value:CommandAuthorization)=>void}
export class CommandRequestError extends Error {
 constructor(readonly kind:'auth'|'review'|'retry'){
  super(kind==='auth'?'Sign in again with the original account before sending this change.':kind==='review'?'Review this saved action before retrying. Keep the local copy and its original ID.':'The change is unconfirmed. Keep the local copy and retry with the same command ID.');
 }
}
const responseLimit=2*1024*1024;
const receiptGuards=new WeakMap<object,()=>void>();
export interface CommandReviewProof {
 status:400|409|413|415;targetHash:string;accountHash:string;bodyHash:string;
 assertCurrent:()=>void;
}
const reviewGuards=new WeakMap<object,CommandReviewProof>();
/** Only an actual response verified against the uninterrupted original account
 * carries this proof. Serializing an error cannot manufacture one. */
export function commandReviewProof(error:unknown):CommandReviewProof|null {
 if(!error||typeof error!=='object')return null;
 const proof=reviewGuards.get(error);if(!proof)return null;
 proof.assertCurrent();return {...proof};
}
export function bindCommandReceipt<T extends object>(receipt:T,guard:()=>void):T {receiptGuards.set(receipt,guard);return receipt;}
/** Network receipts carry an ephemeral check; no session field is added to the record. */
export function assertCommandReceipt(receipt:object):void {receiptGuards.get(receipt)?.();}
/** Projection caches require a live HTTP proof; serialized metadata alone cannot
 * activate a private desk profile or replace its verified complete task list. */
export function assertLiveCommandReceipt(receipt:object):void {
 const guard=receiptGuards.get(receipt);if(!guard)throw new CommandRequestError('review');guard();
}
/** Runtime identity only. The account, connection and generation never enter a command. */
export function createAccountJsonRequest(config:CloudConnection,input:CommandAccount,route:'commands'|'migration-upload',send:typeof fetch){
 return accountRequest(config,input,new URL('functions/v1/'+route,config.apiUrl+'/'),'POST',send);
}
export type DeviceAdminRpc='read_device_admin'|'start_device_pairing'|'inspect_device_pairing'|'approve_device_pairing'|'cancel_device_pairing'|'revoke_device';
export function createDeviceAdminRequest(config:CloudConnection,input:CommandAccount,rpc:DeviceAdminRpc,send:typeof fetch){
 if(!['read_device_admin','start_device_pairing','inspect_device_pairing','approve_device_pairing','cancel_device_pairing','revoke_device'].includes(rpc))throw new CommandRequestError('review');
 return accountRequest(config,input,new URL('rest/v1/rpc/'+rpc,config.apiUrl+'/'),'POST',send,8000000);
}
export type CustomerLinkRpc='read_customer_link_page'|'create_public_link'|'revoke_public_link'|'read_public_link_attempt'|'close_public_link_attempt';
export function createCustomerLinkRequest(config:CloudConnection,input:CommandAccount,rpc:CustomerLinkRpc,send:typeof fetch){
 if(!['read_customer_link_page','create_public_link','revoke_public_link','read_public_link_attempt','close_public_link_attempt'].includes(rpc))throw new CommandRequestError('review');
 return accountRequest(config,input,new URL('rest/v1/rpc/'+rpc,config.apiUrl+'/'),'POST',send,131072);
}
export function createOwnerPinRequest(config:CloudConnection,input:CommandAccount,send:typeof fetch){
 return accountRequest(config,input,new URL('functions/v1/staff-pin',config.apiUrl+'/'),'POST',send);
}
export function createDeskNotificationsRequest(config:CloudConnection,input:CommandAccount,send:typeof fetch){
 return accountRequest(config,input,new URL('functions/v1/desk-notifications',config.apiUrl+'/'),'POST',send);
}
export type DeskAlarmRpc='read_kitchen_alarm_task_page'|'set_kitchen_alarm_settings';
export function createDeskAlarmRequest(config:CloudConnection,input:CommandAccount,rpc:DeskAlarmRpc,send:typeof fetch){
 if(!['read_kitchen_alarm_task_page','set_kitchen_alarm_settings'].includes(rpc))throw new CommandRequestError('review');
 return accountRequest(config,input,new URL('rest/v1/rpc/'+rpc,config.apiUrl+'/'),'POST',send);
}
export function createOrderReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review',mode);
 return accountRequest(config,input,endpoint,'POST',send);
}
export function createMoneyReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review','money-'+mode);
 return accountRequest(config,input,endpoint,'POST',send);
}
export function createPurchaseReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review','purchase-'+mode);
 return accountRequest(config,input,endpoint,'POST',send);
}
export function createStockReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review','stock-'+mode);
 return accountRequest(config,input,endpoint,'POST',send,stockReviewResponseLimit);
}
export function createCustomerReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review','customer-'+mode);
 return accountRequest(config,input,endpoint,'POST',send,customerReviewResponseLimit);
}
export function createClosingReviewRequest(config:CloudConnection,input:CommandAccount,mode:'read'|'resolve',send:typeof fetch){
 const endpoint=new URL('functions/v1/commands',config.apiUrl+'/');endpoint.searchParams.set('review','closing-'+mode);
 return accountRequest(config,input,endpoint,'POST',send,closingReviewResponseLimit);
}
export function createAccountImageRequest(config:CloudConnection,input:CommandAccount,imageId:string,send:typeof fetch){
 if(!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(imageId))throw new CommandRequestError('review');
 const endpoint=new URL('functions/v1/inbox-image',config.apiUrl+'/');endpoint.searchParams.set('image',imageId);
 return accountRequest(config,input,endpoint,'PUT',send);
}
function accountRequest(config:CloudConnection,input:CommandAccount,endpoint:URL,method:'POST'|'PUT',send:typeof fetch,maximumResponse=responseLimit){
 if(!input||typeof input.scope!=='string'||!input.scope||input.scope.length>2048||!['accountHash','targetHash'].every(k=>typeof input[k as 'accountHash'|'targetHash']==='string'&&/^[a-f0-9]{64}$/.test(input[k as 'accountHash'|'targetHash']))||typeof input.getAuth!=='function'||typeof input.assertCurrent!=='function')throw new CommandRequestError('auth');
 const {scope,accountHash,targetHash,getAuth,assertCurrent}=input;
 const current=(value:CommandAuthorization)=>{try{const result:unknown=assertCurrent(value);if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw Error();}}catch{throw new CommandRequestError('auth');}};
 return async(body:string|Blob,headers:Record<string,string>,deadline:number,signal?:AbortSignal):Promise<{value:unknown;guard:()=>void}>=>{
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let response:Response|undefined;
  const timer=setTimeout(()=>controller.abort(),deadline);
  const abortable=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
   const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new CommandRequestError('retry'));};
   if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});
   promise.then(value=>{lifetime.removeEventListener('abort',stop);resolve(value);},error=>{lifetime.removeEventListener('abort',stop);reject(error);});
  });
  async function auth(){
   let value:CommandAuthorization;try{value=await abortable(getAuth());}catch(error){throw new CommandRequestError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}
   if(!value||typeof value.jwt!=='string'||value.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwt)||!Number.isSafeInteger(value.generation)||value.generation<0)throw new CommandRequestError('auth');
   const captured={jwt:value.jwt,userId:value.userId,generation:value.generation};
   try{const [account,target]=await abortable(Promise.all([operatorAccountHash(captured.userId),cloudConnectionTarget(config,scope,captured.userId)]));if(account!==accountHash||target!==targetHash)throw Error();}catch{throw new CommandRequestError(lifetime.aborted?'retry':'auth');}
   return captured;
  }
  try{
   if(lifetime.aborted)throw new CommandRequestError('retry');const original=await auth();current(original);
   response=await abortable(send(endpoint,{method,body,headers:{...headers,apikey:config.publishableKey,Authorization:'Bearer '+original.jwt},redirect:'error',cache:'no-store',credentials:'omit',signal:lifetime}));
   if([401,403].includes(response.status))throw new CommandRequestError('auth');
   if([400,409,413,415].includes(response.status)){
    // A late error from a previous sign-in must not become another account's
    // saved review. Provider bodies remain unread and never enter local data.
    const latest=await auth();if(latest.generation!==original.generation)throw new CommandRequestError('auth');current(latest);
    const error=new CommandRequestError('review');
    if(routeIsCommand()&&typeof body==='string'){
     const bodyHash=await abortable(syncHash(new TextEncoder().encode(body)));current(latest);
     if(lifetime.aborted)throw new CommandRequestError('retry');
     reviewGuards.set(error,{status:response.status as CommandReviewProof['status'],targetHash,accountHash,bodyHash,assertCurrent:()=>current(latest)});
    }
    throw error;
   }
   if(!response.ok)throw new CommandRequestError('retry');
   const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximumResponse))throw new CommandRequestError('retry');
   const reader=response.body?.getReader();if(!reader)throw new CommandRequestError('retry');let size=0;const parts:Uint8Array[]=[];
   try{while(true){const part=await abortable(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>maximumResponse)throw new CommandRequestError('retry');parts.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   const latest=await auth();if(latest.generation!==original.generation)throw new CommandRequestError('auth');current(latest);if(lifetime.aborted)throw new CommandRequestError('retry');return {value,guard:()=>current(latest)};
  }catch(error){void response?.body?.cancel().catch(()=>{});if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  finally{clearTimeout(timer);controller.abort();}
 };
 function routeIsCommand(){return method==='POST'&&endpoint.pathname.endsWith('/functions/v1/commands');}
}
export function createCommandRequest(config:CloudConnection,input:CommandAccount,send:typeof fetch){return createAccountJsonRequest(config,input,'commands',send);}
