import {parseCloudConnection,cloudConnectionTarget,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import {parseSyncCoverageSource,parseSyncCoveragePage,SyncCoverageError,type SyncCoverageSource} from '@mise/core/sync-coverage';
import {syncReadHeader,syncReadBodyLimit} from '@mise/core/sync-read';
import {readSyncResponse} from '@mise/core/sync-wire';

interface CoverageAuth {jwt:string;userId:string}
/** Original-account coverage of a fixed download, never a command write or new receipt. */
export function createCloudCoverageRemote(input:CloudConnection,scope:string,getAuth:()=>Promise<CoverageAuth>,send:typeof fetch=fetch,timeoutMs=120000){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');if(typeof scope!=='string'||!scope||scope.length>2048||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new SyncCoverageError();
 return {async get(input:SyncCoverageSource,signal?:AbortSignal){
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const abortable=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new SyncCoverageError('retry'));};if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});promise.then(v=>{lifetime.removeEventListener('abort',stop);resolve(v);},e=>{lifetime.removeEventListener('abort',stop);reject(e);});});
  try{
   const source=parseSyncCoverageSource(input);if(lifetime.aborted)throw new SyncCoverageError('retry');timer=setTimeout(()=>controller.abort(),timeoutMs);
   async function auth(){let value:CoverageAuth;try{value=await abortable(getAuth());}catch(error){throw new SyncCoverageError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}
    if(!value||typeof value.jwt!=='string'||value.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwt))throw new SyncCoverageError('auth');
    try{const [account,target]=await abortable(Promise.all([operatorAccountHash(value.userId),cloudConnectionTarget(config,scope,value.userId)]));if(account!==source.target.accountHash||target!==source.target.targetHash)throw Error();}catch(error){throw new SyncCoverageError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}return value;
   }
   const original=await auth(),request={type:'coverage',id:source.readId,outletId:source.target.outletId,ids:source.intents.map(c=>c.id)},body=JSON.stringify(request);if(new TextEncoder().encode(body).length>syncReadBodyLimit)throw new SyncCoverageError();
   response=await abortable(send(new URL('functions/v1/sync-read',root),{method:'POST',body,redirect:'error',credentials:'omit',cache:'no-store',signal:lifetime,headers:{apikey:config.publishableKey,Authorization:'Bearer '+original.jwt,[syncReadHeader]:source.target.outletId,'Content-Type':'application/json'}}));
   if([401,403].includes(response.status))throw new SyncCoverageError('auth');if([400,409,413,415].includes(response.status))throw new SyncCoverageError('review');if(!response.ok)throw new SyncCoverageError('retry');
   const value=parseSyncCoveragePage(await abortable(readSyncResponse(response)),source.window,request.ids,source.cursor);await auth();if(lifetime.aborted)throw new SyncCoverageError('retry');return value;
  }catch(error){void response?.body?.cancel().catch(()=>{});if(error instanceof SyncCoverageError)throw error;throw new SyncCoverageError('retry');}finally{clearTimeout(timer);controller.abort();}
 }};
}
