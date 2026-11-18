import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseSyncReadRequest,parseSyncWindow,parseSyncPage,syncReadHeader,syncReadBodyLimit,type SyncReadRequest,type SyncReadWindow} from '@mise/core/sync-read';
import {readSyncResponse} from '@mise/core/sync-wire';
export class CloudSyncReadError extends Error {constructor(readonly kind:'auth'|'review'|'retry',message:string){super(message);}}
/** Read-only transport. It never mutates shop records, outbox receipts or accepted cursors. */
export function createCloudSyncRemote(input:CloudConnection,getJwt:()=>Promise<string>,send:typeof fetch=fetch){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');
 async function call(value:SyncReadRequest,signal?:AbortSignal){
  const request=parseSyncReadRequest(JSON.parse(JSON.stringify(value))),body=JSON.stringify(request);if(new TextEncoder().encode(body).length>syncReadBodyLimit)throw new CloudSyncReadError('review','Keep the complete original sync review.');signal?.throwIfAborted();const jwt=await getJwt();signal?.throwIfAborted();
  if(typeof jwt!=='string'||jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt))throw new CloudSyncReadError('auth','Verify your phone before reading this shop.');
  let response:Response;try{const timeout=AbortSignal.timeout(120000);response=await send(new URL('functions/v1/sync-read',root),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{apikey:config.publishableKey,Authorization:'Bearer '+jwt,[syncReadHeader]:request.outletId,'Content-Type':'application/json'},body});}catch{throw new CloudSyncReadError('retry','Sync is unconfirmed. Keep local work and retry the original page.');}
  if([401,403].includes(response.status))throw new CloudSyncReadError('auth','Sign in with an account allowed to read this shop.');if([400,409,413,415].includes(response.status))throw new CloudSyncReadError('review','Review this outlet from the last accepted cursor. Keep local work.');if(!response.ok)throw new CloudSyncReadError('retry','Sync is unconfirmed. Keep local work and retry the original page.');
  try{return await readSyncResponse(response);}catch{throw new CloudSyncReadError('retry','The sync page could not be verified. Keep local work and retry the original page.');}
 }
 return {async begin(request:Extract<SyncReadRequest,{type:'begin'}>,signal?:AbortSignal){try{request=JSON.parse(JSON.stringify(request));return parseSyncWindow(await call(request,signal),request);}catch(error){if(error instanceof CloudSyncReadError)throw error;throw new CloudSyncReadError('retry','The sync review is unconfirmed. Keep its original identity.');}},async page(window:SyncReadWindow,index:number,signal?:AbortSignal){try{window=JSON.parse(JSON.stringify(window));return parseSyncPage(await call({type:'page',id:window.id,outletId:window.outletId,index},signal),window,index);}catch(error){if(error instanceof CloudSyncReadError)throw error;throw new CloudSyncReadError('retry','The sync page is unconfirmed. Keep its original position.');}}};
}
