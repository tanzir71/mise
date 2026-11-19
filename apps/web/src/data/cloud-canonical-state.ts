import Dexie from 'dexie';
import {parseBackup} from '@mise/core/backup';
import {parseLocalCloudState,originalCloudAdmission,type LocalCloudState} from '@mise/core/local-outbox';
import {canonicalSnapshotHash,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {applicationHash,ReconciliationError,restoreMaterialization,workingSnapshotHash,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {syncDownloadToken} from '@mise/core/sync-download';
import {verifyOwnerUploadAdmission,type LocalOwnerUploadAdmission} from '@mise/core/sync-upload-admission';
import {parseSyncScope,type SyncScope} from '@mise/core/sync-read';
import {parseScopeRecoveryAdmission,verifyScopeRecoveryAdmission,sameRecoveryIdentity,type ScopeRecoveryAdmission} from '@mise/core/scope-recovery';
import type {LocalStore} from './local-store';
import {nativeRowHash} from './canonical-writes';

export interface RecoveryEvidence {admission:ScopeRecoveryAdmission;snapshot:LocalCanonicalSnapshot;application:LocalCanonicalApplication}
export interface CanonicalState {binding:LocalCloudState;base:LocalCanonicalSnapshot;admission:LocalCanonicalSnapshot;application:LocalCanonicalApplication|null;upload:LocalOwnerUploadAdmission|null;recoveries:RecoveryEvidence[];token:string}
export type JoinedCanonicalState=CanonicalState;
const stable=(binding:LocalCloudState)=>({...binding,sequence:0});
const identity=(state:Omit<CanonicalState,'token'>)=>nativeRowHash({...state,binding:stable(state.binding)});
const fail=()=>new ReconciliationError('integrity');
const equal=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
async function verifyApplication(app:LocalCanonicalApplication,snapshot:LocalCanonicalSnapshot){
 const {hash,...value}=app;
 if(app.version!==1||app.id!==snapshot.snapshot.readId||app.baseHash!==snapshot.hash||app.cursor!==snapshot.snapshot.cursor||app.readSeal!==snapshot.snapshot.seal||await applicationHash(value)!==hash||await workingSnapshotHash(restoreMaterialization(snapshot.snapshot.backup,app.overlay))!==app.workingHash)throw fail();
}
/** Original admission and each later scope bridge remain distinct, retained evidence.
 * None of these local hashes can establish fresh server authorization. */
export async function readCanonicalState(db:LocalStore):Promise<CanonicalState>{
 const saved=await db.transaction('r',db.cloudState,db.syncCanonical,db.syncApplications,db.syncAdmissions,db.scopeRecoveries,async()=>{
  const binding=parseLocalCloudState(await db.cloudState.get('binding')),original=originalCloudAdmission(binding);
  if(binding.phase!=='ready'||original.version===2&&!original.join)throw new ReconciliationError('review');
  const base=await db.syncCanonical.get('active');if(!base)throw fail();
  const upload=original.version===1?await db.syncAdmissions.get('owner-upload'):null;
  if(upload===undefined||original.version===2&&await db.syncAdmissions.count())throw fail();
  const admission=original.version===1?await db.syncCanonical.get(('upload:'+original.uploadId) as `upload:${string}`):base.snapshot.readId===original.join!.readId?base:await db.syncCanonical.get(('join:'+original.join!.readId) as `join:${string}`);
  if(!admission)throw fail();
  const application=base.version===2?await db.syncApplications.get(base.snapshot.readId):null;if(application===undefined)throw fail();
  const recoveries:RecoveryEvidence[]=[],seen=new Set<string>();let next=binding.recovery?.id;
  while(next){
   if(seen.has(next))throw fail();seen.add(next);
   const record=parseScopeRecoveryAdmission(await db.scopeRecoveries.get('admission:'+next));
   const snapshot=await db.syncCanonical.get(('recovery:'+record.operationId) as `recovery:${string}`),app=await db.syncApplications.get(record.target.readId);
   if(!snapshot||!app)throw fail();
   recoveries.push({admission:record,snapshot,application:app});next=record.source.binding.recovery?.id;
  }
  return {binding,base,admission,application,upload,recoveries};
 });
 const {binding,base,admission,application,upload,recoveries}=saved,original=originalCloudAdmission(binding);
 for(const row of [base,admission]){if(await canonicalSnapshotHash(row.snapshot)!==row.hash)throw fail();parseBackup(row.snapshot.backup);}
 let initial:SyncScope;
 if(original.version===2){
  const join=original.join!;initial={businessId:original.businessId,outletId:original.outletId,actorId:original.ownerId,accountHash:join.accountHash,role:join.role,epoch:join.epoch,scopeVersion:join.scopeVersion};
  if(admission.hash!==original.manifestHash||admission.snapshot.readId!==join.readId||admission.snapshot.cursor!==join.cursor||admission.snapshot.seal!==join.readSeal||admission.id!=='active'&&admission.id!=='join:'+join.readId)throw fail();
 }else{
  if(!upload||!original.receipt||base.version!==2)throw fail();
  const verified=await verifyOwnerUploadAdmission(upload),s=verified.admission.source;initial=parseSyncScope(s.window);
  if(upload.initialBaseHash!==admission.hash||admission.id!=='upload:'+original.uploadId||s.manifest.id!==original.uploadId||s.manifestHash!==original.manifestHash||!equal(s.receipt,original.receipt)||s.target.targetHash!==original.targetHash||initial.businessId!==original.businessId||initial.outletId!==original.outletId||initial.actorId!==original.ownerId||initial.role!=='owner'||admission.snapshot.readId!==s.readId||admission.snapshot.seal!==s.readSeal||admission.snapshot.cursor!==s.cursor)throw fail();
 }
 if(base.id!=='active'||admission.version!==1||admission.snapshot.targetHash!==binding.targetHash||!equal(admission.snapshot.scope,initial)||base.snapshot.targetHash!==binding.targetHash)throw fail();
 let current=initial,previousHash:string|null=null;
 for(const evidence of [...recoveries].reverse()){
  const record=await verifyScopeRecoveryAdmission(evidence.admission),snapshot=evidence.snapshot,app=evidence.application,s=record.source,t=record.target;
  if(!equal(s.scope,current)||!sameRecoveryIdentity(initial,t.scope)||s.binding.targetHash!==binding.targetHash||!equal(stable(originalCloudAdmission(s.binding)),stable(original))||record.previousRecoveryHash!==previousHash||snapshot.id!=='recovery:'+record.operationId||snapshot.version!==1||snapshot.hash!==t.canonicalHash||await canonicalSnapshotHash(snapshot.snapshot)!==snapshot.hash||!equal(snapshot.snapshot.scope,t.scope)||snapshot.snapshot.targetHash!==t.targetHash||snapshot.snapshot.readId!==t.readId||snapshot.snapshot.cursor!==t.cursor||snapshot.snapshot.seal!==t.readSeal||app.hash!==t.applicationHash||app.recoveryId!==record.operationId||app.previousBaseHash!==s.baseHash||app.previousApplicationHash!==s.applicationHash||app.readSourceHash!==t.readSourceHash||app.throughSequence!==s.sequence||app.queueHash!==s.queueHash)throw fail();
  await verifyApplication(app,snapshot);current=t.scope;previousHash=record.hash;
 }
 if(binding.version===3){
  if(!recoveries.length||binding.recovery!.hash!==previousHash||binding.recovery!.id!==recoveries[0].admission.operationId||!equal(binding.recovery!.scope,current)||application?.recoveryId!==binding.recovery!.id)throw fail();
 }else if(recoveries.length||application?.recoveryId!==undefined)throw fail();
 if(!equal(base.snapshot.scope,current))throw fail();
 if(base.version===1){if(binding.version===3||application!==null||base.snapshot.readId!==original.join?.readId)throw fail();}
 else{
  if(!application||application.hash!==base.applicationHash||!Number.isSafeInteger(application.throughSequence)||application.throughSequence<0||application.throughSequence>binding.sequence)throw fail();
  await verifyApplication(application,base);
 }
 return {...saved,token:await identity(saved)};
}
export async function readJoinedCanonicalState(db:LocalStore):Promise<JoinedCanonicalState>{const state=await readCanonicalState(db);if(state.binding.version!==2)throw new ReconciliationError('review');return state;}
/** Recheck exact original evidence inside the same native transaction. */
export async function assertCanonicalState(db:LocalStore,state:CanonicalState):Promise<void>{
 const binding=parseLocalCloudState(await db.cloudState.get('binding')),base=await db.syncCanonical.get('active'),admission=state.admission.id==='active'?base:await db.syncCanonical.get(state.admission.id),application=state.application?await db.syncApplications.get(state.application.id):null,upload=(await db.syncAdmissions.get('owner-upload'))??null,recoveries:RecoveryEvidence[]=[];
 for(const evidence of state.recoveries){
  const record=await db.scopeRecoveries.get(evidence.admission.id),snapshot=await db.syncCanonical.get(evidence.snapshot.id),app=await db.syncApplications.get(evidence.application.id);
  if(!record||record.kind!=='admission'||!snapshot||!app)throw fail();recoveries.push({admission:record,snapshot,application:app});
 }
 if(!base||!admission||application===undefined||await Dexie.waitFor(identity({binding,base,admission,application,upload,recoveries}))!==state.token)throw new ReconciliationError('review');
}
export const assertJoinedCanonicalState=assertCanonicalState;
