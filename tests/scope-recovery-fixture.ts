import type {joinedApplyFixture} from './sync-apply-fixture';
import {newInboxId,inboxImageBase64,inboxImageBytes} from '../packages/core/inbox';
import {parseSyncScope,syncHash,syncRecordColumns,type SyncReadPage,type SyncReadPart,type SyncTable} from '../packages/core/sync-read';
import {parseScopeRecoverySession} from '../packages/core/scope-recovery';
import {nativeRowHash} from '../apps/web/src/data/canonical-writes';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {cloudRecordMaps,encodeCommandRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';

/** Synthetic full snapshot and coverage are local-test facts only. Native HTTP/SQL
 * browser tests separately exercise actual scope changes and permission checks. */
export async function stageScopeRecovery(f:Awaited<ReturnType<typeof joinedApplyFixture>>,options:{epoch?:string;scopeVersion?:string;role?:'owner'|'manager';updates?:{table:BackupTable;row:Record<string,unknown>}[]}={}){
 const base=(await f.db.syncCanonical.get('active'))!,binding=(await f.db.cloudState.get('binding'))!,operator=(await f.db.operatorState.get('active'))!,target={...f.target,role:options.role??base.snapshot.scope.role},id=newInboxId(),window={...f.window,...base.snapshot.scope,id,role:target.role,epoch:options.epoch??crypto.randomUUID(),scopeVersion:options.scopeVersion??crypto.randomUUID(),createdAt:Date.now(),expiresAt:Date.now()+86400000};
 const wire=(table:SyncTable,row:Record<string,unknown>)=>{const name=Object.entries(cloudRecordMaps).find(([,map])=>map.table===table)?.[0] as BackupTable|undefined;if(!name)return structuredClone(row);const values=encodeCommandRecord(name,row,target.businessId).values,fields=cloudRecordMaps[name].fields as Record<string,string>;return Object.fromEntries(syncRecordColumns[table].map(key=>[key,values[key]!==null&&fields[key]?.startsWith('j:')?JSON.parse(values[key] as string):values[key]]));};
 const records=new Map(base.snapshot.records.filter(r=>r.operation==='upsert').map(r=>[r.table+'\0'+r.id,{table:r.table,id:r.id,row:wire(r.table,r.row!)}]));
 for(const update of options.updates??[]){const table=cloudRecordMaps[update.table].table as SyncTable,row=wire(table,update.row);records.set(table+'\0'+update.row.id,{table,id:update.row.id as string,row});}
 if(options.role){const member=records.get('members\0'+target.actorId);if(!member)throw Error('Expected current member');member.row.role=options.role;if(options.role==='manager')records.set('member_outlets\0'+target.actorId,{table:'member_outlets',id:target.actorId,row:{business_id:target.businessId,outlet_id:target.outletId,member_id:target.actorId}});}
 const parts:SyncReadPart[]=[];for(const record of records.values()){const bytes=new TextEncoder().encode(JSON.stringify(record.row));parts.push({table:record.table,id:record.id,operation:'upsert',changeId:String(parts.length+1),offset:0,totalBytes:bytes.length,sha256:await syncHash(bytes),data:inboxImageBase64(bytes)});}
 const page:SyncReadPage={...parseSyncScope(window),v:1,id,index:0,parts,done:true,cursor:'synthetic-recovery-'+id};
 const session=parseScopeRecoverySession({id:'active',kind:'session',version:1,operationId:newInboxId(),revision:1,phase:'pending',problem:null,originalBindingHash:await nativeRowHash({...binding,sequence:0}),originalBaseHash:base.hash,originalScope:base.snapshot.scope,target,epoch:window.epoch,scopeVersion:window.scopeVersion,authKey:f.joinInput.authKey,expectedOperatorRevision:operator.revision,readId:id,admissionHash:null});
 await f.db.scopeRecoveries.put(session);await prepareSyncDownload(f.db,{id,target,previousCursor:null});await runSyncDownload(f.db,id,target,{begin:async()=>window,page:async()=>page});
 await downloadSyncImages(f.db,id,target,{get:async source=>{const image=base.snapshot.backup.tables.inboxItems.flatMap(item=>item.images).find(image=>image.id===source.image.id);if(!image)throw Error('Expected complete original bytes');return new Blob([new Uint8Array(inboxImageBytes(image))],{type:image.type});}});
 const context={...f.context,...parseSyncScope(window)};return {session,window,target,context,access:{refresh:async()=>structuredClone(context),assertActive:()=>{}}};
}
