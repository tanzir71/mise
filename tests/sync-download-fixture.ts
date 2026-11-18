import {cloudUploadFixture} from './cloud-upload-fixture';
import {cloudRecordMaps,prepareCloudMigration} from '../packages/core/cloud-records';
import {syncHash,syncRecordColumns,type SyncReadPage,type SyncReadPart,type SyncReadWindow,type SyncTable} from '../packages/core/sync-read';
import type {SyncDownloadTarget} from '../packages/core/sync-download';
import {newInboxId} from '../packages/core/inbox';
import type {MiseBackup} from '../packages/core/backup-tables';
const base64=(bytes:Uint8Array)=>{let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw);};
export async function syncDownloadFixture(options:{large?:boolean;items?:number;budget?:number;empty?:boolean;source?:MiseBackup}={}){
 const backup=options.source??cloudUploadFixture(options.items),migration=await prepareCloudMigration(backup,'00000000-0000-4000-8000-000000000001'),target:SyncDownloadTarget={targetHash:'a'.repeat(64),businessId:backup.tables.businesses[0].id,outletId:backup.tables.outlets[0].id,actorId:backup.tables.members[0].id,accountHash:'b'.repeat(64),role:'owner'},window:SyncReadWindow={...target,v:1,id:newInboxId(),createdAt:1000,expiresAt:86401000,epoch:'00000000-0000-4000-8000-000000000002',scopeVersion:'00000000-0000-4000-8000-000000000003'};
 delete (window as unknown as Record<string,unknown>).targetHash;
 const rows:SyncReadPart[]=[],bytes:Uint8Array[]=[],large='Literal\0\ud800 বাংলা '.repeat(26000);let ordinal=9007199254740993n;
 if(!options.empty)for(const r of migration.records){
  const table=r.table as SyncTable,map=Object.values(cloudRecordMaps).find(m=>m.table===table),fields=map?.fields as Record<string,string>|undefined,projected=Object.fromEntries(syncRecordColumns[table].map(k=>{let v:unknown=r.values[k];if(v!==null&&typeof v==='string'&&(fields?.[k]?.startsWith('j:')||table==='inbox_images'&&k==='name'))v=JSON.parse(v);return [k,v];}));
  if(options.large&&table==='customers')projected.notes=large;
  if(options.large&&table==='businesses')projected.name=large;
  const raw=new TextEncoder().encode(JSON.stringify(projected)),key=table==='member_outlets'?'member_id':table==='customer_outlets'?'customer_id':'id';
  rows.push({changeId:String(ordinal++),table,id:projected[key] as string,operation:'upsert',offset:0,totalBytes:raw.length,sha256:await syncHash(raw),data:''});bytes.push(raw);
 }
 const pages:SyncReadPage[]=[],budget=options.budget??196608;let index=0,offset=0;
 do {const parts:SyncReadPart[]=[];let left=budget;while(index<rows.length&&left>0&&parts.length<256){const row=rows[index],raw=bytes[index].slice(offset,offset+left);parts.push({...row,offset,data:base64(raw)});left-=raw.length;offset+=raw.length;if(offset===row.totalBytes){index++;offset=0;}}
  const done=index===rows.length;pages.push({...window,index:pages.length,parts,done,cursor:done?'synthetic-received-cursor':null});
 }while(index<rows.length);
 // HTTP pages omit the read-window timestamps.
 for(const p of pages){delete (p as unknown as Record<string,unknown>).createdAt;delete (p as unknown as Record<string,unknown>).expiresAt;}
 return {backup,target,window,pages,rows,large};
}
