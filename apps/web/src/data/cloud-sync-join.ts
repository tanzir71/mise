import Dexie from 'dexie';
import {backupTableNames} from '@mise/core/backup-tables';
import {backupToken,createBackup} from '@mise/core/backup';
import {parseLocalCloudState,type LocalCloudState} from '@mise/core/local-outbox';
import {parseLocalOperatorState,parseOperatorContext,OperatorContextError,type LocalOperatorState,type OperatorContext} from '@mise/core/operators';
import {canonicalSnapshotHash,reconstructCanonicalSnapshot,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {parseSyncDownloadTarget,syncDownloadToken,type SyncDownloadTarget} from '@mise/core/sync-download';
import {parseSyncScope} from '@mise/core/sync-read';
import {verifySyncImageBlob} from '@mise/core/sync-images';
import type {MiseDatabase} from './db';
import {portableInboxItems,storedInboxItems} from './inbox';
import {readDatabaseBackup} from './backup';
import {assertSyncDownloadContext,readVerifiedSyncRecords} from './cloud-sync-journal';
import {readVerifiedSyncImages} from './cloud-sync-images';

export interface JoinCanonicalInput {readId:string;target:SyncDownloadTarget;authKey:string;expectedOperatorRevision:number}
export interface JoinedDevice {readId:string;canonicalHash:string;operatorRevision:number;records:number;images:number}
const fail=()=>new OperatorContextError('Keep this device’s local work. Review the original outlet and download before joining.');
function selected(value:unknown,input:JoinCanonicalInput,active:boolean):LocalOperatorState {
 const state=parseLocalOperatorState(value),connection=state.connection;
 if(state.phase!==(active?'active':'pending')||!connection||connection.authKey!==input.authKey||connection.targetHash!==input.target.targetHash||connection.accountHash!==input.target.accountHash||state.businessId!==input.target.businessId||state.outletId!==input.target.outletId||state.actorId!==input.target.actorId||state.role!==input.target.role||(!active&&state.revision!==input.expectedOperatorRevision))throw fail();
 return state;
}
async function fresh(context:OperatorContext,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal){
 signal?.throwIfAborted();const value=parseOperatorContext(await refresh(structuredClone(context)));signal?.throwIfAborted();
 if(syncDownloadToken(parseSyncScope(value))!==syncDownloadToken(parseSyncScope(context)))throw fail();return value;
}
function result(base:LocalCanonicalSnapshot,operator:LocalOperatorState):JoinedDevice {
 return {readId:base.snapshot.readId,canonicalHash:base.hash,operatorRevision:operator.revision,records:base.snapshot.records.length,images:base.snapshot.backup.tables.inboxItems.reduce((n,i)=>n+i.images.length,0)};
}
/** A retry after a lost local response verifies the original admission, never reapplies rows. */
async function existing(db:MiseDatabase,input:JoinCanonicalInput,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal):Promise<JoinedDevice|null>{
 const saved=await db.transaction('r',db.cloudState,db.syncCanonical,db.operatorState,async()=>({binding:await db.cloudState.get('binding'),base:await db.syncCanonical.get('active'),operator:await db.operatorState.get('active')}));
 if(!saved.binding)return null;const binding=parseLocalCloudState(saved.binding),base=saved.base;
 if(binding.version!==2||binding.join?.readId!==input.readId||!base||base.id!=='active'||base.version!==1||base.hash!==binding.manifestHash||await canonicalSnapshotHash(base.snapshot)!==base.hash||base.snapshot.readId!==input.readId||base.snapshot.cursor!==binding.join.cursor||base.snapshot.seal!==binding.join.readSeal||base.snapshot.targetHash!==input.target.targetHash||syncDownloadToken(base.snapshot.scope)!==syncDownloadToken({...parseSyncScope(base.snapshot.scope),businessId:input.target.businessId,outletId:input.target.outletId,actorId:input.target.actorId,accountHash:input.target.accountHash,role:input.target.role}))throw fail();
 if(binding.targetHash!==input.target.targetHash||binding.businessId!==input.target.businessId||binding.outletId!==input.target.outletId||binding.ownerId!==input.target.actorId||binding.join.accountHash!==input.target.accountHash||binding.join.role!==input.target.role||binding.join.epoch!==base.snapshot.scope.epoch||binding.join.scopeVersion!==base.snapshot.scope.scopeVersion)throw fail();
 const operator=selected(saved.operator,input,true);if(operator.revision<input.expectedOperatorRevision+1||operator.connection?.epoch!==base.snapshot.scope.epoch||operator.connection.scopeVersion!==base.snapshot.scope.scopeVersion)throw fail();
 await fresh({...base.snapshot.scope,version:1,businessName:null,outletName:null,actorName:null},refresh,signal);
 return db.transaction('r',db.cloudState,db.syncCanonical,db.operatorState,async()=>{
  signal?.throwIfAborted();const [current,latest,raw]=await Promise.all([db.cloudState.get('binding'),db.syncCanonical.get('active'),db.operatorState.get('active')]);
  // Sequence may advance with genuine offline edits; admission and base stay fixed.
  if(!current||syncDownloadToken({...current,sequence:0})!==syncDownloadToken({...binding,sequence:0})||syncDownloadToken(latest)!==syncDownloadToken(base)||syncDownloadToken(raw)!==syncDownloadToken(saved.operator))throw fail();
  return result(base,operator);
 });
}

/** Join an existing outlet on a device without a local shop. Domain rows, base,
 * accepted cursor, operator and a distinct v2 fence commit in one native writer.
 * Capture stays enabled: the fence is installed only after exact empty-device
 * checks and canonical writes, with all domain/outbox stores held by this writer.
 */
export async function joinCanonicalDevice(db:MiseDatabase,input:JoinCanonicalInput,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal):Promise<JoinedDevice> {
 input=structuredClone(input);input.target=parseSyncDownloadTarget(input.target);
 if(!Number.isSafeInteger(input.expectedOperatorRevision)||input.expectedOperatorRevision<1||input.expectedOperatorRevision>=Number.MAX_SAFE_INTEGER)throw fail();
 const replay=await existing(db,input,refresh,signal);if(replay)return replay;
 const verified=await readVerifiedSyncRecords(db,input.readId,input.target,signal),state=verified.context.state;
 if(state.source.previousCursor!==null||!state.window)throw fail();
 const operator=selected(await db.operatorState.get('active'),input,false);
 if(operator.connection?.epoch!==state.window.epoch||operator.connection.scopeVersion!==state.window.scopeVersion)throw fail();
 const images=await readVerifiedSyncImages(db,input.readId,input.target,signal),snapshot=await reconstructCanonicalSnapshot(state,verified.records,images.images),base:LocalCanonicalSnapshot={id:'active',version:1,snapshot,hash:await canonicalSnapshotHash(snapshot)},stored=storedInboxItems(snapshot.backup.tables.inboxItems);
 const pages=await db.syncPages.where('readId').equals(input.readId).sortBy('index');
 await fresh({...parseSyncScope(state.window),version:1,businessName:null,outletName:null,actorName:null},refresh,signal);
 return db.transaction('rw',db.tables,async()=>{
  signal?.throwIfAborted();if(await db.cloudState.count()||await db.syncCanonical.count()||await db.outbox.count())throw fail();
  const current=await assertSyncDownloadContext(db,verified.context);if(syncDownloadToken(current)!==syncDownloadToken(state)||syncDownloadToken(await db.operatorState.get('active'))!==syncDownloadToken(operator)||syncDownloadToken(await db.syncRecords.where('readId').equals(input.readId).sortBy('changeId'))!==syncDownloadToken([...verified.records].sort((a,b)=>a.changeId.localeCompare(b.changeId)))||syncDownloadToken(await db.syncPages.where('readId').equals(input.readId).sortBy('index'))!==syncDownloadToken(pages))throw fail();
  for(const name of backupTableNames)if(name!=='inboxItems'&&await db.table(name).count())throw fail();
  const unassigned=await db.inboxItems.toArray();if(unassigned.some(item=>item.outletId!==null||stored.some(i=>i.id===item.id)))throw fail();
  for(const image of images.images){const row=await db.syncImages.get([input.readId,image.imageId]);if(!row||syncDownloadToken({...row,blob:undefined})!==syncDownloadToken({...image,blob:undefined}))throw fail();await Dexie.waitFor(verifySyncImageBlob(row.source,row.blob));}
  const active:LocalOperatorState={...operator,revision:operator.revision+1,phase:'active'},binding:LocalCloudState={id:'binding',version:2,uploadId:state.id,businessId:input.target.businessId,outletId:input.target.outletId,ownerId:input.target.actorId,targetHash:input.target.targetHash,manifestHash:base.hash,phase:'ready',sequence:0,receipt:null,join:{kind:'join',readId:state.id,readSeal:state.seal!,cursor:state.receivedCursor!,accountHash:input.target.accountHash,role:input.target.role,epoch:state.window!.epoch,scopeVersion:state.window!.scopeVersion}};
  parseLocalCloudState(binding);
  for(const name of backupTableNames)await db.table(name).bulkAdd(name==='inboxItems'?stored:snapshot.backup.tables[name]);
  await db.syncCanonical.add(base);await db.operatorState.put(active);await db.cloudState.add(binding);
  // Validate the exact postcondition after every write/hook, while the native
  // writer still excludes other tabs. Unexpected local work aborts the join;
  // an absent pre-join fence is never a generic capture bypass.
  const expected=structuredClone(snapshot.backup.tables);expected.inboxItems.push(...await Dexie.waitFor(portableInboxItems(unassigned)));
  if(backupToken(await readDatabaseBackup(db))!==backupToken(createBackup(expected,snapshot.backup.exportedAt))||await db.outbox.count()||syncDownloadToken(await db.cloudState.get('binding'))!==syncDownloadToken(binding)||syncDownloadToken(await db.operatorState.get('active'))!==syncDownloadToken(active)||syncDownloadToken(await db.syncCanonical.get('active'))!==syncDownloadToken(base))throw fail();
  signal?.throwIfAborted();return result(base,active);
 });
}
