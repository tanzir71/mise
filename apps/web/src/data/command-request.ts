import {cloudConnectionTarget,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';

export interface CommandAuthorization {jwt:string;userId:string;generation:number}
export interface CommandAccount {scope:string;accountHash:string;targetHash:string;getAuth:()=>Promise<CommandAuthorization>;assertCurrent:(value:CommandAuthorization)=>void}
export class CommandRequestError extends Error {
 constructor(readonly kind:'auth'|'review'|'retry'){
  super(kind==='auth'?'Sign in again with the original account before sending this change.':kind==='review'?'Review this saved action before retrying. Keep the local copy and its original ID.':'The change is unconfirmed. Keep the local copy and retry with the same command ID.');
 }
}
const responseLimit=2*1024*1024;
const receiptGuards=new WeakMap<object,()=>void>();
export function bindCommandReceipt<T extends object>(receipt:T,guard:()=>void):T {receiptGuards.set(receipt,guard);return receipt;}
/** Network receipts carry an ephemeral check; no session field is added to the record. */
export function assertCommandReceipt(receipt:object):void {receiptGuards.get(receipt)?.();}
/** Runtime identity only. The account, connection and generation never enter a command. */
export function createCommandRequest(config:CloudConnection,input:CommandAccount,send:typeof fetch){
 if(!input||typeof input.scope!=='string'||!input.scope||input.scope.length>2048||!['accountHash','targetHash'].every(k=>typeof input[k as 'accountHash'|'targetHash']==='string'&&/^[a-f0-9]{64}$/.test(input[k as 'accountHash'|'targetHash']))||typeof input.getAuth!=='function'||typeof input.assertCurrent!=='function')throw new CommandRequestError('auth');
 const {scope,accountHash,targetHash,getAuth,assertCurrent}=input,endpoint=new URL('functions/v1/commands',config.apiUrl+'/');
 const current=(value:CommandAuthorization)=>{try{const result:unknown=assertCurrent(value);if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw Error();}}catch{throw new CommandRequestError('auth');}};
 return async(body:string,headers:Record<string,string>,deadline:number,signal?:AbortSignal):Promise<{value:unknown;guard:()=>void}>=>{
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let response:Response|undefined;
  const timer=setTimeout(()=>controller.abort(),deadline);
  const abortable=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
   const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new CommandRequestError('retry'));};
   if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});
   promise.then(value=>{lifetime.removeEventListener('abort',stop);resolve(value);},error=>{lifetime.removeEventListener('abort',stop);reject(error);});
  });
  async function auth(){
   let value:CommandAuthorization;try{value=await abortable(getAuth());}catch{throw new CommandRequestError(lifetime.aborted?'retry':'auth');}
   if(!value||typeof value.jwt!=='string'||value.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwt)||!Number.isSafeInteger(value.generation)||value.generation<0)throw new CommandRequestError('auth');
   const captured={jwt:value.jwt,userId:value.userId,generation:value.generation};
   try{const [account,target]=await abortable(Promise.all([operatorAccountHash(captured.userId),cloudConnectionTarget(config,scope,captured.userId)]));if(account!==accountHash||target!==targetHash)throw Error();}catch{throw new CommandRequestError(lifetime.aborted?'retry':'auth');}
   return captured;
  }
  try{
   if(lifetime.aborted)throw new CommandRequestError('retry');const original=await auth();current(original);
   response=await abortable(send(endpoint,{method:'POST',body,headers:{...headers,apikey:config.publishableKey,Authorization:'Bearer '+original.jwt},redirect:'error',cache:'no-store',credentials:'omit',signal:lifetime}));
   if([401,403].includes(response.status))throw new CommandRequestError('auth');if([400,409,413,415].includes(response.status))throw new CommandRequestError('review');if(!response.ok)throw new CommandRequestError('retry');
   const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>responseLimit))throw new CommandRequestError('retry');
   const reader=response.body?.getReader();if(!reader)throw new CommandRequestError('retry');let size=0;const parts:Uint8Array[]=[];
   try{while(true){const part=await abortable(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>responseLimit)throw new CommandRequestError('retry');parts.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   const latest=await auth();if(latest.generation!==original.generation)throw new CommandRequestError('auth');current(latest);if(lifetime.aborted)throw new CommandRequestError('retry');return {value,guard:()=>current(latest)};
  }catch(error){void response?.body?.cancel().catch(()=>{});if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  finally{clearTimeout(timer);controller.abort();}
 };
}
