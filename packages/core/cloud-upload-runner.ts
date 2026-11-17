import {cloudUploadManifestHash,parseCloudUploadManifest,verifyCloudUploadChunk,type CloudUploadManifest,type CloudUploadPlan} from './cloud-upload.ts';

export interface CloudUploadReceipt {id:string;businessId:string;outletId:string;snapshotHash:string;records:number;images:number;at:number}
export interface CloudUploadProgress {id:string;manifestHash:string;received:number[];receipt:CloudUploadReceipt|null}
export interface CloudUploadRemote {
  begin(manifest:CloudUploadManifest,manifestHash:string,signal?:AbortSignal):Promise<unknown>;
  put(id:string,index:number,data:Blob,signal?:AbortSignal):Promise<unknown>;
  finish(id:string,manifestHash:string,signal?:AbortSignal):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
export function parseCloudUploadProgress(value:unknown,manifest:CloudUploadManifest,manifestHash:string):CloudUploadProgress {
  if(!object(value)||!keys(value,['id','manifestHash','received','receipt'])||value.id!==manifest.id||value.manifestHash!==manifestHash||!Array.isArray(value.received)||Array.from(value.received).some(n=>!Number.isInteger(n)||n<0||n>=manifest.chunks.length)||new Set(value.received).size!==value.received.length)throw new Error('The server upload does not match this snapshot.');
  let receipt:CloudUploadReceipt|null=null;
  if(value.receipt!==null){const r=value.receipt;
    if(!object(r)||!keys(r,['id','businessId','outletId','snapshotHash','records','images','at'])||r.id!==manifest.id||r.businessId!==manifest.businessId||r.outletId!==manifest.outletId||r.snapshotHash!==manifest.snapshotHash||r.records!==manifest.records||r.images!==manifest.images||typeof r.at!=='number'||!Number.isSafeInteger(r.at)||r.at<0||r.at>8640000000000000||value.received.length!==manifest.chunks.length)throw new Error('Invalid cloud upload receipt.');
    receipt={id:r.id,businessId:r.businessId,outletId:r.outletId,snapshotHash:r.snapshotHash,records:r.records,images:r.images,at:r.at};
  }
  const received=[...value.received].sort((a,b)=>a-b);Object.freeze(received);if(receipt)Object.freeze(receipt);return Object.freeze({id:manifest.id,manifestHash,received,receipt});
}
/** Resume only the same immutable snapshot. Network failure leaves remote ACKs authoritative. */
export async function runCloudUpload(plan:CloudUploadPlan,remote:CloudUploadRemote,options:{beforeCommit:(manifest:CloudUploadManifest)=>Promise<void>;progress:(value:CloudUploadProgress)=>Promise<void>;signal?:AbortSignal}):Promise<CloudUploadReceipt>{
  const manifest=parseCloudUploadManifest(plan.manifest),chunks=[...plan.chunks],hash=await cloudUploadManifestHash(manifest),signal=options.signal;
  if(chunks.length!==manifest.chunks.length)throw new Error('Incomplete local upload snapshot.');
  const check=()=>signal?.throwIfAborted();check();
  let status=parseCloudUploadProgress(await remote.begin(manifest,hash,signal),manifest,hash);check();await options.progress(status);
  if(status.receipt)return status.receipt;
  for(const part of manifest.chunks){
    if(status.received.includes(part.index))continue;
    check();await verifyCloudUploadChunk(manifest,part.index,chunks[part.index]);check();
    const next=parseCloudUploadProgress(await remote.put(manifest.id,part.index,chunks[part.index],signal),manifest,hash);check();
    if(!next.received.includes(part.index)||status.received.some(n=>!next.received.includes(n)))throw new Error('Upload acknowledgement changed. Resume this snapshot to check server progress.');
    status=next;await options.progress(status);if(status.receipt)return status.receipt;
  }
  check();await options.beforeCommit(manifest);check();
  status=parseCloudUploadProgress(await remote.finish(manifest.id,hash,signal),manifest,hash);
  // Persist an accepted receipt even if cancellation raced the final response.
  if(!status.receipt)throw new Error('The server has not accepted this snapshot yet. Resume with the same upload ID.');
  await options.progress(status);return status.receipt;
}
