import {parseCloudConnection,cloudConnectionTarget,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import {parseSyncUploadCoverageSource,verifyUploadCoverage,uploadCoverageRequest,UploadAdmissionError,type SyncUploadCoverageSource} from '@mise/core/sync-upload-admission';
import {syncReadHeader} from '@mise/core/sync-read';
import {readSyncResponse} from '@mise/core/sync-wire';

/** A pinned original-account read. It never uploads, writes money or creates a receipt. */
export function createCloudUploadCoverageRemote(input:CloudConnection,scope:string,getAuth:()=>Promise<{jwt:string;userId:string}>,send:typeof fetch=fetch,timeoutMs=120000){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');if(typeof scope!=='string'||!scope||scope.length>2048||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new UploadAdmissionError();
 return {async get(input:SyncUploadCoverageSource,signal?:AbortSignal){
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const abortable=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new UploadAdmissionError('retry'));};if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});promise.then(v=>{lifetime.removeEventListener('abort',stop);resolve(v);},e=>{lifetime.removeEventListener('abort',stop);reject(e);});});
  try{
   if(lifetime.aborted)throw new UploadAdmissionError('retry');timer=setTimeout(()=>controller.abort(),timeoutMs);const source=await abortable(parseSyncUploadCoverageSource(input));
   async function auth(){let value:{jwt:string;userId:string};try{value=await abortable(getAuth());}catch(error){throw new UploadAdmissionError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}
    if(!value||typeof value.jwt!=='string'||value.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwt))throw new UploadAdmissionError('auth');
    try{const [account,target]=await abortable(Promise.all([operatorAccountHash(value.userId),cloudConnectionTarget(config,scope,value.userId)]));if(account!==source.target.accountHash||target!==source.target.targetHash)throw Error();}catch(error){throw new UploadAdmissionError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}return value;
   }
   const original=await auth(),request=uploadCoverageRequest(source);
   response=await abortable(send(new URL('functions/v1/sync-read',root),{method:'POST',body:JSON.stringify(request),redirect:'error',credentials:'omit',cache:'no-store',signal:lifetime,headers:{apikey:config.publishableKey,Authorization:'Bearer '+original.jwt,[syncReadHeader]:source.target.outletId,'Content-Type':'application/json'}}));
   if([401,403].includes(response.status))throw new UploadAdmissionError('auth');if([400,409,413,415].includes(response.status))throw new UploadAdmissionError('review');if(!response.ok)throw new UploadAdmissionError('retry');
   const value=verifyUploadCoverage(source,await abortable(readSyncResponse(response)));await auth();if(lifetime.aborted)throw new UploadAdmissionError('retry');return value;
  }catch(error){void response?.body?.cancel().catch(()=>{});if(error instanceof UploadAdmissionError)throw error;throw new UploadAdmissionError('retry');}finally{clearTimeout(timer);controller.abort();}
 }};
}
