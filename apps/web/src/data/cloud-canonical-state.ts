import Dexie from 'dexie';
import {parseBackup} from '@mise/core/backup';
import {parseLocalCloudState,type LocalCloudState} from '@mise/core/local-outbox';
import {canonicalSnapshotHash,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {applicationHash,ReconciliationError,restoreMaterialization,workingSnapshotHash,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {syncDownloadToken} from '@mise/core/sync-download';
import {verifyOwnerUploadAdmission,type LocalOwnerUploadAdmission} from '@mise/core/sync-upload-admission';
import {parseSyncScope,type SyncScope} from '@mise/core/sync-read';
import type {LocalStore} from './local-store';
import {nativeRowHash} from './canonical-writes';

export interface CanonicalState {binding:LocalCloudState;base:LocalCanonicalSnapshot;admission:LocalCanonicalSnapshot;application:LocalCanonicalApplication|null;upload:LocalOwnerUploadAdmission|null;token:string}
export type JoinedCanonicalState=CanonicalState;
const stable=(binding:LocalCloudState)=>({...binding,sequence:0});
const identity=(state:Omit<CanonicalState,'token'>)=>nativeRowHash({...state,binding:stable(state.binding)});
/** Integrity of installed source data is separate from fresh server authorization. */
export async function readCanonicalState(db:LocalStore):Promise<CanonicalState>{
 const saved=await db.transaction('r',db.cloudState,db.syncCanonical,db.syncApplications,db.syncAdmissions,async()=>{
  const binding=parseLocalCloudState(await db.cloudState.get('binding'));if(binding.phase!=='ready'||binding.version===2&&!binding.join)throw new ReconciliationError('review');const base=await db.syncCanonical.get('active');if(!base)throw new ReconciliationError('integrity');
  const upload=binding.version===1?await db.syncAdmissions.get('owner-upload'):null;if(upload===undefined||binding.version===2&&await db.syncAdmissions.count())throw new ReconciliationError('integrity');
  const admission=binding.version===1?await db.syncCanonical.get(`upload:${binding.uploadId}`):base.snapshot.readId===binding.join!.readId?base:await db.syncCanonical.get(`join:${binding.join!.readId}`);if(!admission)throw new ReconciliationError('integrity');const application=base.version===2?await db.syncApplications.get(base.snapshot.readId):null;if(application===undefined)throw new ReconciliationError('integrity');return {binding,base,admission,application,upload};
 });
 const {binding,base,admission,application,upload}=saved;
 for(const row of [base,admission]){if(await canonicalSnapshotHash(row.snapshot)!==row.hash)throw new ReconciliationError('integrity');parseBackup(row.snapshot.backup);}
 let scope:SyncScope;
 if(binding.version===2){const join=binding.join!;scope={businessId:binding.businessId,outletId:binding.outletId,actorId:binding.ownerId,accountHash:join.accountHash,role:join.role,epoch:join.epoch,scopeVersion:join.scopeVersion};
  if(admission.hash!==binding.manifestHash||admission.snapshot.readId!==join.readId||admission.snapshot.cursor!==join.cursor||admission.snapshot.seal!==join.readSeal||admission.id!=='active'&&admission.id!==`join:${join.readId}`)throw new ReconciliationError('integrity');
 }else{
  if(!upload||!binding.receipt||base.version!==2)throw new ReconciliationError('integrity');const verified=await verifyOwnerUploadAdmission(upload),s=verified.admission.source;scope=parseSyncScope(s.window);
  if(upload.initialBaseHash!==admission.hash||admission.id!==`upload:${binding.uploadId}`||s.manifest.id!==binding.uploadId||s.manifestHash!==binding.manifestHash||syncDownloadToken(s.receipt)!==syncDownloadToken(binding.receipt)||s.target.targetHash!==binding.targetHash||scope.businessId!==binding.businessId||scope.outletId!==binding.outletId||scope.actorId!==binding.ownerId||scope.role!=='owner'||admission.snapshot.readId!==s.readId||admission.snapshot.seal!==s.readSeal||admission.snapshot.cursor!==s.cursor)throw new ReconciliationError('integrity');
 }
 if(base.id!=='active'||admission.version!==1||[base,admission].some(r=>r.snapshot.targetHash!==binding.targetHash||syncDownloadToken(r.snapshot.scope)!==syncDownloadToken(scope)))throw new ReconciliationError('integrity');
 if(base.version===1){if(application!==null||base.snapshot.readId!==binding.join?.readId)throw new ReconciliationError('integrity');}
 else{
  if(!application||application.version!==1||application.id!==base.snapshot.readId||application.hash!==base.applicationHash||application.baseHash!==base.hash||application.cursor!==base.snapshot.cursor||application.readSeal!==base.snapshot.seal||!Number.isSafeInteger(application.throughSequence)||application.throughSequence<0||application.throughSequence>binding.sequence)throw new ReconciliationError('integrity');
  const {hash,...value}=application;if(await applicationHash(value)!==hash||await workingSnapshotHash(restoreMaterialization(base.snapshot.backup,application.overlay))!==application.workingHash)throw new ReconciliationError('integrity');
 }
 return {...saved,token:await identity(saved)};
}
/** Joining and adopting an original owner upload remain distinct admissions. */
export async function readJoinedCanonicalState(db:LocalStore):Promise<JoinedCanonicalState>{const state=await readCanonicalState(db);if(state.binding.version!==2)throw new ReconciliationError('review');return state;}
/** Native transaction check after detached hashing/network work. Sequence is
 * checked by application separately; fresh selection permits genuine new edits. */
export async function assertCanonicalState(db:LocalStore,state:CanonicalState):Promise<void>{
 const binding=parseLocalCloudState(await db.cloudState.get('binding')),base=await db.syncCanonical.get('active'),admission=state.admission.id==='active'?base:await db.syncCanonical.get(state.admission.id),application=state.application?await db.syncApplications.get(state.application.id):null,upload=(await db.syncAdmissions.get('owner-upload'))??null;
 if(!base||!admission||application===undefined||await Dexie.waitFor(identity({binding,base,admission,application,upload}))!==state.token)throw new ReconciliationError('review');
}
export const assertJoinedCanonicalState=assertCanonicalState;
