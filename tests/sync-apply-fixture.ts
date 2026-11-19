import {MiseDatabase} from '../apps/web/src/data/db';
import {syncJoinFixture} from './sync-join-fixture';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {joinCanonicalDevice} from '../apps/web/src/data/cloud-sync-join';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {cloudRecordMaps,encodeCommandRecord} from '../packages/core/cloud-records';
import {newInboxId,inboxImageBase64} from '../packages/core/inbox';
import {parseSyncScope,syncHash,type SyncReadPage,type SyncReadPart} from '../packages/core/sync-read';
import type {BackupTable} from '../packages/core/backup-tables';
import type {SyncCoverageSource,SyncCoveragePage} from '../packages/core/sync-coverage';
import type {OperatorContext} from '../packages/core/operators';

/** Synthetic network facts for focused local tests; native SQL HTTP is separate. */
export async function joinedApplyFixture(manager=false,beforeJoin?:(db:MiseDatabase)=>Promise<void>){
 const f=await syncJoinFixture(manager),db=new MiseDatabase('mise-apply-'+newInboxId()),authKey='mise.cloud.auth.'+'c'.repeat(64),context:OperatorContext={...parseSyncScope(f.window),version:1,businessName:null,outletName:null,actorName:null},refresh=async()=>structuredClone(context);
 if(beforeJoin)await beforeJoin(db);
 const operator=await selectCloudOperator(db,context,{authKey,targetHash:f.target.targetHash},null,refresh);
 await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:null});await runSyncDownload(db,f.window.id,f.target,{begin:async()=>f.window,page:async(_w,i)=>f.pages[i]});await downloadSyncImages(db,f.window.id,f.target,{get:async source=>new Blob([new Uint8Array(f.imageBytes).buffer],{type:source.image.type})});const joinInput={readId:f.window.id,target:f.target,authKey,expectedOperatorRevision:operator.revision};const joined=await joinCanonicalDevice(db,joinInput,refresh);
 async function stage(updates:{table:BackupTable;row:Record<string,unknown>|unknown;operation?:'upsert'|'delete'}[]=[]){
  const base=(await db.syncCanonical.get('active'))!,id=newInboxId(),target={...f.target,role:base.snapshot.scope.role},window={...f.window,...base.snapshot.scope,id,createdAt:Date.now(),expiresAt:Date.now()+86400000};let ordinal=base.snapshot.records.reduce((n,r)=>BigInt(r.changeId)>n?BigInt(r.changeId):n,0n);const parts:SyncReadPart[]=[];
  for(const update of updates){const values=encodeCommandRecord(update.table,update.row,f.target.businessId).values,fields=cloudRecordMaps[update.table].fields as Record<string,string>,raw=update.operation==='delete'?null:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v!==null&&fields[k]?.startsWith('j:')?JSON.parse(v as string):v])),bytes=new TextEncoder().encode(JSON.stringify(raw));parts.push({table:cloudRecordMaps[update.table].table,id:(update.row as {id:string}).id,operation:update.operation??'upsert',changeId:String(++ordinal),offset:0,totalBytes:bytes.length,sha256:await syncHash(bytes),data:inboxImageBase64(bytes)});}
  const page:SyncReadPage={...parseSyncScope(window),v:1,id,index:0,parts,done:true,cursor:'synthetic-next-'+id};await prepareSyncDownload(db,{id,target,previousCursor:base.snapshot.cursor});await runSyncDownload(db,id,target,{begin:async()=>window,page:async()=>page});const state=(await db.operatorState.get('active'))!;return {readId:id,target,authKey,expectedOperatorRevision:state.revision};
 }
 return {...f,db,context,refresh,joinInput,joined,stage};
}
export function coverageFacts(source:SyncCoverageSource,states:Record<string,'visible'|'absent'|'later'|'unknown'>={}):SyncCoveragePage{
 return {...parseSyncScope(source.window),v:1,id:source.readId,cursor:source.cursor,ids:source.intents.map(c=>c.id),coverage:source.intents.map(c=>({id:c.id,state:states[c.id]??'absent',type:states[c.id]==='absent'||!states[c.id]?null:c.type,requestHash:states[c.id]==='absent'||!states[c.id]?null:c.requestHash}))};
}
