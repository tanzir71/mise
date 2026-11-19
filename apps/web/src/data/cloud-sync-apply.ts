import Dexie from 'dexie';
import {backupToken,createBackup} from '@mise/core/backup';
import type {MiseBackup} from '@mise/core/backup-tables';
import {parseLocalCloudState,type LocalOutboxEntry,type LocalRowChange} from '@mise/core/local-outbox';
import {parseLocalOperatorState,parseOperatorContext,type LocalOperatorState,type OperatorContext} from '@mise/core/operators';
import {canonicalSnapshotHash,reconstructCanonicalSnapshot,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {syncDownloadToken,type SyncDownloadTarget} from '@mise/core/sync-download';
import {parseSyncScope} from '@mise/core/sync-read';
import {applicationHash,materializationHash,materializedRows,ReconciliationError,replayPendingIntent,restoreMaterialization,workingSnapshotHash,type CanonicalApplication,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {shopCommandFingerprint,syncCoverageLimit,type SyncCoverageIntent,type LocalSyncCoverage} from '@mise/core/sync-coverage';
import type {ShopCommand} from '@mise/core/shop-commands';
import type {MiseDatabase} from './db';
import {readDatabaseBackup} from './backup';
import {portableInboxItems,storedInboxItems,type StoredInboxItem} from './inbox';
import {assertJoinedCanonicalState,readJoinedCanonicalState,type JoinedCanonicalState} from './cloud-canonical-state';
import {assertSyncDownloadContext,readVerifiedSyncRecords} from './cloud-sync-journal';
import {readVerifiedSyncImages} from './cloud-sync-images';
import {downloadSyncCoverage,type SyncCoverageRemote} from './cloud-sync-coverage';
import {parseLocalOutboxEntry} from './local-outbox';
import {prepareCanonicalWrites,withCanonicalWrites} from './canonical-writes';

export interface ApplyCanonicalInput {readId:string;target:SyncDownloadTarget;expectedOperatorRevision:number;authKey:string}
export interface AppliedCanonical {readId:string;canonicalHash:string;applicationHash:string;covered:number;pending:number;sequence:number}
interface Source {binding:JoinedCanonicalState['binding'];operator:LocalOperatorState;queue:LocalOutboxEntry[];portable:LocalOutboxEntry[];working:MiseBackup;queueToken:string}
const fail=(kind:ConstructorParameters<typeof ReconciliationError>[0]='review')=>new ReconciliationError(kind);
function originalRows(rows:readonly LocalOutboxEntry[]){return rows.map(({status:_,receipts:__,...row})=>{void _;void __;return row;});}
async function portableQueue(rows:readonly LocalOutboxEntry[]):Promise<LocalOutboxEntry[]>{
 const result=structuredClone([...rows]);for(const group of result)for(const change of group.changes)if(change.table==='inboxItems')for(const key of ['before','after'] as const)if(change[key]!==null)change[key]=(await portableInboxItems([change[key] as StoredInboxItem]))[0];return result;
}
function selected(raw:unknown,input:ApplyCanonicalInput,scope:JoinedCanonicalState['base']['snapshot']['scope']):LocalOperatorState {
 const state=parseLocalOperatorState(raw),c=state.connection;
 if(state.phase!=='active'||state.revision!==input.expectedOperatorRevision||state.businessId!==input.target.businessId||state.outletId!==input.target.outletId||state.actorId!==input.target.actorId||state.role!==input.target.role||!c||c.authKey!==input.authKey||c.targetHash!==input.target.targetHash||c.accountHash!==input.target.accountHash||c.epoch!==scope.epoch||c.scopeVersion!==scope.scopeVersion)throw fail();return state;
}
async function source(db:MiseDatabase,installed:JoinedCanonicalState,input:ApplyCanonicalInput):Promise<Source>{
 return db.transaction('r',db.tables,async()=>{
  await assertJoinedCanonicalState(db,installed);const binding=parseLocalCloudState(await db.cloudState.get('binding')),operator=selected(await db.operatorState.get('active'),input,installed.base.snapshot.scope),queue=(await db.outbox.where('uploadId').equals(binding.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence);
  if(queue.length!==binding.sequence||queue.some((r,i)=>r.sequence!==i+1)||await db.outbox.count()!==queue.length)throw fail('integrity');const parsed=queue.map(r=>parseLocalOutboxEntry(r,binding));
  const portable=await Dexie.waitFor(portableQueue(parsed)),working=await readDatabaseBackup(db);return {binding,operator,queue,portable,working,queueToken:syncDownloadToken(portable)};
 });
}
/** Prove every local row is explained by the last materialization plus original
 * subsequent transactions. Neither original changes nor receipts are rewritten. */
async function assertWorkingCoverage(installed:JoinedCanonicalState,s:Source):Promise<void>{
 const previous=installed.application,through=previous?.throughSequence??0;
 if(previous&&await materializationHash(originalRows(s.portable.filter(r=>r.sequence<=through)))!==previous.queueHash)throw fail('integrity');
 let baseline=previous?restoreMaterialization(installed.base.snapshot.backup,previous.overlay):structuredClone(installed.base.snapshot.backup);
 if(!previous){
  const first=new Map<string,unknown>();for(const group of s.portable)for(const change of group.changes)if(change.table==='inboxItems'&&!first.has(change.key))first.set(change.key,change.before);
  const unassigned=[...first.values()].filter((row):row is MiseBackup['tables']['inboxItems'][number]=>!!row&&typeof row==='object'&&(row as {outletId?:unknown}).outletId===null);
  for(const row of s.working.tables.inboxItems)if(row.outletId===null&&!first.has(row.id))unassigned.push(row);
  baseline.tables.inboxItems.push(...structuredClone(unassigned));baseline=createBackup(baseline.tables,baseline.exportedAt);
 }
 const changes=s.portable.filter(r=>r.sequence>through).flatMap(group=>group.changes);
 // Original groups can update a row more than once. Validate each exact source
 // in order, then validate all relational/financial invariants together.
 const tables=structuredClone(baseline.tables);
 for(const change of changes){const rows=tables[change.table] as unknown as Record<string,unknown>[],at=rows.findIndex(r=>r.id===change.key);if(syncDownloadToken(at<0?null:rows[at])!==syncDownloadToken(change.before))throw fail('integrity');if(at>=0)rows.splice(at,1);if(change.after!==null)rows.push(structuredClone(change.after) as Record<string,unknown>);}
 if(backupToken(createBackup(tables,baseline.exportedAt))!==backupToken(s.working))throw fail('integrity');
}
function response(base:LocalCanonicalSnapshot,application:LocalCanonicalApplication):AppliedCanonical{return {readId:base.snapshot.readId,canonicalHash:base.hash,applicationHash:application.hash,covered:application.covered.length,pending:application.pending.length,sequence:application.throughSequence};}
async function fresh(scope:JoinedCanonicalState['base']['snapshot']['scope'],refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal){
 signal?.throwIfAborted();const context=parseOperatorContext(await refresh({...scope,version:1,businessName:null,outletName:null,actorName:null}));signal?.throwIfAborted();if(syncDownloadToken(parseSyncScope(context))!==syncDownloadToken(scope))throw fail();
}
/** Canonical install, pending intent projection and accepted cursor are one exact
 * native transaction. Unsupported/unknown work stays retained rather than lost.
 */
export async function applyCanonicalDownload(db:MiseDatabase,input:ApplyCanonicalInput,remote:SyncCoverageRemote,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal):Promise<AppliedCanonical>{
 input=structuredClone(input);const installed=await readJoinedCanonicalState(db),s=await source(db,installed,input);await assertWorkingCoverage(installed,s);
 if(installed.base.snapshot.readId===input.readId&&installed.application){await fresh(installed.base.snapshot.scope,refresh,signal);return db.transaction('r',db.tables,async()=>{await assertJoinedCanonicalState(db,installed);const latest=await source(db,installed,input);if(latest.queueToken!==s.queueToken||backupToken(latest.working)!==backupToken(s.working))throw fail();return response(installed.base,installed.application!);});}
 const verified=await readVerifiedSyncRecords(db,input.readId,input.target,signal),state=verified.context.state;if(state.source.previousCursor!==installed.base.snapshot.cursor||!state.window||syncDownloadToken(parseSyncScope(state.window))!==syncDownloadToken(installed.base.snapshot.scope))throw fail();
 if(s.portable.some(r=>r.status==='retained'))throw fail('retained');
 const commands=s.portable.flatMap(r=>r.commands),identities=new Map<string,SyncCoverageIntent>();for(const c of commands){if(identities.has(c.id))throw fail('integrity');identities.set(c.id,{id:c.id,type:c.type,requestHash:await shopCommandFingerprint(c)});}
 const covered=new Map<string,SyncCoverageIntent>();for(const c of installed.application?.covered??[]){if(syncDownloadToken(identities.get(c.id))!==syncDownloadToken(c))throw fail('integrity');covered.set(c.id,c);}
 const needed=commands.filter(c=>!covered.has(c.id)),proofs:LocalSyncCoverage[]=[],unknown=new Set<string>(),conflicts=new Set<string>();
 for(let at=0;at<needed.length;at+=syncCoverageLimit){const batch=needed.slice(at,at+syncCoverageLimit),result=await downloadSyncCoverage(db,state.id,input.target,batch,remote,signal);for(const id of result.visible)covered.set(id,identities.get(id)!);result.unknown.forEach(id=>unknown.add(id));result.conflicts.forEach(id=>conflicts.add(id));const ids=new Set(batch.map(c=>c.id));const saved=(await db.syncCoverage.where('readId').equals(state.id).toArray()).find(p=>p.source.intents.length===ids.size&&p.source.intents.every(c=>ids.has(c.id)));if(!saved?.resultHash)throw fail('integrity');proofs.push(saved);}
 if(unknown.size||conflicts.size)throw fail('retained');const images=await readVerifiedSyncImages(db,state.id,input.target,signal),snapshot=await reconstructCanonicalSnapshot(state,verified.records,images.images,installed.base.snapshot);let working=structuredClone(snapshot.backup);const pending:ShopCommand[]=[];
 for(const c of commands)if(!covered.has(c.id)){pending.push(c);working=replayPendingIntent(working,c,s.operator.actorId,state.window.createdAt);}
 for(const item of s.working.tables.inboxItems.filter(i=>i.outletId===null)){if(working.tables.inboxItems.some(i=>i.id===item.id))throw fail('retained');working.tables.inboxItems.push(structuredClone(item));}
 working=createBackup(working.tables,working.exportedAt);const baseHash=await canonicalSnapshotHash(snapshot),value:CanonicalApplication={id:state.id,version:1,previousApplicationHash:installed.application?.hash??null,previousBaseHash:installed.base.hash,readSourceHash:state.sourceHash,readSeal:state.seal!,cursor:state.receivedCursor!,baseHash,throughSequence:s.binding.sequence,queueHash:await materializationHash(originalRows(s.portable)),workingHash:await workingSnapshotHash(working),overlay:materializedRows(snapshot.backup,working),covered:[...covered.values()].sort((a,b)=>a.id.localeCompare(b.id)),pending:pending.map(c=>c.id),proofs:proofs.map(p=>({batchHash:p.batchHash,sourceHash:p.sourceHash,resultHash:p.resultHash!}))},application:LocalCanonicalApplication={...value,hash:await applicationHash(value)},base:LocalCanonicalSnapshot={id:'active',version:2,snapshot,hash:baseHash,applicationHash:application.hash};
 const stored=storedInboxItems(working.tables.inboxItems),oldStored=storedInboxItems(s.working.tables.inboxItems),changes:LocalRowChange[]=materializedRows(s.working,working).map(change=>change.table!=='inboxItems'?change:{...change,before:oldStored.find(i=>i.id===change.key)??null,after:stored.find(i=>i.id===change.key)??null});
 // Release every changed existing key before inserting replacements. This also
 // handles unique revision/ledger/order indexes whose slots change owners.
 const operations:LocalRowChange[]=[...changes.filter(c=>c.before!==null).map(c=>({...c,after:null})),...changes.filter(c=>c.after!==null).map(c=>({...c,before:null}))],writePlan=await prepareCanonicalWrites(operations,s.binding);
 const pages=await db.syncPages.where('readId').equals(state.id).sortBy('index');await fresh(snapshot.scope,refresh,signal);
 return db.transaction('rw',db.tables,()=>withCanonicalWrites(db,writePlan,async()=>{
  signal?.throwIfAborted();await assertJoinedCanonicalState(db,installed);const latest=await source(db,installed,input);if(syncDownloadToken(latest.binding)!==syncDownloadToken(s.binding)||latest.queueToken!==s.queueToken||backupToken(latest.working)!==backupToken(s.working))throw fail();
  if(syncDownloadToken(await assertSyncDownloadContext(db,verified.context))!==syncDownloadToken(state)||syncDownloadToken(await db.syncRecords.where('readId').equals(state.id).sortBy('changeId'))!==syncDownloadToken([...verified.records].sort((a,b)=>a.changeId.localeCompare(b.changeId)))||syncDownloadToken(await db.syncPages.where('readId').equals(state.id).sortBy('index'))!==syncDownloadToken(pages))throw fail('integrity');
  for(const proof of proofs)if(syncDownloadToken(await db.syncCoverage.get([state.id,proof.batchHash]))!==syncDownloadToken(proof))throw fail('integrity');
  for(const change of operations)if(change.after===null)await db.table(change.table).delete(change.key);else await db.table(change.table).put(change.after);
  if(installed.admission.id==='active')await db.syncCanonical.add({...installed.admission,id:`join:${installed.admission.snapshot.readId}`,version:1});
  await db.syncApplications.add(application);await db.syncCanonical.put(base);await db.operatorState.put(s.operator);await db.cloudState.put(s.binding);
  if(backupToken(await readDatabaseBackup(db))!==backupToken(working)||await db.outbox.count()!==s.queue.length||syncDownloadToken(await db.outbox.where('uploadId').equals(s.binding.uploadId).sortBy('sequence'))!==syncDownloadToken(s.queue)||syncDownloadToken(await db.cloudState.get('binding'))!==syncDownloadToken(s.binding)||syncDownloadToken(await db.operatorState.get('active'))!==syncDownloadToken(s.operator)||syncDownloadToken(await db.syncCanonical.get('active'))!==syncDownloadToken(base)||syncDownloadToken(await db.syncApplications.get(state.id))!==syncDownloadToken(application))throw fail('integrity');
  signal?.throwIfAborted();return response(base,application);
 }));
}
