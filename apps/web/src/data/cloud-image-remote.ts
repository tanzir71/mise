import {cloudConnectionTarget,parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import {SyncImageError,parseSyncImageSource,verifySyncImageBlob,type SyncImageSource} from '@mise/core/sync-images';

interface ImageAuth {jwt:string;userId:string}
/** Original authenticated bytes only. No signed URLs, Storage paths or credentials are retained. */
export function createCloudImageRemote(input:CloudConnection,scope:string,getAuth:()=>Promise<ImageAuth>,send:typeof fetch=fetch,timeoutMs=120000){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');
 if(typeof scope!=='string'||!scope||scope.length>2048||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new SyncImageError();
 return {async get(input:SyncImageSource,signal?:AbortSignal):Promise<Blob>{
  let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const abortable=<T>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
   const stop=()=>{lifetime.removeEventListener('abort',stop);reject(new SyncImageError('retry'));};
   if(lifetime.aborted){void promise.catch(()=>{});stop();return;}lifetime.addEventListener('abort',stop,{once:true});promise.then(value=>{lifetime.removeEventListener('abort',stop);resolve(value);},error=>{lifetime.removeEventListener('abort',stop);reject(error);});
  });
  try{
   const source=parseSyncImageSource(input);if(lifetime.aborted)throw new SyncImageError('retry');timer=setTimeout(()=>controller.abort(),timeoutMs);
   async function auth(){
    let value:ImageAuth;try{value=await abortable(getAuth());}catch(error){throw new SyncImageError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}
    if(!value||typeof value.jwt!=='string'||value.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwt))throw new SyncImageError('auth');
    let accountHash:string,targetHash:string;try{[accountHash,targetHash]=await abortable(Promise.all([operatorAccountHash(value.userId),cloudConnectionTarget(config,scope,value.userId)]));}catch(error){throw new SyncImageError(lifetime.aborted||error&&typeof error==='object'&&'kind'in error&&error.kind==='retry'?'retry':'auth');}
    if(accountHash!==source.target.accountHash||targetHash!==source.target.targetHash)throw new SyncImageError('auth');return value;
   }
   const original=await auth(),url=new URL('functions/v1/inbox-image',root);url.searchParams.set('image',source.image.id);
   const response=await abortable(send(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{apikey:config.publishableKey,Authorization:'Bearer '+original.jwt},signal:lifetime}));
   if([401,403].includes(response.status)){void response.body?.cancel().catch(()=>{});throw new SyncImageError('auth');}
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw new SyncImageError('retry');}
   if(response.headers.get('Content-Type')?.toLowerCase().trim()!==source.image.type){void response.body?.cancel().catch(()=>{});throw new SyncImageError('integrity');}
   // Actual decoded bytes are authoritative; Content-Length can describe a
   // compressed wire representation and is never trusted as integrity evidence.
   reader=response.body?.getReader();if(!reader)throw new SyncImageError('integrity');
   const chunks:Uint8Array[]=[];let length=0;
   while(true){const part=await abortable(reader.read());if(part.done)break;if(!part.value.byteLength)continue;length+=part.value.byteLength;if(length>source.image.size)throw new SyncImageError('integrity');chunks.push(part.value);}
   if(length!==source.image.size)throw new SyncImageError('integrity');
   const blob=new Blob(chunks.map(chunk=>new Uint8Array(chunk).buffer),{type:source.image.type});await abortable(verifySyncImageBlob(source,blob));await auth();
   if(lifetime.aborted)throw new SyncImageError('retry');return blob;
  }catch(error){if(reader)void reader.cancel().catch(()=>{});if(error instanceof SyncImageError)throw error;throw new SyncImageError('retry');}
  finally{clearTimeout(timer);reader?.releaseLock();controller.abort();}
 }};
}
