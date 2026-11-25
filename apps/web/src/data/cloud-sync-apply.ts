import Dexie from 'dexie';
import {backupToken,createBackup} from '@mise/core/backup';
import type {MiseBackup} from '@mise/core/backup-tables';
import {parseLocalCloudState,type LocalCloudState,type LocalOutboxEntry,type LocalRowChange} from '@mise/core/local-outbox';
import {cloudUploadManifestHash,readCloudUpload,type CloudUploadPlan} from '@mise/core/cloud-upload';
import {parseLocalOperatorState,parseOperatorContext,type LocalOperatorState,type OperatorContext} from '@mise/core/operators';
import {canonicalSnapshotHash,reconstructCanonicalSnapshot,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {syncDownloadToken,type SyncDownloadTarget} from '@mise/core/sync-download';
import {parseSyncScope,type SyncScope} from '@mise/core/sync-read';
import {parseSyncUploadCoverageSource,assertVisibleUploadCoverage,ownerUploadAdmissionHash,type SyncUploadCoverageSource,type SyncUploadCoveragePage,type LocalOwnerUploadAdmission} from '@mise/core/sync-upload-admission';
import {applicationHash,materializationHash,materializedRows,ReconciliationError,replayPendingIntent,restoreMaterialization,workingSnapshotHash,type CanonicalApplication,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {shopCommandFingerprint,syncCoverageLimit,type SyncCoverageIntent,type LocalSyncCoverage} from '@mise/core/sync-coverage';
import type {ShopCommand} from '@mise/core/shop-commands';
import type {MiseDatabase} from './db';
import {readDatabaseBackup} from './backup';
import {portableInboxItems,storedInboxItems,type StoredInboxItem} from './inbox';
import {assertCanonicalState,readCanonicalState,type CanonicalState} from './cloud-canonical-state';
import {assertSyncDownloadContext,readVerifiedSyncRecords} from './cloud-sync-journal';
import {readVerifiedSyncImages} from './cloud-sync-images';
import {downloadSyncCoverage,type SyncCoverageRemote} from './cloud-sync-coverage';
import {parseLocalOutboxEntry,assertLocalUploadCoverage} from './local-outbox';
import {prepareCanonicalWrites,withCanonicalWrites,assertCanonicalTransaction,type CanonicalRowChange} from './canonical-writes';
import {isLocalInboxRetention} from '@mise/core/local-inbox';
import {originalCurrencyReader} from '@mise/core/pending-currency';
import {originalClosingParentReader} from '@mise/core/closing-source';
import {assertResolutionSources,assertCanonicalResolutions} from './command-resolution';
import {stockReviewBoundary} from '@mise/core/stock-review-boundary';
import {customerReviewBoundary} from '@mise/core/customer-review-boundary';
import {closingReviewBoundary} from '@mise/core/closing-review-boundary';

export interface ApplyCanonicalInput {readId:string;target:SyncDownloadTarget;expectedOperatorRevision:number;authKey:string}
export interface AppliedCanonical {readId:string;canonicalHash:string;applicationHash:string;covered:number;pending:number;sequence:number}
export interface Source {binding:LocalCloudState;operator:LocalOperatorState;queue:LocalOutboxEntry[];portable:LocalOutboxEntry[];working:MiseBackup;queueToken:string}
interface OwnerBootstrap {binding:LocalCloudState;original:MiseBackup;plan:CloudUploadPlan;source:SyncUploadCoverageSource;proof:SyncUploadCoveragePage}
type Origin={installed:CanonicalState;owner?:never}|{installed:null;owner:OwnerBootstrap};
export interface OwnerUploadCoverageRemote {get(source:SyncUploadCoverageSource,signal?:AbortSignal):Promise<SyncUploadCoveragePage>}
const originScope=(origin:Origin):SyncScope=>origin.installed?.base.snapshot.scope??parseSyncScope(origin.owner!.source.window);
const fail=(kind:ConstructorParameters<typeof ReconciliationError>[0]='review')=>new ReconciliationError(kind);
function active(signal?:AbortSignal,guard?:()=>void){signal?.throwIfAborted();if(guard){const result:unknown=guard();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw fail('integrity');}}}
function originalRows(rows:readonly LocalOutboxEntry[]){return rows.map(({status:_,receipts:__,...row})=>{void _;void __;return row;});}
async function portableQueue(rows:readonly LocalOutboxEntry[]):Promise<LocalOutboxEntry[]>{
 for(const row of rows)if(row.receipts.some(receipt=>receipt.type==='command.resolved'))await assertResolutionSources(row);
 const result=structuredClone([...rows]);for(const group of result)for(const change of group.changes)if(change.table==='inboxItems')for(const key of ['before','after'] as const)if(change[key]!==null)change[key]=(await portableInboxItems([change[key] as StoredInboxItem]))[0];return result;
}
function selected(raw:unknown,input:ApplyCanonicalInput,scope:SyncScope):LocalOperatorState {
 const state=parseLocalOperatorState(raw),c=state.connection;
 if(state.phase!=='active'||state.revision!==input.expectedOperatorRevision||state.businessId!==input.target.businessId||state.outletId!==input.target.outletId||state.actorId!==input.target.actorId||state.role!==input.target.role||!c||c.authKey!==input.authKey||c.targetHash!==input.target.targetHash||c.accountHash!==input.target.accountHash||c.epoch!==scope.epoch||c.scopeVersion!==scope.scopeVersion)throw fail();return state;
}
function assertUnadoptedOwner(db:MiseDatabase,binding:LocalCloudState){return db.cloudState.get('binding').then(raw=>{const current=parseLocalCloudState(raw);if(current.version!==1||current.phase!=='ready'||syncDownloadToken({...current,sequence:0})!==syncDownloadToken({...binding,sequence:0}))throw fail('integrity');return Dexie.Promise.all([db.syncCanonical.count(),db.syncApplications.count(),db.syncAdmissions.count()]);}).then(counts=>{if(counts.some(Boolean))throw fail('integrity');});}
function assertOrigin(db:MiseDatabase,origin:Origin){return origin.installed?assertCanonicalState(db,origin.installed):assertUnadoptedOwner(db,origin.owner.binding);}
function source(db:MiseDatabase,origin:Origin,input:ApplyCanonicalInput):Promise<Source>{
 return db.transaction('r',db.tables,async()=>{
  await assertOrigin(db,origin);const binding=parseLocalCloudState(await db.cloudState.get('binding')),operator=selected(await db.operatorState.get('active'),input,originScope(origin)),queue=(await db.outbox.where('uploadId').equals(binding.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence);
  if(queue.length!==binding.sequence||queue.some((r,i)=>r.sequence!==i+1)||await db.outbox.count()!==queue.length)throw fail('integrity');const parsed=queue.map(r=>parseLocalOutboxEntry(r,binding));
  const portable=await Dexie.waitFor(portableQueue(parsed)),working=await readDatabaseBackup(db);if(working.tables.payments.length||await db.paymentOriginalBases.count()||await db.nativePaymentActions.count())throw fail('retained');return {binding,operator,queue,portable,working,queueToken:syncDownloadToken(portable)};
 });
}
/** Prove every local row is explained by the last materialization plus original
 * subsequent transactions. Neither original changes nor receipts are rewritten. */
async function assertWorkingCoverage(origin:Origin,s:Source):Promise<void>{
 const previous=origin.installed?.application,through=previous?.throughSequence??0,original=origin.installed?.base.snapshot.backup??origin.owner!.original;
 if(previous&&await materializationHash(originalRows(s.portable.filter(r=>r.sequence<=through)))!==previous.queueHash)throw fail('integrity');
 let baseline=previous?restoreMaterialization(original,previous.overlay):structuredClone(original);
 if(!previous){
  const first=new Map<string,unknown>();for(const group of s.portable)for(const change of group.changes)if(change.table==='inboxItems'&&!first.has(change.key))first.set(change.key,change.before);
  const unassigned=[...first.values()].filter((row):row is MiseBackup['tables']['inboxItems'][number]=>!!row&&typeof row==='object'&&(row as {outletId?:unknown}).outletId===null);
  for(const row of s.working.tables.inboxItems)if(row.outletId===null&&!first.has(row.id))unassigned.push(row);
  for(const item of unassigned){const existing=baseline.tables.inboxItems.find(i=>i.id===item.id);if(existing&&syncDownloadToken(existing)!==syncDownloadToken(item))throw fail('integrity');if(!existing)baseline.tables.inboxItems.push(structuredClone(item));}baseline=createBackup(baseline.tables,baseline.exportedAt);
 }
 const changes=s.portable.filter(r=>r.sequence>through).flatMap(group=>group.changes);
 // Original groups can update a row more than once. Validate each exact source
 // in order, then validate all relational/financial invariants together.
 const tables=structuredClone(baseline.tables);
 for(const change of changes){const rows=tables[change.table] as unknown as Record<string,unknown>[],at=rows.findIndex(r=>r.id===change.key);if(syncDownloadToken(at<0?null:rows[at])!==syncDownloadToken(change.before))throw fail('integrity');if(at>=0)rows.splice(at,1);if(change.after!==null)rows.push(structuredClone(change.after) as Record<string,unknown>);}
 if(backupToken(createBackup(tables,baseline.exportedAt))!==backupToken(s.working))throw fail('integrity');
}
function response(base:LocalCanonicalSnapshot,application:LocalCanonicalApplication):AppliedCanonical{return {readId:base.snapshot.readId,canonicalHash:base.hash,applicationHash:application.hash,covered:application.covered.length,pending:application.pending.length,sequence:application.throughSequence};}
/** Scope recovery reads original work without activating a cached or newly selected role. */
export async function readRecoveryWorkingSource(db:MiseDatabase,installed:CanonicalState,expectedRevision:number):Promise<Source>{
 return db.transaction('r',db.tables,async()=>{
  await assertCanonicalState(db,installed);
  const binding=parseLocalCloudState(await db.cloudState.get('binding')),operator=parseLocalOperatorState(await db.operatorState.get('active')),scope=installed.base.snapshot.scope,c=operator.connection;
  if(operator.revision!==expectedRevision||operator.businessId!==scope.businessId||operator.outletId!==scope.outletId||operator.actorId!==scope.actorId||c?.accountHash!==scope.accountHash||c.targetHash!==binding.targetHash)throw fail();
  const queue=(await db.outbox.where('uploadId').equals(binding.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence);
  if(queue.length!==binding.sequence||queue.some((row,i)=>row.sequence!==i+1)||await db.outbox.count()!==queue.length)throw fail('integrity');
  const parsed=queue.map(row=>parseLocalOutboxEntry(row,binding)),portable=await Dexie.waitFor(portableQueue(parsed)),working=await readDatabaseBackup(db);if(working.tables.payments.length||await db.paymentOriginalBases.count()||await db.nativePaymentActions.count())throw fail('retained');
  return {binding,operator,queue,portable,working,queueToken:syncDownloadToken(portable)};
 });
}
export function assertRecoveryWorkingCoverage(installed:CanonicalState,source:Source){return assertWorkingCoverage({installed},source);}
async function fresh(scope:SyncScope,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal){
 signal?.throwIfAborted();const context=parseOperatorContext(await refresh({...scope,version:1,businessName:null,outletName:null,actorName:null}));signal?.throwIfAborted();if(syncDownloadToken(parseSyncScope(context))!==syncDownloadToken(scope))throw fail();
}
/** Canonical install, pending intent projection and accepted cursor are one exact
 * native transaction. Unsupported/unknown work stays retained rather than lost.
 */
export async function applyCanonicalDownload(db:MiseDatabase,input:ApplyCanonicalInput,remote:SyncCoverageRemote,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal,assertActive?:()=>void):Promise<AppliedCanonical>{
 return applyCanonicalFrom(db,structuredClone(input),{installed:await readCanonicalState(db)},remote,refresh,signal,assertActive);
}
async function applyCanonicalFrom(db:MiseDatabase,input:ApplyCanonicalInput,origin:Origin,remote:SyncCoverageRemote,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal,assertActive?:()=>void):Promise<AppliedCanonical>{
 input=structuredClone(input);const installed=origin.installed,previousBase=installed?.base??null,previous=installed?.application??null,s=await source(db,origin,input);await assertWorkingCoverage(origin,s);
 if(previousBase?.snapshot.readId===input.readId&&previous){assertCanonicalResolutions(s.portable,previousBase.snapshot.backup.tables.events,new Set(previous.covered.map(c=>c.id)));await fresh(originScope(origin),refresh,signal);return db.transaction('r',db.tables,async()=>{await assertOrigin(db,origin);const latest=await source(db,origin,input);if(latest.queueToken!==s.queueToken||backupToken(latest.working)!==backupToken(s.working))throw fail();active(signal,assertActive);return response(previousBase,previous);});}
 const verified=await readVerifiedSyncRecords(db,input.readId,input.target,signal),state=verified.context.state;if(state.source.previousCursor!==(previousBase?.snapshot.cursor??null)||!state.window||syncDownloadToken(parseSyncScope(state.window))!==syncDownloadToken(originScope(origin)))throw fail();
 if(origin.owner&&(state.sourceHash!==origin.owner.source.readSourceHash||state.seal!==origin.owner.source.readSeal||state.receivedCursor!==origin.owner.source.cursor))throw fail('integrity');
 if(s.portable.some(r=>r.status==='retained'&&!isLocalInboxRetention(r)))throw fail('retained');
 const commands=s.portable.flatMap(r=>r.commands),identities=new Map<string,SyncCoverageIntent>();for(const c of commands){if(identities.has(c.id))throw fail('integrity');identities.set(c.id,{id:c.id,type:c.type,requestHash:await shopCommandFingerprint(c)});}
 const covered=new Map<string,SyncCoverageIntent>();for(const c of previous?.covered??[]){if(syncDownloadToken(identities.get(c.id))!==syncDownloadToken(c))throw fail('integrity');covered.set(c.id,c);}
 const needed=commands.filter(c=>!covered.has(c.id)),proofs:LocalSyncCoverage[]=[],unknown=new Set<string>(),conflicts=new Set<string>();
 for(let at=0;at<needed.length;at+=syncCoverageLimit){const batch=needed.slice(at,at+syncCoverageLimit),result=await downloadSyncCoverage(db,state.id,input.target,batch,remote,signal);for(const id of result.visible)covered.set(id,identities.get(id)!);result.unknown.forEach(id=>unknown.add(id));result.conflicts.forEach(id=>conflicts.add(id));const ids=new Set(batch.map(c=>c.id));const saved=(await db.syncCoverage.where('readId').equals(state.id).toArray()).find(p=>p.source.intents.length===ids.size&&p.source.intents.every(c=>ids.has(c.id)));if(!saved?.resultHash)throw fail('integrity');proofs.push(saved);}
 if(unknown.size||conflicts.size)throw fail('retained');const images=await readVerifiedSyncImages(db,state.id,input.target,signal),snapshot=await reconstructCanonicalSnapshot(state,verified.records,images.images,previousBase?.snapshot??null);assertCanonicalResolutions(s.portable,snapshot.backup.tables.events,new Set(covered.keys()));let working=structuredClone(snapshot.backup);const pending:ShopCommand[]=[];
 const originalTimes=new Map(s.portable.flatMap(row=>row.commands.map(command=>[command.id,row.at] as const)));
 const currencyFor=originalCurrencyReader(s.portable),parentFor=originalClosingParentReader(s.portable),stockBoundary=await stockReviewBoundary(snapshot.backup.tables.events,input.target.outletId),customerBoundary=await customerReviewBoundary(snapshot.backup.tables.events,input.target.outletId),closingBoundary=await closingReviewBoundary(snapshot.backup.tables.events,input.target.outletId);
 for(const c of commands)if(!covered.has(c.id)){pending.push(c);let currency:string|undefined,parent:string|null;try{currency=currencyFor(c);parent=parentFor(c);}catch{throw new ReconciliationError('integrity',c.id);}working=await replayPendingIntent(working,c,s.operator.actorId,state.window.createdAt,s.working,originalTimes.get(c.id),currency,stockBoundary,customerBoundary,parent,closingBoundary);}
 for(const item of s.working.tables.inboxItems.filter(i=>i.outletId===null)){if(working.tables.inboxItems.some(i=>i.id===item.id))throw fail('retained');working.tables.inboxItems.push(structuredClone(item));}
 working=createBackup(working.tables,working.exportedAt);const baseHash=await canonicalSnapshotHash(snapshot),value:CanonicalApplication={id:state.id,version:1,previousApplicationHash:previous?.hash??null,previousBaseHash:previousBase?.hash??null,readSourceHash:state.sourceHash,readSeal:state.seal!,cursor:state.receivedCursor!,baseHash,throughSequence:s.binding.sequence,queueHash:await materializationHash(originalRows(s.portable)),workingHash:await workingSnapshotHash(working),overlay:materializedRows(snapshot.backup,working),covered:[...covered.values()].sort((a,b)=>a.id.localeCompare(b.id)),pending:pending.map(c=>c.id),proofs:proofs.map(p=>({batchHash:p.batchHash,sourceHash:p.sourceHash,resultHash:p.resultHash!})),...(previous?.recoveryId?{recoveryId:previous.recoveryId}:{})},application:LocalCanonicalApplication={...value,hash:await applicationHash(value)},base:LocalCanonicalSnapshot={id:'active',version:2,snapshot,hash:baseHash,applicationHash:application.hash};
 const uploadValue=origin.owner?{id:'owner-upload' as const,version:1 as const,plan:origin.owner.plan,source:origin.owner.source,proof:origin.owner.proof,initialBaseHash:baseHash}:null,uploadAdmission:LocalOwnerUploadAdmission|null=uploadValue?{...uploadValue,hash:await ownerUploadAdmissionHash(uploadValue)}:null;
 const stored=storedInboxItems(working.tables.inboxItems),oldStored=storedInboxItems(s.working.tables.inboxItems),changes:LocalRowChange[]=materializedRows(s.working,working).map(change=>change.table!=='inboxItems'?change:{...change,before:oldStored.find(i=>i.id===change.key)??null,after:stored.find(i=>i.id===change.key)??null});
 // Release every changed existing key before inserting replacements. This also
 // handles unique revision/ledger/order indexes whose slots change owners.
 const operations:LocalRowChange[]=[...changes.filter(c=>c.before!==null).map(c=>({...c,after:null})),...changes.filter(c=>c.after!==null).map(c=>({...c,before:null}))];
 const admissionCopy:LocalCanonicalSnapshot|null=uploadAdmission?{id:`upload:${s.binding.uploadId}`,version:1,snapshot,hash:baseHash}:installed?.admission.id==='active'?{...installed.admission,id:`join:${installed.admission.snapshot.readId}`,version:1}:null;
 const controls:CanonicalRowChange[]=[{table:'syncCanonical',key:'active',before:previousBase,after:base},{table:'syncApplications',key:state.id,before:null,after:application},{table:'operatorState',key:'active',before:s.operator,after:s.operator},{table:'cloudState',key:'binding',before:s.binding,after:s.binding}];if(admissionCopy)controls.push({table:'syncCanonical',key:admissionCopy.id,before:null,after:admissionCopy});if(uploadAdmission)controls.push({table:'syncAdmissions',key:'owner-upload',before:null,after:uploadAdmission});
 const writePlan=await prepareCanonicalWrites([...operations,...controls],s.binding);
 const pages=await db.syncPages.where('readId').equals(state.id).sortBy('index');await fresh(snapshot.scope,refresh,signal);
 return db.transaction('rw',db.tables,()=>withCanonicalWrites(db,writePlan,async()=>{
  if(await db.paymentOriginalBases.count()||await db.nativePaymentActions.count())throw fail('retained');
  active(signal,assertActive);await assertOrigin(db,origin);assertCanonicalTransaction(db,writePlan,'origin');const latest=await source(db,origin,input);assertCanonicalTransaction(db,writePlan,'source');if(syncDownloadToken(latest.binding)!==syncDownloadToken(s.binding)||latest.queueToken!==s.queueToken||backupToken(latest.working)!==backupToken(s.working))throw fail();
  if(syncDownloadToken(await Dexie.waitFor(assertSyncDownloadContext(db,verified.context)))!==syncDownloadToken(state)||syncDownloadToken(await db.syncRecords.where('readId').equals(state.id).sortBy('changeId'))!==syncDownloadToken([...verified.records].sort((a,b)=>a.changeId.localeCompare(b.changeId)))||syncDownloadToken(await db.syncPages.where('readId').equals(state.id).sortBy('index'))!==syncDownloadToken(pages))throw fail('integrity');
  assertCanonicalTransaction(db,writePlan,'download');
  for(const proof of proofs)if(syncDownloadToken(await db.syncCoverage.get([state.id,proof.batchHash]))!==syncDownloadToken(proof))throw fail('integrity');
  for(const change of operations){active(signal,assertActive);assertCanonicalTransaction(db,writePlan);if(change.after===null)await db.table(change.table).delete(change.key);else await db.table(change.table).put(change.after);}
  assertCanonicalTransaction(db,writePlan);
  if(admissionCopy)await db.syncCanonical.add(admissionCopy);
  if(uploadAdmission)await db.syncAdmissions.add(uploadAdmission);
  await db.syncApplications.add(application);await db.syncCanonical.put(base);await db.operatorState.put(s.operator);await db.cloudState.put(s.binding);
  const checks={working:backupToken(await readDatabaseBackup(db))===backupToken(working),queueCount:await db.outbox.count()===s.queue.length,queue:syncDownloadToken(await db.outbox.where('uploadId').equals(s.binding.uploadId).sortBy('sequence'))===syncDownloadToken(s.queue),binding:syncDownloadToken(await db.cloudState.get('binding'))===syncDownloadToken(s.binding),operator:syncDownloadToken(await db.operatorState.get('active'))===syncDownloadToken(s.operator),base:syncDownloadToken(await db.syncCanonical.get('active'))===syncDownloadToken(base),application:syncDownloadToken(await db.syncApplications.get(state.id))===syncDownloadToken(application)};
  if(Object.values(checks).some(ok=>!ok))throw Object.assign(fail('integrity'),{cause:Object.keys(checks).filter(key=>!checks[key as keyof typeof checks])});
  active(signal,assertActive);return response(base,application);
 }));
}
/** The original owner upload is adopted only after its real promotion is visible
 * in this complete bootstrap. Neither its fence nor accepted receipt is replaced.
 */
export async function adoptOwnerUpload(db:MiseDatabase,input:ApplyCanonicalInput,plan:CloudUploadPlan,uploadRemote:OwnerUploadCoverageRemote,remote:SyncCoverageRemote,refresh:(context:OperatorContext)=>Promise<OperatorContext>,signal?:AbortSignal,assertActive?:()=>void):Promise<AppliedCanonical>{
 input=structuredClone(input);plan=structuredClone(plan);signal?.throwIfAborted();const original=await readCloudUpload(plan),manifestHash=await cloudUploadManifestHash(plan.manifest),binding=parseLocalCloudState(await db.cloudState.get('binding'));
 if(binding.version!==1||binding.phase!=='ready'||!binding.receipt||binding.uploadId!==plan.manifest.id||binding.manifestHash!==manifestHash||binding.targetHash!==input.target.targetHash||binding.businessId!==input.target.businessId||binding.outletId!==input.target.outletId||binding.ownerId!==input.target.actorId||input.target.role!=='owner')throw fail();
 if(await db.syncCanonical.get('active')){
  const installed=await readCanonicalState(db),origin:Origin={installed},s=await source(db,origin,input),upload=installed.upload;if(!upload||upload.source.readId!==input.readId||syncDownloadToken(upload.plan.manifest)!==syncDownloadToken(plan.manifest)||syncDownloadToken(upload.source.target)!==syncDownloadToken(input.target))throw fail('integrity');await assertWorkingCoverage(origin,s);
  const first=await db.syncApplications.get(input.readId);if(!first||first.previousBaseHash!==null||first.previousApplicationHash!==null||first.baseHash!==installed.admission.hash||first.readSourceHash!==upload.source.readSourceHash||first.readSeal!==upload.source.readSeal||first.cursor!==upload.source.cursor)throw fail('integrity');const {hash,...value}=first;if(await applicationHash(value)!==hash||await workingSnapshotHash(restoreMaterialization(installed.admission.snapshot.backup,first.overlay))!==first.workingHash)throw fail('integrity');
  await fresh(originScope(origin),refresh,signal);return db.transaction('r',db.tables,async()=>{await assertOrigin(db,origin);const latest=await source(db,origin,input);if(latest.queueToken!==s.queueToken||backupToken(latest.working)!==backupToken(s.working)||syncDownloadToken(await db.syncApplications.get(input.readId))!==syncDownloadToken(first))throw fail();active(signal,assertActive);return response(installed.admission,first);});
 }
 await db.transaction('r',db.tables,async()=>assertUnadoptedOwner(db,binding));await assertLocalUploadCoverage(db,plan,input.target.targetHash);
 const {context}=await readVerifiedSyncRecords(db,input.readId,input.target,signal),state=context.state;if(state.source.previousCursor!==null||!state.window||!state.seal||!state.receivedCursor)throw fail();selected(await db.operatorState.get('active'),input,parseSyncScope(state.window));
 const uploadSource=await parseSyncUploadCoverageSource({version:1,readId:state.id,readSourceHash:state.sourceHash,readSeal:state.seal,target:input.target,window:state.window,cursor:state.receivedCursor,manifest:plan.manifest,manifestHash,receipt:binding.receipt}),proof=assertVisibleUploadCoverage(uploadSource,await uploadRemote.get(structuredClone(uploadSource),signal));signal?.throwIfAborted();
 return applyCanonicalFrom(db,input,{installed:null,owner:{binding,original,plan,source:uploadSource,proof}},remote,refresh,signal,assertActive);
}
