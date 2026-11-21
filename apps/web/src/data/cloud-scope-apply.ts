import Dexie from 'dexie';
import {backupToken,createBackup} from '@mise/core/backup';
import {backupTableNames,type MiseBackup} from '@mise/core/backup-tables';
import {originalCloudAdmission,type LocalCloudState,type LocalRowChange} from '@mise/core/local-outbox';
import {parseOperatorContext,type OperatorContext,type LocalOperatorState} from '@mise/core/operators';
import {reconstructCanonicalSnapshot,canonicalSnapshotHash,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {applicationHash,materializationHash,materializedRows,replayPendingIntent,workingSnapshotHash,type CanonicalApplication,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {parseSyncScope} from '@mise/core/sync-read';
import {syncDownloadToken} from '@mise/core/sync-download';
import {shopCommandFingerprint,syncCoverageLimit,type SyncCoverageIntent,type LocalSyncCoverage} from '@mise/core/sync-coverage';
import {parseScopeRecoverySession,scopeRecoveryHash,sameRecoveryIdentity,ScopeRecoveryError,type ScopeRecoverySession,type ScopeRecoveryAdmission} from '@mise/core/scope-recovery';
import {readCanonicalState,assertCanonicalState,type CanonicalState} from './cloud-canonical-state';
import {readRecoveryWorkingSource,assertRecoveryWorkingCoverage,type Source} from './cloud-sync-apply';
import {assertCanonicalResolutions} from './command-resolution';
import {stockReviewBoundary} from '@mise/core/stock-review-boundary';
import {readVerifiedSyncRecords,assertSyncDownloadContext} from './cloud-sync-journal';
import {readVerifiedSyncImages} from './cloud-sync-images';
import {downloadSyncCoverage,type SyncCoverageRemote} from './cloud-sync-coverage';
import {nativeRowHash,prepareCanonicalWrites,withCanonicalWrites,assertCanonicalTransaction,type CanonicalRowChange} from './canonical-writes';
import {storedInboxItems} from './inbox';
import {readDatabaseBackup} from './backup';
import type {MiseDatabase} from './db';
import {isLocalInboxRetention} from '@mise/core/local-inbox';
import {originalCurrencyReader} from '@mise/core/pending-currency';

export interface ScopeRecoveryReview {
 operationId:string;readId:string;before:Record<string,number>;after:Record<string,number>;pending:number;covered:number;
}
export interface ScopeRecoveryAccess {refresh:(context:OperatorContext)=>Promise<OperatorContext>;assertActive:()=>void;signal?:AbortSignal}
interface Plan {
 session:ScopeRecoverySession;origin:CanonicalState;source:Source;verified:Awaited<ReturnType<typeof readVerifiedSyncRecords>>;
 working:MiseBackup;application:LocalCanonicalApplication;base:LocalCanonicalSnapshot;admission:ScopeRecoveryAdmission;
 binding:LocalCloudState;operator:LocalOperatorState;proofs:LocalSyncCoverage[];pagesToken:string;imagesToken:string;
}
const plans=new WeakMap<ScopeRecoveryReview,Plan>();
const equal=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const originalRows=(rows:Source['portable'])=>rows.map(({status:_,receipts:__,...row})=>{void _;void __;return row;});
function active(access:ScopeRecoveryAccess){access.signal?.throwIfAborted();const result:unknown=access.assertActive();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new ScopeRecoveryError('integrity');}}
function context(session:ScopeRecoverySession):OperatorContext{return parseOperatorContext({...parseSyncScope({...session.target,epoch:session.epoch,scopeVersion:session.scopeVersion}),version:1,businessName:null,outletName:null,actorName:null});}
async function fresh(session:ScopeRecoverySession,access:ScopeRecoveryAccess){active(access);const result=parseOperatorContext(await access.refresh(context(session)));active(access);if(!equal(parseSyncScope(result),parseSyncScope(context(session))))throw new ScopeRecoveryError();}
async function originalSession(db:MiseDatabase,session:ScopeRecoverySession){if(!equal(await db.scopeRecoveries.get('active'),session))throw new ScopeRecoveryError();}
const counts=(backup:MiseBackup)=>Object.fromEntries(backupTableNames.map(table=>[table,backup.tables[table].length]));

/** A review carries no credentials or permission. Its detached source remains private
 * to this module and is rechecked under native locks before any domain write. */
export async function prepareScopeRecoveryReview(db:MiseDatabase,value:ScopeRecoverySession,remote:SyncCoverageRemote,access:ScopeRecoveryAccess):Promise<ScopeRecoveryReview>{
 const session=parseScopeRecoverySession(structuredClone(value));if(session.id!=='active'||session.phase!=='pending')throw new ScopeRecoveryError();
 active(access);await originalSession(db,session);const origin=await readCanonicalState(db),source=await readRecoveryWorkingSource(db,origin,session.expectedOperatorRevision);
 if(origin.base.hash!==session.originalBaseHash||!equal(origin.base.snapshot.scope,session.originalScope)||await nativeRowHash({...source.binding,sequence:0})!==session.originalBindingHash||source.operator.connection?.authKey!==session.authKey)throw new ScopeRecoveryError();
 await assertRecoveryWorkingCoverage(origin,source);if(source.portable.some(row=>row.status==='retained'&&!isLocalInboxRetention(row)))throw new ScopeRecoveryError();
 const verified=await readVerifiedSyncRecords(db,session.readId,session.target,access.signal),state=verified.context.state;
 if(state.source.previousCursor!==null||!state.window||!state.seal||!state.receivedCursor||!sameRecoveryIdentity(session.originalScope,parseSyncScope(state.window))||!equal(parseSyncScope(state.window),parseSyncScope(context(session))))throw new ScopeRecoveryError('integrity');
 await fresh(session,access);
 const commands=source.portable.flatMap(row=>row.commands),identities=new Map<string,SyncCoverageIntent>();
 for(const command of commands){if(identities.has(command.id))throw new ScopeRecoveryError('integrity');identities.set(command.id,{id:command.id,type:command.type,requestHash:await shopCommandFingerprint(command)});}
 const committed=new Set(source.portable.flatMap(row=>row.receipts.map((_,i)=>row.commands[i].id)));
 for(const old of origin.application?.covered??[]){if(!equal(identities.get(old.id),old))throw new ScopeRecoveryError('integrity');committed.add(old.id);}
 // Scope changes never carry old coverage forward. Recheck every original intent.
 const covered=new Map<string,SyncCoverageIntent>(),proofs:LocalSyncCoverage[]=[];
 for(let at=0;at<commands.length;at+=syncCoverageLimit){
  active(access);const batch=commands.slice(at,at+syncCoverageLimit),result=await downloadSyncCoverage(db,state.id,session.target,batch,remote,access.signal);
  if(result.unknown.length||result.conflicts.length)throw new ScopeRecoveryError();
  result.visible.forEach(id=>covered.set(id,identities.get(id)!));const ids=new Set(batch.map(c=>c.id));
  const saved=(await db.syncCoverage.where('readId').equals(state.id).toArray()).find(p=>p.source.intents.length===ids.size&&p.source.intents.every(c=>ids.has(c.id)));
  if(!saved?.result||!saved.resultHash)throw new ScopeRecoveryError('integrity');proofs.push(saved);
 }
 for(const id of committed)if(!covered.has(id))throw new ScopeRecoveryError();
 const images=await readVerifiedSyncImages(db,state.id,session.target,access.signal),snapshot=await reconstructCanonicalSnapshot(state,verified.records,images.images,null);
 assertCanonicalResolutions(source.portable,snapshot.backup.tables.events,new Set(covered.keys()));
 let working=structuredClone(snapshot.backup);const times=new Map(source.portable.flatMap(row=>row.commands.map(c=>[c.id,row.at] as const))),pending=commands.filter(c=>!covered.has(c.id));
 const currencyFor=originalCurrencyReader(source.portable),stockBoundary=await stockReviewBoundary(snapshot.backup.tables.events,session.target.outletId);
 for(const command of pending){active(access);let currency:string|undefined;try{currency=currencyFor(command);}catch{throw new ScopeRecoveryError('integrity');}working=await replayPendingIntent(working,command,source.operator.actorId,state.window.createdAt,source.working,times.get(command.id),currency,stockBoundary);}
 for(const item of source.working.tables.inboxItems.filter(row=>row.outletId===null)){if(working.tables.inboxItems.some(row=>row.id===item.id))throw new ScopeRecoveryError();working.tables.inboxItems.push(structuredClone(item));}
 working=createBackup(working.tables,working.exportedAt);
 const canonicalHash=await canonicalSnapshotHash(snapshot),queueHash=await materializationHash(originalRows(source.portable)),valueApp:CanonicalApplication={id:state.id,version:1,previousApplicationHash:origin.application?.hash??null,previousBaseHash:origin.base.hash,readSourceHash:state.sourceHash,readSeal:state.seal,cursor:state.receivedCursor,baseHash:canonicalHash,throughSequence:source.binding.sequence,queueHash,workingHash:await workingSnapshotHash(working),overlay:materializedRows(snapshot.backup,working),covered:[...covered.values()].sort((a,b)=>a.id.localeCompare(b.id)),pending:pending.map(c=>c.id),proofs:proofs.map(p=>({batchHash:p.batchHash,sourceHash:p.sourceHash,resultHash:p.resultHash!})),recoveryId:session.operationId};
 const application:LocalCanonicalApplication={...valueApp,hash:await applicationHash(valueApp)},base:LocalCanonicalSnapshot={id:'active',version:2,snapshot,hash:canonicalHash,applicationHash:application.hash};
 const unsigned:Omit<ScopeRecoveryAdmission,'hash'>={id:`admission:${session.operationId}`,kind:'admission',version:1,operationId:session.operationId,source:{binding:source.binding,operator:source.operator,scope:origin.base.snapshot.scope,baseHash:origin.base.hash,applicationHash:origin.application?.hash??null,working:source.working,workingHash:await workingSnapshotHash(source.working),queueHash,sequence:source.binding.sequence},target:{scope:snapshot.scope,targetHash:session.target.targetHash,readId:state.id,readSourceHash:state.sourceHash,readSeal:state.seal,cursor:state.receivedCursor,canonicalHash,applicationHash:application.hash},previousRecoveryHash:source.binding.recovery?.hash??null};
 const admission:ScopeRecoveryAdmission={...unsigned,hash:await scopeRecoveryHash(unsigned)},binding:LocalCloudState={...source.binding,version:3,origin:originalCloudAdmission(source.binding),recovery:{id:session.operationId,hash:admission.hash,scope:snapshot.scope}};
 if(source.operator.revision===Number.MAX_SAFE_INTEGER||session.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError();
 const operator:LocalOperatorState={...source.operator,revision:source.operator.revision+1,phase:'active',role:snapshot.scope.role,connection:{targetHash:session.target.targetHash,authKey:session.authKey,accountHash:snapshot.scope.accountHash,epoch:snapshot.scope.epoch,scopeVersion:snapshot.scope.scopeVersion}};
 const pagesToken=syncDownloadToken(await db.syncPages.where('readId').equals(state.id).sortBy('index')),imagesToken=await nativeRowHash(await db.syncImages.where('readId').equals(state.id).sortBy('imageId'));
 await fresh(session,access);await originalSession(db,session);active(access);
 const review:ScopeRecoveryReview=Object.freeze({operationId:session.operationId,readId:session.readId,before:Object.freeze(counts(source.working)),after:Object.freeze(counts(working)),pending:pending.length,covered:covered.size});
 plans.set(review,{session,origin,source,verified,working,application,base,admission,binding,operator,proofs,pagesToken,imagesToken});return review;
}

/** Apply one exact reviewed source and new scope, retaining the old shop and fence. */
export async function applyScopeRecoveryReview(db:MiseDatabase,review:ScopeRecoveryReview,access:ScopeRecoveryAccess):Promise<ScopeRecoverySession>{
 const plan=plans.get(review);if(!plan)throw new ScopeRecoveryError('integrity');const {session,origin,source,verified,working,application,base,admission,binding,operator}=plan,state=verified.context.state;
 await fresh(session,access);await originalSession(db,session);
 const stored=storedInboxItems(working.tables.inboxItems),oldStored=storedInboxItems(source.working.tables.inboxItems),changes:LocalRowChange[]=materializedRows(source.working,working).map(change=>change.table==='inboxItems'?{...change,before:oldStored.find(i=>i.id===change.key)??null,after:stored.find(i=>i.id===change.key)??null}:change);
 const operations:LocalRowChange[]=[...changes.filter(c=>c.before!==null).map(c=>({...c,after:null})),...changes.filter(c=>c.after!==null).map(c=>({...c,before:null}))];
 const rootCopy:LocalCanonicalSnapshot|null=origin.admission.id==='active'?{...origin.admission,id:`join:${origin.admission.snapshot.readId}`,version:1}:null,recoveryCopy:LocalCanonicalSnapshot={id:`recovery:${session.operationId}`,version:1,snapshot:base.snapshot,hash:base.hash};
 const next=parseScopeRecoverySession({...session,revision:session.revision+1,phase:'admitted',problem:null,expectedOperatorRevision:operator.revision,admissionHash:admission.hash});
 const controls:CanonicalRowChange[]=[...(rootCopy?[{table:'syncCanonical',key:rootCopy.id,before:null,after:rootCopy}]:[]),{table:'syncCanonical',key:recoveryCopy.id,before:null,after:recoveryCopy},{table:'syncApplications',key:application.id,before:null,after:application},{table:'scopeRecoveries',key:admission.id,before:null,after:admission},{table:'scopeRecoveries',key:'active',before:session,after:next},{table:'syncCanonical',key:'active',before:origin.base,after:base},{table:'operatorState',key:'active',before:source.operator,after:operator},{table:'cloudState',key:'binding',before:source.binding,after:binding}];
 const writePlan=await prepareCanonicalWrites([...operations,...controls],source.binding);await fresh(session,access);
 return db.transaction('rw',db.tables,()=>withCanonicalWrites(db,writePlan,async()=>{
  active(access);await assertCanonicalState(db,origin);assertCanonicalTransaction(db,writePlan,'recovery-origin');await originalSession(db,session);
  const latest=await readRecoveryWorkingSource(db,origin,session.expectedOperatorRevision);assertCanonicalTransaction(db,writePlan,'recovery-source');
  if(!equal(latest.binding,source.binding)||latest.queueToken!==source.queueToken||backupToken(latest.working)!==backupToken(source.working))throw new ScopeRecoveryError();
  if(!equal(await Dexie.waitFor(assertSyncDownloadContext(db,verified.context)),state)||!equal(await db.syncRecords.where('readId').equals(state.id).sortBy('changeId'),[...verified.records].sort((a,b)=>a.changeId.localeCompare(b.changeId)))||syncDownloadToken(await db.syncPages.where('readId').equals(state.id).sortBy('index'))!==plan.pagesToken||await Dexie.waitFor(nativeRowHash(await db.syncImages.where('readId').equals(state.id).sortBy('imageId')))!==plan.imagesToken)throw new ScopeRecoveryError('integrity');
  for(const proof of plan.proofs)if(!equal(await db.syncCoverage.get([state.id,proof.batchHash]),proof))throw new ScopeRecoveryError('integrity');
  for(const change of [...operations,...controls]){active(access);assertCanonicalTransaction(db,writePlan,'recovery-write');if(change.after===null)await db.table(change.table).delete(change.key);else await db.table(change.table).put(change.after);}
  assertCanonicalTransaction(db,writePlan,'recovery-postflight');
  if(backupToken(await readDatabaseBackup(db))!==backupToken(working)||!equal(await db.outbox.where('uploadId').equals(binding.uploadId).sortBy('sequence'),source.queue)||await db.outbox.count()!==source.queue.length||!equal(await db.cloudState.get('binding'),binding)||!equal(await db.operatorState.get('active'),operator)||!equal(await db.scopeRecoveries.get('active'),next)||!equal(await db.scopeRecoveries.get(admission.id),admission)||!equal(await db.syncCanonical.get('active'),base)||!equal(await db.syncApplications.get(application.id),application))throw new ScopeRecoveryError('integrity');
  active(access);return next;
 }));
}
