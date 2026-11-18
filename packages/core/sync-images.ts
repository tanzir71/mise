import {inboxImageTypes,validateInboxImageBytes,type InboxImageType} from './inbox-image';
import {syncHash,syncRecordColumns} from './sync-read';
import {parseSyncDownloadTarget,syncDownloadToken,type LocalSyncDownload,type LocalSyncRecord,type SyncDownloadTarget} from './sync-download';

export const localImageTableNames=['syncImages'] as const;
export interface SyncImageDescriptor {id:string;businessId:string;outletId:string;inboxId:string;type:InboxImageType;size:number;sha256:string}
export interface SyncImageSource {
 version:1;readId:string;sourceHash:string;readSeal:string;changeId:string;recordHash:string;
 target:SyncDownloadTarget;image:SyncImageDescriptor;
}
export interface LocalSyncImage {readId:string;imageId:string;source:SyncImageSource;sourceHash:string;blob:Blob}
export class SyncImageError extends Error {
 constructor(readonly kind:'auth'|'review'|'retry'|'integrity'='review'){
  super({auth:'Verify the original phone account before downloading this image.',review:'Keep the original image and download review. Check this outlet before trying again.',retry:'The image download is unconfirmed. Keep local records and retry the original image.',integrity:'The saved image could not be verified. Keep its source and recovery records.'}[kind]);
 }
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export function parseSyncImageDescriptor(v:unknown):SyncImageDescriptor {
 if(!object(v)||!exact(v,'id,businessId,outletId,inboxId,type,size,sha256')||![v.id,v.businessId,v.outletId,v.inboxId].every(id)||!inboxImageTypes.includes(v.type as InboxImageType)||!Number.isSafeInteger(v.size)||(v.size as number)<1||(v.size as number)>5242880||!hash(v.sha256))throw new SyncImageError();
 return {id:v.id as string,businessId:v.businessId as string,outletId:v.outletId as string,inboxId:v.inboxId as string,type:v.type as InboxImageType,size:v.size as number,sha256:v.sha256};
}
export function parseSyncImageSource(v:unknown):SyncImageSource {
 try{
  if(!object(v)||!exact(v,'version,readId,sourceHash,readSeal,changeId,recordHash,target,image')||v.version!==1||!id(v.readId)||!hash(v.sourceHash)||!hash(v.readSeal)||!hash(v.recordHash)||typeof v.changeId!=='string'||!/^[1-9][0-9]{0,18}$/.test(v.changeId)||BigInt(v.changeId)>9223372036854775807n)throw new SyncImageError();
  const target=parseSyncDownloadTarget(v.target),image=parseSyncImageDescriptor(v.image);if(target.businessId!==image.businessId||target.outletId!==image.outletId)throw new SyncImageError();
  return {version:1,readId:v.readId,sourceHash:v.sourceHash,readSeal:v.readSeal,changeId:v.changeId,recordHash:v.recordHash,target,image};
 }catch{throw new SyncImageError();}
}
/** Names and literal source fields remain in the original immutable record. */
export function syncImageSource(state:LocalSyncDownload,record:LocalSyncRecord):SyncImageSource {
 const v=record.row;
 if(!state.seal||record.readId!==state.id||record.meta.changeId!==record.changeId||record.meta.table!=='inbox_images'||record.meta.operation!=='upsert'||!object(v)||Object.keys(v).sort().join(',')!==[...syncRecordColumns.inbox_images].sort().join(',')||record.meta.id!==v.id||typeof v.name!=='string'||!Number.isSafeInteger(v.position)||(v.position as number)<0||(v.position as number)>3||![v.created_at,v.updated_at].every(time)||v.uploaded_at!==null&&!time(v.uploaded_at))throw new SyncImageError();
 return parseSyncImageSource({version:1,readId:state.id,sourceHash:state.sourceHash,readSeal:state.seal,changeId:record.changeId,recordHash:record.rowHash,target:state.source.target,image:{id:v.id,businessId:v.business_id,outletId:v.outlet_id,inboxId:v.inbox_item_id,type:v.type,size:v.size,sha256:v.sha256}});
}
export async function syncImageSourceHash(source:SyncImageSource):Promise<string>{return syncHash(new TextEncoder().encode(syncDownloadToken(parseSyncImageSource(source))));}
export async function verifySyncImageBlob(source:SyncImageSource,blob:Blob):Promise<void>{
 const {image}=parseSyncImageSource(source);if(!(blob instanceof Blob)||blob.size!==image.size||blob.type!==image.type)throw new SyncImageError('integrity');
 try{const bytes=new Uint8Array(await blob.arrayBuffer());validateInboxImageBytes(image.type,bytes);if(await syncHash(bytes)!==image.sha256)throw new SyncImageError('integrity');}catch{throw new SyncImageError('integrity');}
}
export function parseLocalSyncImage(v:unknown,source:SyncImageSource,sourceHash:string):LocalSyncImage {
 if(!object(v)||!exact(v,'readId,imageId,source,sourceHash,blob')||v.readId!==source.readId||v.imageId!==source.image.id||v.sourceHash!==sourceHash||syncDownloadToken(parseSyncImageSource(v.source))!==syncDownloadToken(source)||!(v.blob instanceof Blob)||v.blob.size!==source.image.size||v.blob.type!==source.image.type)throw new SyncImageError('integrity');
 return {readId:source.readId,imageId:source.image.id,source:parseSyncImageSource(source),sourceHash,blob:v.blob};
}
