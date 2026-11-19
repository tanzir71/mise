import {createBackup,parseBackup} from './backup';
import {emptyBackupTables,type BackupTable,type MiseBackup} from './backup-tables';
import {cloudRecordMaps} from './cloud-records';
import {inboxImageBase64,inboxImageBytes,validateInboxImageBytes} from './inbox';
import {parseLocalSyncDownload,syncDownloadToken,type LocalSyncDownload,type LocalSyncRecord} from './sync-download';
import {parseLocalSyncImage,syncImageSource,syncImageSourceHash,verifySyncImageBlob,type LocalSyncImage} from './sync-images';
import {parseSyncScope,syncHash,syncRecordColumns,type SyncScope,type SyncTable} from './sync-read';

export interface CanonicalRecord {table:SyncTable;id:string;changeId:string;operation:'upsert'|'delete';row:Record<string,unknown>|null;rowHash:string}
export interface CanonicalSnapshot {backup:MiseBackup;records:CanonicalRecord[];cursor:string;readId:string;seal:string;scope:SyncScope;targetHash:string}
export const localCanonicalTableNames=['syncCanonical'] as const;
export type LocalCanonicalSnapshot =
 |{id:'active'|`join:${string}`|`upload:${string}`;version:1;snapshot:CanonicalSnapshot;hash:string}
 |{id:'active';version:2;snapshot:CanonicalSnapshot;hash:string;applicationHash:string};
const fail=()=>new Error('The canonical snapshot is incomplete or changed. Keep local work and the original download.');
const digest=(v:unknown)=>syncHash(new TextEncoder().encode(syncDownloadToken(v)));
const ordinal=(v:string)=>{if(!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)throw fail();return BigInt(v);};

/** Retain tombstones and full bigint ordinals; a late older change cannot resurrect a row. */
export async function mergeCanonicalRecords(previous:readonly CanonicalRecord[],incoming:readonly LocalSyncRecord[],readId:string):Promise<CanonicalRecord[]> {
 const rows=new Map<string,CanonicalRecord>(),ordinals=new Map<string,string>();
 for(const entry of [...previous,...incoming.map(r=>{if(r.readId!==readId||r.changeId!==r.meta.changeId)throw fail();return {...r.meta,row:r.row,rowHash:r.rowHash};})]){
  const row:CanonicalRecord={table:entry.table,id:entry.id,changeId:entry.changeId,operation:entry.operation,row:structuredClone(entry.row),rowHash:entry.rowHash};
  ordinal(row.changeId);if(!Object.hasOwn(syncRecordColumns,row.table)||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(row.id)||!['upsert','delete'].includes(row.operation)||row.operation==='delete'&&row.row!==null||row.operation==='upsert'&&(!row.row||typeof row.row!=='object'||Array.isArray(row.row))||await digest(row.row)!==row.rowHash)throw fail();
  const key=row.table+'\0'+row.id,old=rows.get(key),identity=syncDownloadToken(row),seen=ordinals.get(row.changeId);
  if(seen!==undefined&&seen!==identity)throw fail();ordinals.set(row.changeId,identity);
  if(old&&ordinal(old.changeId)===ordinal(row.changeId)&&syncDownloadToken(old)!==identity)throw fail();
  if(!old||ordinal(row.changeId)>ordinal(old.changeId))rows.set(key,row);
 }
 return [...rows.values()].sort((a,b)=>a.table.localeCompare(b.table)||a.id.localeCompare(b.id));
}

/** Build a complete scoped model before any IndexedDB domain write or cursor acceptance. */
export async function reconstructCanonicalSnapshot(input:LocalSyncDownload,incoming:readonly LocalSyncRecord[],images:readonly LocalSyncImage[],previous:CanonicalSnapshot|null=null):Promise<CanonicalSnapshot> {
 const state=parseLocalSyncDownload(input),scope=state.source.target;if(!state.seal||!state.receivedCursor||!state.window||state.source.previousCursor!==(previous?.cursor??null))throw fail();
 if(incoming.length!==state.records||new Set(incoming.map(r=>r.changeId)).size!==incoming.length)throw fail();
 if(previous){parseBackup(previous.backup);if(previous.targetHash!==scope.targetHash||syncDownloadToken(previous.scope)!==syncDownloadToken(parseSyncScope(state.window)))throw fail();}
 const records=await mergeCanonicalRecords(previous?.records??[],incoming,state.id),live=records.filter(r=>r.operation==='upsert'),tables=emptyBackupTables(),extras:CanonicalRecord[]=[];
 for(const record of live){
  const name=Object.entries(cloudRecordMaps).find(([,map])=>map.table===record.table)?.[0] as BackupTable|undefined;
  if(!name){extras.push(record);continue;}
  const row=structuredClone(record.row!);if(row.id!==record.id)throw fail();
  if(name==='members')row.outletIds=[];if(name==='inboxItems')row.images=[];
  (tables[name] as unknown[]).push(row);
 }
 if(tables.businesses.length!==1||tables.businesses[0].id!==scope.businessId||tables.outlets.length!==1||tables.outlets[0].id!==scope.outletId||tables.outlets[0].businessId!==scope.businessId)throw fail();
 for(const record of extras){const row=record.row!;
  if(row.business_id!==scope.businessId||'outlet_id'in row&&row.outlet_id!==scope.outletId)throw fail();
  if(record.table==='member_refs'){
   if(Object.keys(row).sort().join(',')!=='business_id,created_at,id,name,role,updated_at'||row.id!==record.id)throw fail();
   if(!tables.members.some(m=>m.id===record.id))tables.members.push({id:record.id,businessId:scope.businessId,createdAt:row.created_at as number,updatedAt:row.updated_at as number,name:row.name as string,role:row.role as MiseBackup['tables']['members'][number]['role'],active:false,outletIds:[]});
  }
 }
 const customers=new Set<string>(),usedImages=new Set<string>();
 for(const record of extras){const row=record.row!;
  if(record.table==='member_outlets'){
   const member=tables.members.find(m=>m.id===record.id);if(!member||row.member_id!==record.id||member.outletIds.includes(scope.outletId)||!member.active&&member.id===scope.actorId)throw fail();member.outletIds.push(scope.outletId);
  }else if(record.table==='customer_outlets'){
   if(row.customer_id!==record.id||!tables.customers.some(c=>c.id===record.id)||customers.has(record.id))throw fail();customers.add(record.id);
  }else if(record.table==='inbox_images'){
   const item=tables.inboxItems.find(i=>i.id===row.inbox_item_id),position=row.position;
   if(!item||!Number.isInteger(position)||(position as number)<0||(position as number)>3||item.images[position as number]!==undefined)throw fail();
   const original=incoming.find(r=>r.meta.table==='inbox_images'&&r.meta.id===record.id&&r.changeId===record.changeId);
   if(usedImages.has(record.id))throw fail();
   if(original){
    const source=syncImageSource(state,original),hash=await syncImageSourceHash(source),raw=images.find(i=>i.imageId===record.id);if(!raw)throw fail();
    const image=parseLocalSyncImage(raw,source,hash);await verifySyncImageBlob(source,image.blob);
    item.images[position as number]={id:record.id,name:row.name as string,type:source.image.type,size:source.image.size,data:inboxImageBase64(new Uint8Array(await image.blob.arrayBuffer()))};
   }else{
    const old=previous?.records.find(r=>r.table==='inbox_images'&&r.id===record.id),image=previous?.backup.tables.inboxItems.find(i=>i.id===item.id)?.images.find(i=>i.id===record.id);
    if(!old||syncDownloadToken(old)!==syncDownloadToken(record)||!image||image.name!==row.name||image.type!==row.type||image.size!==row.size)throw fail();
    const bytes=inboxImageBytes(image);validateInboxImageBytes(image.type,bytes);if(bytes.length!==image.size||await syncHash(bytes)!==row.sha256)throw fail();item.images[position as number]=structuredClone(image);
   }
   usedImages.add(record.id);
  }else if(record.table!=='member_refs')throw fail();
 }
 if(customers.size!==tables.customers.length||images.some(i=>!usedImages.has(i.imageId))||new Set(images.map(i=>i.imageId)).size!==images.length||tables.inboxItems.some(item=>Object.keys(item.images).length!==item.images.length))throw fail();
 const actor=tables.members.find(m=>m.id===scope.actorId);if(!actor?.active||actor.role!==scope.role||actor.businessId!==scope.businessId||actor.role==='manager'&&!actor.outletIds.includes(scope.outletId))throw fail();
 for(const row of [...tables.members,...tables.customers])if(row.businessId!==scope.businessId)throw fail();
 for(const name of Object.keys(tables) as BackupTable[])for(const row of tables[name])if('outletId'in row&&row.outletId!==scope.outletId)throw fail();
 return {backup:createBackup(tables,state.window.createdAt),records,cursor:state.receivedCursor,readId:state.id,seal:state.seal,scope:parseSyncScope(state.window),targetHash:scope.targetHash};
}
export const canonicalSnapshotHash=(snapshot:CanonicalSnapshot):Promise<string>=>digest(snapshot);
