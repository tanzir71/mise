import {parseLocalCloudState} from '@mise/core/local-outbox';
import {decodeSyncBase64,decodeSyncRecord,parseSyncPage,syncHash,syncPartBudget,type SyncReadPage,type SyncReadRequest,type SyncReadWindow,type SyncReadPart} from '@mise/core/sync-read';
import {advanceSyncDownload,downloadWindow,newSyncDownload,parseLocalSyncDownload,parseSyncDownloadSource,parseSyncDownloadTarget,syncDownloadError,syncDownloadToken,syncRecordMeta,type LocalSyncDownload,type LocalSyncRecord,type SyncDownloadTarget} from '@mise/core/sync-download';
import type {LocalStore} from './local-store';

export interface SyncDownloadRemote {begin(request:Extract<SyncReadRequest,{type:'begin'}>,signal?:AbortSignal):Promise<SyncReadWindow>;page(window:SyncReadWindow,index:number,signal?:AbortSignal):Promise<SyncReadPage>}
const digest=(v:unknown)=>syncHash(new TextEncoder().encode(syncDownloadToken(v)));
function binding(value:unknown):string {
 if(value===undefined)return syncDownloadToken(null);
 const {sequence:_,...stable}=parseLocalCloudState(value);void _;return syncDownloadToken(stable);
}
function activeBinding(value:unknown,target:SyncDownloadTarget){
 if(value===undefined)return;
 const saved=parseLocalCloudState(value);if(saved.phase==='cancelled')return;
 if(saved.phase!=='ready'||saved.targetHash!==target.targetHash||saved.businessId!==target.businessId||saved.outletId!==target.outletId)throw syncDownloadError();
}
interface Context {state:LocalSyncDownload;bindingToken:string}
async function context(db:LocalStore,id:string,target:SyncDownloadTarget):Promise<Context> {
 target=parseSyncDownloadTarget(target);
 const [raw,local]=await db.transaction('r',db.syncReads,db.cloudState,()=>Promise.all([db.syncReads.get(id),db.cloudState.get('binding')]));
 const state=parseLocalSyncDownload(raw),bindingToken=binding(local);activeBinding(local,target);
 if(syncDownloadToken(state.source.target)!==syncDownloadToken(target)||await digest(state.source)!==state.sourceHash||await syncHash(new TextEncoder().encode(bindingToken))!==state.source.bindingHash)throw syncDownloadError();
 return {state,bindingToken};
}
async function current(db:LocalStore,previous:Context):Promise<LocalSyncDownload> {
 const state=parseLocalSyncDownload(await db.syncReads.get(previous.state.id));
 if(state.sourceHash!==previous.state.sourceHash||syncDownloadToken(state.source)!==syncDownloadToken(previous.state.source)||binding(await db.cloudState.get('binding'))!==previous.bindingToken)throw syncDownloadError();
 return state;
}
/** Persist the request identity before the first network call, including on a new empty device. */
export async function prepareSyncDownload(db:LocalStore,input:{id:string;target:SyncDownloadTarget;previousCursor:string|null}):Promise<LocalSyncDownload> {
 input=structuredClone(input);const target=parseSyncDownloadTarget(input.target),local=await db.cloudState.get('binding');activeBinding(local,target);
 const bindingToken=binding(local),source=parseSyncDownloadSource({version:1,id:input.id,target,previousCursor:input.previousCursor,bindingHash:await syncHash(new TextEncoder().encode(bindingToken))}),state=newSyncDownload(source,await digest(source));
 return db.transaction('rw',db.cloudState,db.syncReads,async()=>{
  if(binding(await db.cloudState.get('binding'))!==bindingToken)throw syncDownloadError();
  const saved=await db.syncReads.get(source.id);if(saved){const previous=parseLocalSyncDownload(saved);if(syncDownloadToken(previous.source)!==syncDownloadToken(source)||previous.sourceHash!==state.sourceHash)throw syncDownloadError();return previous;}
  await db.syncReads.add(state);return state;
 });
}
export async function readSyncDownload(db:LocalStore,id:string,target:SyncDownloadTarget):Promise<LocalSyncDownload> {return (await context(db,id,target)).state;}
export async function bindSyncDownloadWindow(db:LocalStore,id:string,target:SyncDownloadTarget,value:SyncReadWindow):Promise<LocalSyncDownload> {
 value=structuredClone(value);const before=await context(db,id,target),window=downloadWindow(value,before.state.source);
 return db.transaction('rw',db.cloudState,db.syncReads,async()=>{const state=await current(db,before);if(state.window){if(syncDownloadToken(state.window)!==syncDownloadToken(window))throw syncDownloadError();return state;}const next={...state,window};await db.syncReads.put(next);return next;});
}
/** An exact replay is a no-op; page bytes and progress always commit together. */
export async function appendSyncDownloadPage(db:LocalStore,id:string,target:SyncDownloadTarget,input:SyncReadPage):Promise<LocalSyncDownload> {
 input=structuredClone(input);const before=await context(db,id,target);if(!before.state.window)throw syncDownloadError();
 const page=parseSyncPage(input,before.state.window,input.index),hash=await digest(page);
 return db.transaction('rw',db.cloudState,db.syncReads,db.syncPages,async()=>{
  const state=await current(db,before);if(syncDownloadToken(state.window)!==syncDownloadToken(before.state.window))throw syncDownloadError();
  const previous=await db.syncPages.get([id,page.index]);if(previous){if(previous.hash!==hash||syncDownloadToken(previous.page)!==syncDownloadToken(page)||page.index>=state.pages)throw syncDownloadError();return state;}
  const next=advanceSyncDownload(state,page);await db.syncPages.add({readId:id,index:page.index,hash,page});await db.syncReads.put(next);return next;
 });
}
/** Validate full rows only after all pages are durable. Partial verification is resumable. */
export async function verifySyncDownload(db:LocalStore,id:string,target:SyncDownloadTarget,signal?:AbortSignal):Promise<LocalSyncDownload> {
 target=parseSyncDownloadTarget(target);const before=await context(db,id,target),saved=before.state;if(!saved.window||!saved.receivedCursor)throw syncDownloadError();
 let replay:LocalSyncDownload={...newSyncDownload(saved.source,saved.sourceHash),window:saved.window},pending:{part:SyncReadPart;chunks:Uint8Array[]}|null=null;
 const pageHashes:string[]=[],recordHashes:{changeId:string;hash:string}[]=[];
 for(let index=0;index<saved.pages;index++){
  signal?.throwIfAborted();const stored=await db.syncPages.get([id,index]);if(!stored||stored.readId!==id||stored.index!==index)throw syncDownloadError();
  const page=parseSyncPage(stored.page,saved.window,index);if(await digest(page)!==stored.hash)throw syncDownloadError();pageHashes.push(stored.hash);replay=advanceSyncDownload(replay,page);
  const completed:LocalSyncRecord[]=[];
  for(const part of page.parts){
   if(!pending)pending={part,chunks:[]};pending.chunks.push(decodeSyncBase64(part.data,syncPartBudget));
   if(part.offset+pending.chunks.at(-1)!.length===part.totalBytes){
    const bytes=new Uint8Array(part.totalBytes);let at=0;for(const chunk of pending.chunks){bytes.set(chunk,at);at+=chunk.length;}
    const row=await decodeSyncRecord(pending.part,bytes,saved.window),record:LocalSyncRecord={readId:id,changeId:part.changeId,meta:syncRecordMeta(part),row,rowHash:await digest(row)};
    completed.push(record);recordHashes.push({changeId:record.changeId,hash:await digest(record)});pending=null;
   }
  }
  signal?.throwIfAborted();await db.transaction('rw',db.cloudState,db.syncReads,db.syncRecords,async()=>{
   const latest=await current(db,before);if(syncDownloadToken({...latest,seal:null})!==syncDownloadToken({...saved,seal:null}))throw syncDownloadError();
   for(const record of completed){const previous=await db.syncRecords.get([id,record.changeId]);if(previous){if(syncDownloadToken(previous)!==syncDownloadToken(record))throw syncDownloadError();}else await db.syncRecords.add(record);}
  });
 }
 if(pending||syncDownloadToken({...replay,seal:null})!==syncDownloadToken({...saved,seal:null})||recordHashes.length!==saved.records)throw syncDownloadError();
 const seal=await digest({sourceHash:saved.sourceHash,window:saved.window,pageHashes,recordHashes,cursor:saved.receivedCursor});signal?.throwIfAborted();
 return db.transaction('rw',db.cloudState,db.syncReads,db.syncPages,db.syncRecords,async()=>{
  const latest=await current(db,before);if(syncDownloadToken({...latest,seal:null})!==syncDownloadToken({...saved,seal:null})||latest.seal&&latest.seal!==seal||await db.syncPages.where('readId').equals(id).count()!==saved.pages||await db.syncRecords.where('readId').equals(id).count()!==saved.records)throw syncDownloadError();
  const next={...latest,seal};await db.syncReads.put(next);return next;
 });
}
/** No domain writes, accepted-cursor changes, outbox receipts or synthetic local events. */
export async function runSyncDownload(db:LocalStore,id:string,target:SyncDownloadTarget,remote:SyncDownloadRemote,signal?:AbortSignal):Promise<LocalSyncDownload> {
 target=parseSyncDownloadTarget(target);let state=await readSyncDownload(db,id,target);signal?.throwIfAborted();
 if(!state.window){const source=state.source,window=await remote.begin({type:'begin',id,outletId:target.outletId,cursor:source.previousCursor},signal);signal?.throwIfAborted();state=await bindSyncDownloadWindow(db,id,target,window);}
 while(!state.receivedCursor){signal?.throwIfAborted();const page=await remote.page(structuredClone(state.window!),state.pages,signal);signal?.throwIfAborted();state=await appendSyncDownloadPage(db,id,target,page);}
 return verifySyncDownload(db,id,target,signal);
}
