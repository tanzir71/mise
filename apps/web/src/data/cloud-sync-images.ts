import {parseSyncDownloadTarget,syncDownloadToken,type LocalSyncRecord,type SyncDownloadTarget} from '@mise/core/sync-download';
import {syncHash} from '@mise/core/sync-read';
import {SyncImageError,syncImageSource,syncImageSourceHash,parseLocalSyncImage,verifySyncImageBlob,type LocalSyncImage,type SyncImageSource} from '@mise/core/sync-images';
import {readSyncDownloadContext,assertSyncDownloadContext,readVerifiedSyncRecords,type SyncDownloadContext} from './cloud-sync-journal';
import type {LocalStore} from './local-store';

export interface SyncImageRemote {get(source:SyncImageSource,signal?:AbortSignal):Promise<Blob>}
interface PlannedImage {source:SyncImageSource;sourceHash:string;recordToken:string}
interface ImagePlan {context:SyncDownloadContext;images:PlannedImage[];hash:string}
export interface VerifiedSyncImages {readId:string;readSeal:string;hash:string;bytes:number;images:LocalSyncImage[]}
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new SyncImageError('retry');};
async function planImages(db:LocalStore,id:string,target:SyncDownloadTarget,signal?:AbortSignal):Promise<ImagePlan>{
 target=parseSyncDownloadTarget(target);abort(signal);const initial=await readSyncDownloadContext(db,id,target);if(!initial.state.seal)throw new SyncImageError();
 const {context,records}=await readVerifiedSyncRecords(db,id,target,signal),state=context.state;
 if(syncDownloadToken(initial.state)!==syncDownloadToken(state))throw new SyncImageError();
 const images=new Map<string,LocalSyncRecord>(),parents=new Set<string>();
 records.sort((a,b)=>BigInt(a.changeId)<BigInt(b.changeId)?-1:BigInt(a.changeId)>BigInt(b.changeId)?1:0);
 for(const record of records){if(record.meta.table==='inbox_images')images.set(record.meta.id,record);if(record.meta.table==='inbox_items'){if(record.meta.operation==='delete')parents.delete(record.meta.id);else parents.add(record.meta.id);}}
 const positions=new Set<string>(),groups=new Map<string,{bytes:number;positions:number[]}>(),planned:PlannedImage[]=[];
 for(const record of [...images.values()].sort((a,b)=>a.meta.id<b.meta.id?-1:a.meta.id>b.meta.id?1:0)){
  if(record.meta.operation==='delete')continue;const source=syncImageSource(state,record),row=record.row!,key=source.image.inboxId+'/'+row.position;
  if(positions.has(key)||state.source.previousCursor===null&&!parents.has(source.image.inboxId))throw new SyncImageError();positions.add(key);
  const group=groups.get(source.image.inboxId)??{bytes:0,positions:[]};group.bytes+=source.image.size;group.positions.push(row.position as number);if(group.bytes>10485760)throw new SyncImageError();groups.set(source.image.inboxId,group);
  planned.push({source,sourceHash:await syncImageSourceHash(source),recordToken:syncDownloadToken(record)});
 }
 if(state.source.previousCursor===null)for(const group of groups.values()){group.positions.sort((a,b)=>a-b);if(group.positions.some((position,index)=>position!==index))throw new SyncImageError();}
 abort(signal);const hash=await syncHash(new TextEncoder().encode(syncDownloadToken({readId:id,readSeal:state.seal,images:planned.map(p=>p.sourceHash)})));
 return {context,images:planned,hash};
}
/** No hashing, Blob reads or network waits may escape the native transaction. */
async function current(db:LocalStore,plan:ImagePlan,image:PlannedImage){
 const state=await assertSyncDownloadContext(db,plan.context),record=await db.syncRecords.get([state.id,image.source.changeId]);
 if(syncDownloadToken(state)!==syncDownloadToken(plan.context.state)||syncDownloadToken(record)!==image.recordToken)throw new SyncImageError();
}
async function cached(db:LocalStore,plan:ImagePlan,image:PlannedImage):Promise<LocalSyncImage|null>{
 const value=await db.transaction('r',db.cloudState,db.syncReads,db.syncRecords,db.syncImages,async()=>{await current(db,plan,image);return db.syncImages.get([image.source.readId,image.source.image.id]);});
 if(value===undefined)return null;const result=parseLocalSyncImage(value,image.source,image.sourceHash);await verifySyncImageBlob(image.source,result.blob);
 await db.transaction('r',db.cloudState,db.syncReads,db.syncRecords,async()=>current(db,plan,image));return result;
}
async function save(db:LocalStore,plan:ImagePlan,image:PlannedImage,blob:Blob):Promise<LocalSyncImage>{
 await verifySyncImageBlob(image.source,blob);
 const result=await db.transaction('rw',db.cloudState,db.syncReads,db.syncRecords,db.syncImages,async()=>{
  await current(db,plan,image);const previous=await db.syncImages.get([image.source.readId,image.source.image.id]);if(previous!==undefined)return parseLocalSyncImage(previous,image.source,image.sourceHash);
  const row:LocalSyncImage={readId:image.source.readId,imageId:image.source.image.id,source:structuredClone(image.source),sourceHash:image.sourceHash,blob};await db.syncImages.add(row);return row;
 });
 await verifySyncImageBlob(image.source,result.blob);return result;
}
/** Durable, per-image retries. This stages bytes without applying a domain row or accepting a cursor. */
export async function downloadSyncImages(db:LocalStore,id:string,target:SyncDownloadTarget,remote:SyncImageRemote,signal?:AbortSignal):Promise<VerifiedSyncImages>{
 target=parseSyncDownloadTarget(target);const plan=await planImages(db,id,target,signal),images:LocalSyncImage[]=[];
 for(const image of plan.images){abort(signal);let row=await cached(db,plan,image);if(!row){const blob=await remote.get(structuredClone(image.source),signal);abort(signal);row=await save(db,plan,image,blob);}images.push(row);}
 abort(signal);await db.transaction('r',db.cloudState,db.syncReads,db.syncRecords,async()=>{for(const image of plan.images)await current(db,plan,image);const state=await assertSyncDownloadContext(db,plan.context);if(syncDownloadToken(state)!==syncDownloadToken(plan.context.state))throw new SyncImageError();});
 return {readId:id,readSeal:plan.context.state.seal!,hash:plan.hash,bytes:images.reduce((sum,i)=>sum+i.blob.size,0),images};
}
/** Re-verifies original staged bytes offline. Cached data never grants fresh membership. */
export function readVerifiedSyncImages(db:LocalStore,id:string,target:SyncDownloadTarget,signal?:AbortSignal):Promise<VerifiedSyncImages>{
 return downloadSyncImages(db,id,target,{get:async()=>{throw new SyncImageError('retry');}},signal);
}
