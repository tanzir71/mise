import type {CloudUploadRemote} from '@mise/core/cloud-upload-runner';
import {CLOUD_UPLOAD_MAX_CHUNK_BYTES} from '@mise/core/cloud-upload';
import {inboxImageBase64} from '@mise/core/inbox';
export interface CloudUploadTransport extends CloudUploadRemote {
  status(id:string,signal?:AbortSignal):Promise<unknown>;
  cancel(id:string,signal?:AbortSignal):Promise<{id:string;canceled:true}>;
}
/** Public-key transport only. Authentication is supplied per request and never persisted here. */
export function createCloudUploadRemote(apiUrl:string,publishableKey:string,getJwt:()=>Promise<string>,send:typeof fetch=fetch):CloudUploadTransport {
  const root=new URL(apiUrl);if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('Cloud uploads are not configured.');
  async function request(body:unknown,signal?:AbortSignal){
    const jwt=await getJwt();if(jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt))throw new Error('Sign in again to upload your shop.');
    const timeout=AbortSignal.timeout(120000),response=await send(new URL('functions/v1/migration-upload',root),{method:'POST',redirect:'error',signal:signal?AbortSignal.any([timeout,signal]):timeout,headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok)throw new Error(response.status===401?'Sign in again to upload your shop.':response.status===403?'This upload is unavailable for this account.':'Upload is unavailable. Keep the local copy and resume with the same upload ID.');return response.json();
  }
  return {begin:(manifest,manifestHash,signal)=>request({action:'begin',manifest,manifestHash},signal),put:async(id,index,data,signal)=>{if(data.size>CLOUD_UPLOAD_MAX_CHUNK_BYTES)throw new Error('Use a prepared upload chunk.');return request({action:'put',id,index,data:inboxImageBase64(new Uint8Array(await data.arrayBuffer()))},signal);},finish:(id,manifestHash,signal)=>request({action:'finish',id,manifestHash},signal),status:(id,signal)=>request({action:'status',id},signal),cancel:async(id,signal)=>{const value=await request({action:'cancel',id},signal);if(!value||typeof value!=='object'||value.id!==id||value.canceled!==true)throw new Error('Upload cancellation is unconfirmed. Keep the local snapshot.');return {id,canceled:true};}};
}
