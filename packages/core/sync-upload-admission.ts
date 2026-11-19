import {cloudUploadManifestHash,parseCloudUploadManifest,readCloudUpload,type CloudUploadManifest,type CloudUploadPlan} from './cloud-upload';
import {parseCloudUploadProgress,type CloudUploadReceipt} from './cloud-upload-runner';
import {parseSyncDownloadTarget,syncDownloadToken,type SyncDownloadTarget} from './sync-download';
import {parseSyncScope,parseSyncWindow,syncHash,type SyncReadWindow,type SyncScope} from './sync-read';

export interface SyncUploadCoverageRequest {type:'upload-coverage';id:string;outletId:string;uploadId:string;manifestHash:string}
export interface SyncUploadCoveragePage extends SyncScope {v:1;id:string;uploadId:string;manifestHash:string;receipt:CloudUploadReceipt;state:'unknown'|'later'|'visible';cursor:string}
export interface SyncUploadCoverageSource {version:1;readId:string;readSourceHash:string;readSeal:string;target:SyncDownloadTarget;window:SyncReadWindow;cursor:string;manifest:CloudUploadManifest;manifestHash:string;receipt:CloudUploadReceipt}
export interface LocalOwnerUploadAdmission {id:'owner-upload';version:1;plan:CloudUploadPlan;source:SyncUploadCoverageSource;proof:SyncUploadCoveragePage;initialBaseHash:string;hash:string}
export const localAdmissionTableNames=['syncAdmissions'] as const;
export class UploadAdmissionError extends Error {constructor(readonly kind:'auth'|'review'|'retry'|'integrity'='review'){super({auth:'Verify the original owner account before reviewing this upload.',review:'Keep the original upload, local work and download for review.',retry:'The original upload could not be confirmed in this download. Keep local work and retry.',integrity:'The saved owner upload admission changed. Keep the original source and backup.'}[kind]);}}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const uploadAdmissionHash=(v:unknown)=>syncHash(new TextEncoder().encode(syncDownloadToken(v)));
function receipt(value:unknown,request:SyncUploadCoverageRequest,scope:SyncScope):CloudUploadReceipt {
 if(!object(value)||!exact(value,'id,businessId,outletId,snapshotHash,records,images,at')||value.id!==request.uploadId||value.businessId!==scope.businessId||value.outletId!==scope.outletId||!hash(value.snapshotHash)||![value.records,value.images,value.at].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||Number(value.at)>8640000000000000)throw new UploadAdmissionError('integrity');
 return {id:value.id,businessId:value.businessId as string,outletId:value.outletId as string,snapshotHash:value.snapshotHash,records:value.records as number,images:value.images as number,at:value.at as number};
}
export function parseSyncUploadCoverageRequest(v:unknown):SyncUploadCoverageRequest {
 if(!object(v)||!exact(v,'type,id,outletId,uploadId,manifestHash')||v.type!=='upload-coverage'||![v.id,v.outletId,v.uploadId].every(id)||!hash(v.manifestHash))throw new UploadAdmissionError();return {type:'upload-coverage',id:v.id as string,outletId:v.outletId as string,uploadId:v.uploadId as string,manifestHash:v.manifestHash};
}
export async function parseSyncUploadCoverageSource(v:unknown):Promise<SyncUploadCoverageSource>{
 try{
  v=structuredClone(v);
  if(!object(v)||!exact(v,'version,readId,readSourceHash,readSeal,target,window,cursor,manifest,manifestHash,receipt')||v.version!==1||!id(v.readId)||!hash(v.readSourceHash)||!hash(v.readSeal)||!hash(v.manifestHash)||typeof v.cursor!=='string'||!v.cursor||v.cursor.length>131072)throw Error();
  const target=parseSyncDownloadTarget(v.target),window=parseSyncWindow(v.window,{type:'begin',id:v.readId,outletId:target.outletId,cursor:null}),manifest=parseCloudUploadManifest(v.manifest);
  if(target.role!=='owner'||['businessId','outletId','actorId','accountHash','role'].some(k=>window[k as keyof SyncReadWindow]!==target[k as keyof SyncDownloadTarget])||manifest.businessId!==target.businessId||manifest.outletId!==target.outletId||manifest.ownerId!==target.actorId||await cloudUploadManifestHash(manifest)!==v.manifestHash)throw Error();
  const accepted=parseCloudUploadProgress({id:manifest.id,manifestHash:v.manifestHash,received:manifest.chunks.map(p=>p.index),receipt:v.receipt},manifest,v.manifestHash).receipt;if(!accepted)throw Error();
  return {version:1,readId:v.readId,readSourceHash:v.readSourceHash,readSeal:v.readSeal,target,window,cursor:v.cursor,manifest,manifestHash:v.manifestHash,receipt:accepted};
 }catch{throw new UploadAdmissionError('integrity');}
}
export function uploadCoverageRequest(source:SyncUploadCoverageSource):SyncUploadCoverageRequest{return {type:'upload-coverage',id:source.readId,outletId:source.target.outletId,uploadId:source.manifest.id,manifestHash:source.manifestHash};}
export function parseSyncUploadCoveragePage(v:unknown,window:SyncReadWindow,request:SyncUploadCoverageRequest,cursor:string):SyncUploadCoveragePage {
 try{
  request=parseSyncUploadCoverageRequest(request);const scope=parseSyncScope(v);
  if(!object(v)||!exact(v,'v,id,businessId,outletId,actorId,accountHash,role,epoch,scopeVersion,uploadId,manifestHash,receipt,state,cursor')||v.v!==1||v.id!==window.id||v.id!==request.id||v.uploadId!==request.uploadId||v.manifestHash!==request.manifestHash||request.outletId!==scope.outletId||scope.role!=='owner'||syncDownloadToken(scope)!==syncDownloadToken(parseSyncScope(window))||!['unknown','later','visible'].includes(v.state as string)||typeof cursor!=='string'||!cursor||cursor.length>131072||v.cursor!==cursor)throw Error();
  return {...scope,v:1,id:request.id,uploadId:request.uploadId,manifestHash:request.manifestHash,receipt:receipt(v.receipt,request,scope),state:v.state as SyncUploadCoveragePage['state'],cursor};
 }catch{throw new UploadAdmissionError('integrity');}
}
export function verifyUploadCoverage(source:SyncUploadCoverageSource,input:unknown):SyncUploadCoveragePage {
 const page=parseSyncUploadCoveragePage(input,source.window,uploadCoverageRequest(source),source.cursor);
 if(syncDownloadToken(page.receipt)!==syncDownloadToken(source.receipt))throw new UploadAdmissionError('integrity');return page;
}
export function assertVisibleUploadCoverage(source:SyncUploadCoverageSource,input:unknown):SyncUploadCoveragePage {const page=verifyUploadCoverage(source,input);if(page.state!=='visible')throw new UploadAdmissionError('review');return page;}
/** Full original chunks are checked through their committed manifest hashes. */
export function ownerUploadAdmissionHash(v:Omit<LocalOwnerUploadAdmission,'hash'>){return uploadAdmissionHash({id:v.id,version:v.version,source:v.source,proof:v.proof,initialBaseHash:v.initialBaseHash});}
export async function verifyOwnerUploadAdmission(input:LocalOwnerUploadAdmission){
 try{
  const v=structuredClone(input);if(!object(v)||!exact(v as unknown as Record<string,unknown>,'id,version,plan,source,proof,initialBaseHash,hash')||v.id!=='owner-upload'||v.version!==1||!hash(v.initialBaseHash)||!hash(v.hash)||!object(v.plan)||!exact(v.plan as unknown as Record<string,unknown>,'manifest,chunks'))throw Error();
  const source=await parseSyncUploadCoverageSource(v.source),proof=assertVisibleUploadCoverage(source,v.proof);if(syncDownloadToken(v.plan.manifest)!==syncDownloadToken(source.manifest)||await ownerUploadAdmissionHash(v)!==v.hash)throw Error();
  const original=await readCloudUpload(v.plan);return {admission:{...v,source,proof},original};
 }catch{throw new UploadAdmissionError('integrity');}
}
