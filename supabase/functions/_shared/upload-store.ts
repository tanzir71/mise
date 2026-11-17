import {createInboxImageStore} from './inbox-image-store.ts';
import {UploadHttpError,type InitialUploadStore} from './upload-handler.ts';
export function createInitialUploadStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch):InitialUploadStore {
  const images=createInboxImageStore(apiUrl,publishableKey,serviceKey,send),root=new URL(apiUrl);
  async function rpc(name:string,args:Record<string,unknown>,jwt?:string,deadline=5000){
    const headers:Record<string,string>={apikey:jwt?publishableKey:serviceKey,'Content-Type':'application/json'};if(jwt)headers.Authorization='Bearer '+jwt;
    const result=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(deadline),headers,body:JSON.stringify(args)});
    if(result.status===409)throw new UploadHttpError(409);if(result.status===403||(result.status===401&&jwt))throw new UploadHttpError(result.status);if(!result.ok)throw new Error('Upload service unavailable');return result.json();
  }
  return {identity:jwt=>rpc('initial_upload_identity',{},jwt),begin:(jwt,manifest,hash)=>rpc('begin_initial_upload',{p_manifest:manifest,p_hash:hash},jwt),info:(jwt,id)=>rpc('initial_upload_info',{p_id:id},jwt),put:(jwt,id,index,data)=>rpc('put_initial_upload_chunk',{p_id:id,p_index:index,p_data:data},jwt),read:(jwt,id,index)=>rpc('read_initial_upload_chunk',{p_id:id,p_index:index},jwt),prepare:(jwt,id,hash,lease)=>rpc('prepare_initial_upload',{p_id:id,p_hash:hash,p_lease:lease},jwt),finish:(proof,records,event)=>rpc('finish_initial_upload',{p_id:proof.id,p_lease:proof.leaseId,p_token:proof.token,p_records:records,p_event:event},undefined,30000),release:proof=>rpc('release_initial_upload',{p_id:proof.id,p_lease:proof.leaseId,p_token:proof.token}),cancel:(jwt,id)=>rpc('cancel_initial_upload',{p_id:id},jwt),putImage:images.put,getImage:images.get};
}
