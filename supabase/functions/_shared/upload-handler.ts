import {cloudUploadHash,cloudUploadManifestHash,parseCloudUploadManifest,readCloudUpload,verifyCloudUploadChunk,type CloudUploadManifest} from '../../../packages/core/cloud-upload.ts';
import {parseCloudUploadProgress} from '../../../packages/core/cloud-upload-runner.ts';
import {prepareCloudMigration,type CloudRecord} from '../../../packages/core/cloud-records.ts';
import {inboxImageBase64,inboxImageBytes} from '../../../packages/core/inbox.ts';
import {validateInboxImageBytes} from '../../../packages/core/inbox-image.ts';
import type {ImageContext} from './inbox-image-handler.ts';
import {AuthBodyError,authHttp,readAuthBody} from './auth-http.ts';
import {deviceAuthId} from './device-pin-handler.ts';
export class UploadHttpError extends Error {constructor(readonly status:401|403|409){super('Upload unavailable.');}}
export interface UploadProof {id:string;leaseId:string;token:string}
export interface InitialUploadStore {
  identity(jwt:string):Promise<unknown>;begin(jwt:string,manifest:string,hash:string):Promise<unknown>;
  info(jwt:string,id:string):Promise<unknown>;put(jwt:string,id:string,index:number,data:string):Promise<unknown>;
  read(jwt:string,id:string,index:number):Promise<unknown>;prepare(jwt:string,id:string,hash:string,lease:string):Promise<unknown>;
  finish(proof:UploadProof,records:CloudRecord[],event:string):Promise<unknown>;release(proof:UploadProof):Promise<unknown>;
  cancel(jwt:string,id:string):Promise<unknown>;putImage(meta:ImageContext,bytes:Uint8Array):Promise<boolean>;getImage(meta:ImageContext):Promise<Uint8Array>;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join(',')===[...names].sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fingerprint=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function decode(value:unknown):Uint8Array {
  if(typeof value!=='string'||value.length>524288||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('Invalid encoded upload part');
  const raw=atob(value),bytes=new Uint8Array(raw.length);for(let n=0;n<raw.length;n++)bytes[n]=raw.charCodeAt(n);return bytes;
}
async function info(value:unknown,subject:string,uploadId:string){
  if(!object(value)||typeof value.manifest!=='string'||value.manifest.length>65536||value.authUserId!==subject)throw new Error('Invalid upload context');
  const manifest=parseCloudUploadManifest(JSON.parse(value.manifest)),hash=await cloudUploadManifestHash(manifest);
  if(manifest.id!==uploadId||JSON.stringify(manifest)!==value.manifest)throw new Error('Invalid upload context');
  return {manifest,hash,progress:parseCloudUploadProgress(value.progress,manifest,hash)};
}
export function createInitialUploadHandler(deps:{store:InitialUploadStore;origins:ReadonlySet<string>;newId?:()=>string}){
  const origins=new Set(deps.origins),store=deps.store,newId=deps.newId??deviceAuthId;
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to upload your shop.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    try{
      const subject=await store.identity(jwt);if(!uuid(subject))throw new Error('Invalid verified identity');
      let raw:unknown;try{raw=await readAuthBody(request,600000,90000);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the upload request.'});}
      if(!object(raw))return reply(400,{error:'Choose a supported upload action.'});
      if(raw.action==='begin'&&exact(raw,['action','manifest','manifestHash'])){
        let manifest:CloudUploadManifest;try{manifest=parseCloudUploadManifest(raw.manifest);}catch{return reply(400,{error:'Review a valid local upload snapshot.'});}
        const hash=await cloudUploadManifestHash(manifest);if(raw.manifestHash!==hash)return reply(400,{error:'The upload review changed.'});
        return reply(200,parseCloudUploadProgress(await store.begin(jwt,JSON.stringify(manifest),hash),manifest,hash));
      }
      if(!id(raw.id))return reply(400,{error:'Choose a saved upload.'});
      const uploadId=raw.id;
      if(raw.action==='cancel'&&exact(raw,['action','id'])){
        const result=await store.cancel(jwt,uploadId);if(!object(result)||result.id!==uploadId||result.canceled!==true)throw new Error('Invalid cancellation');return reply(200,{id:uploadId,canceled:true});
      }
      if(raw.action==='status'&&exact(raw,['action','id']))return reply(200,(await info(await store.info(jwt,uploadId),subject,uploadId)).progress);
      if(raw.action==='put'&&exact(raw,['action','id','index','data'])&&typeof raw.index==='number'&&Number.isInteger(raw.index)&&raw.index>=0&&raw.index<200){
        let bytes:Uint8Array;try{bytes=decode(raw.data);}catch{return reply(400,{error:'Use the complete prepared upload part.'});}
        const state=await info(await store.info(jwt,uploadId),subject,uploadId);
        try{await verifyCloudUploadChunk(state.manifest,raw.index,new Blob([new Uint8Array(bytes).buffer]));}catch{return reply(422,{error:'This upload part does not match its review.'});}
        return reply(200,parseCloudUploadProgress(await store.put(jwt,uploadId,raw.index,inboxImageBase64(bytes)),state.manifest,state.hash));
      }
      if(raw.action!=='finish'||!exact(raw,['action','id','manifestHash'])||!fingerprint(raw.manifestHash))return reply(400,{error:'Choose a supported upload action and its exact fields.'});
      const state=await info(await store.info(jwt,uploadId),subject,uploadId);if(raw.manifestHash!==state.hash)return reply(409,{error:'The upload review changed.'});if(state.progress.receipt)return reply(200,state.progress);
      const leaseId=newId(),prepared=await store.prepare(jwt,uploadId,state.hash,leaseId);
      if(object(prepared)&&prepared.done===true)return reply(200,parseCloudUploadProgress(prepared.progress,state.manifest,state.hash));
      if(!object(prepared)||prepared.done!==false||prepared.manifest!==JSON.stringify(state.manifest)||prepared.authUserId!==subject||prepared.leaseId!==leaseId||typeof prepared.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(prepared.token))throw new Error('Invalid prepared upload');
      const proof:UploadProof={id:uploadId,leaseId,token:prepared.token};
      try{
        const chunks:Blob[]=[];for(const part of state.manifest.chunks)chunks.push(new Blob([new Uint8Array(decode(await store.read(jwt,uploadId,part.index))).buffer]));
        let source;try{source=await readCloudUpload({manifest:state.manifest,chunks});}catch{await store.release(proof);return reply(422,{error:'The uploaded data does not match a valid local snapshot. Keep your JSON backup and review again.'});}
        const migration=await prepareCloudMigration(source,subject);
        for(const item of source.tables.inboxItems)for(const image of item.images){
          if(!item.outletId)throw new Error('Unclaimed image');const bytes=inboxImageBytes(image),meta:ImageContext={id:image.id,businessId:state.manifest.businessId,outletId:item.outletId,inboxId:item.id,path:[state.manifest.businessId,item.outletId,item.id,image.id].join('/'),type:image.type,size:image.size,sha256:await cloudUploadHash(bytes),uploadedAt:null};
          const current=await info(await store.info(jwt,uploadId),subject,uploadId);if(current.hash!==state.hash)throw new Error('Upload changed');
          try{await store.putImage(meta,bytes);}catch{/* Recover a lost Storage reply by reading the immutable original. */}
          const actual=await store.getImage(meta);validateInboxImageBytes(meta.type,actual);if(actual.byteLength!==meta.size||await cloudUploadHash(actual)!==meta.sha256)throw new Error('Original image did not survive storage');
        }
        const result=parseCloudUploadProgress(await store.finish(proof,migration.records,newId()),state.manifest,state.hash);if(!result.receipt)throw new Error('Upload was not accepted');return reply(200,result);
      }catch(error){try{await store.release(proof);}catch{/* The same ID recovers an unknown final result. */}throw error;}
    }catch(error){return error instanceof UploadHttpError?reply(error.status,{error:error.status===409?'Resume this upload or review your latest local data.':'This upload is unavailable for this account.'}):reply(503,{error:'Upload is unavailable. Keep the local copy and resume with the same upload ID.'});}
  };
}
