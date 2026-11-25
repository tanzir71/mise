import {decodeSyncBase64,parseSyncWindow,syncPartBudget,syncRecordColumns,type SyncReadPart,type SyncReadPage,type SyncReadWindow} from './sync-read';
import {literalToken as syncDownloadToken} from './literal-token';
export {literalToken as syncDownloadToken} from './literal-token';
export const localDownloadTableNames=['syncReads','syncPages','syncRecords'] as const;

export interface SyncDownloadTarget {targetHash:string;businessId:string;outletId:string;actorId:string;accountHash:string;role:'owner'|'manager'}
export interface SyncDownloadSource {version:1;id:string;target:SyncDownloadTarget;previousCursor:string|null;bindingHash:string}
export type SyncRecordMeta=Pick<SyncReadPart,'changeId'|'table'|'id'|'operation'|'totalBytes'|'sha256'>;
export interface SyncDownloadPosition extends SyncRecordMeta {received:number}
export interface LocalSyncDownload {
 id:string;version:1;source:SyncDownloadSource;sourceHash:string;window:SyncReadWindow|null;
 pages:number;last:SyncDownloadPosition|null;records:number;bytes:number;receivedCursor:string|null;seal:string|null;
}
export interface LocalSyncPage {readId:string;index:number;hash:string;page:SyncReadPage}
export interface LocalSyncRecord {readId:string;changeId:string;meta:SyncRecordMeta;row:Record<string,unknown>|null;rowHash:string}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const count=(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
export const syncDownloadError=()=>new Error('The original download needs recovery. Keep local work and its saved pages.');
export function parseSyncDownloadTarget(v:unknown):SyncDownloadTarget {
 if(!object(v)||!exact(v,'targetHash,businessId,outletId,actorId,accountHash,role')||!hash(v.targetHash)||!hash(v.accountHash)||![v.businessId,v.outletId,v.actorId].every(id)||!['owner','manager'].includes(v.role as string))throw syncDownloadError();
 return {targetHash:v.targetHash,businessId:v.businessId as string,outletId:v.outletId as string,actorId:v.actorId as string,accountHash:v.accountHash,role:v.role as SyncDownloadTarget['role']};
}
export function parseSyncDownloadSource(v:unknown):SyncDownloadSource {
 if(!object(v)||!exact(v,'version,id,target,previousCursor,bindingHash')||v.version!==1||!id(v.id)||!hash(v.bindingHash)||(v.previousCursor!==null&&(typeof v.previousCursor!=='string'||!v.previousCursor||v.previousCursor.length>131072)))throw syncDownloadError();
 return {version:1,id:v.id,target:parseSyncDownloadTarget(v.target),previousCursor:v.previousCursor as string|null,bindingHash:v.bindingHash};
}
export function syncRecordMeta(part:SyncReadPart):SyncRecordMeta {return {changeId:part.changeId,table:part.table,id:part.id,operation:part.operation,totalBytes:part.totalBytes,sha256:part.sha256};}
function position(v:unknown):SyncDownloadPosition {
 if(!object(v)||!exact(v,'changeId,table,id,operation,totalBytes,sha256,received')||typeof v.changeId!=='string'||!/^[1-9][0-9]{0,18}$/.test(v.changeId)||BigInt(v.changeId)>9223372036854775807n||!id(v.id)||typeof v.table!=='string'||!Object.hasOwn(syncRecordColumns,v.table)||!['upsert','delete'].includes(v.operation as string)||!count(v.totalBytes,1073741824)||v.totalBytes<1||!hash(v.sha256)||!count(v.received,v.totalBytes)||v.received<1)throw syncDownloadError();
 return {changeId:v.changeId,table:v.table as SyncReadPart['table'],id:v.id,operation:v.operation as SyncReadPart['operation'],totalBytes:v.totalBytes,sha256:v.sha256,received:v.received};
}
export function downloadWindow(value:unknown,source:SyncDownloadSource):SyncReadWindow {
 const window=parseSyncWindow(value,{type:'begin',id:source.id,outletId:source.target.outletId,cursor:source.previousCursor});
 for(const key of ['businessId','outletId','actorId','accountHash','role'] as const)if(window[key]!==source.target[key])throw syncDownloadError();
 return window;
}
export function parseLocalSyncDownload(v:unknown):LocalSyncDownload {
 if(!object(v)||!exact(v,'id,version,source,sourceHash,window,pages,last,records,bytes,receivedCursor,seal')||v.version!==1||!id(v.id)||!hash(v.sourceHash)||!count(v.pages,1000001)||!count(v.records,v.pages*256)||!count(v.bytes)||!(v.receivedCursor===null||typeof v.receivedCursor==='string'&&v.receivedCursor.length>0&&v.receivedCursor.length<=131072)||!(v.seal===null||hash(v.seal)))throw syncDownloadError();
 const source=parseSyncDownloadSource(v.source);if(v.id!==source.id)throw syncDownloadError();
 const window=v.window===null?null:downloadWindow(v.window,source),last=v.last===null?null:position(v.last);
 if(!window&&(v.pages||last||v.records||v.bytes||v.receivedCursor||v.seal)||!v.pages&&(last||v.records||v.bytes||v.receivedCursor||v.seal)||!last&&(v.records||v.bytes)||last&&(v.bytes<last.received||v.records<Number(last.received===last.totalBytes))||v.receivedCursor&&last&&last.received!==last.totalBytes||v.seal&&!v.receivedCursor)throw syncDownloadError();
 return {id:v.id,version:1,source,sourceHash:v.sourceHash,window,pages:v.pages,last,records:v.records,bytes:v.bytes,receivedCursor:v.receivedCursor as string|null,seal:v.seal as string|null};
}
export function newSyncDownload(source:SyncDownloadSource,sourceHash:string):LocalSyncDownload {return parseLocalSyncDownload({id:source.id,version:1,source,sourceHash,window:null,pages:0,last:null,records:0,bytes:0,receivedCursor:null,seal:null});}
/** Cross-page ordering prevents a complete-looking cursor from covering a missing fragment. */
export function advanceSyncDownload(state:LocalSyncDownload,page:SyncReadPage):LocalSyncDownload {
 if(!state.window||state.receivedCursor||state.seal||page.index!==state.pages)throw syncDownloadError();
 let last=state.last,records=state.records,bytes=state.bytes;
 for(const part of page.parts){
  const meta=syncRecordMeta(part),raw=decodeSyncBase64(part.data,syncPartBudget);
  if(last&&part.changeId===last.changeId){if(syncDownloadToken(meta)!==syncDownloadToken({...last,received:undefined})||part.offset!==last.received||last.received===last.totalBytes)throw syncDownloadError();}
  else if(part.offset!==0||last&&(BigInt(part.changeId)<=BigInt(last.changeId)||last.received!==last.totalBytes))throw syncDownloadError();
  last={...meta,received:part.offset+raw.length};bytes+=raw.length;if(last.received===last.totalBytes)records++;
 }
 if(page.done&&last&&last.received!==last.totalBytes)throw syncDownloadError();
 return parseLocalSyncDownload({...state,pages:state.pages+1,last,records,bytes,receivedCursor:page.cursor});
}
