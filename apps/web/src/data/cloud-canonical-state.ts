import {parseBackup} from '@mise/core/backup';
import {parseLocalCloudState,type LocalCloudState} from '@mise/core/local-outbox';
import {canonicalSnapshotHash,type LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import {applicationHash,ReconciliationError,restoreMaterialization,workingSnapshotHash,type LocalCanonicalApplication} from '@mise/core/sync-materialize';
import {syncDownloadToken} from '@mise/core/sync-download';
import type {LocalStore} from './local-store';

export interface JoinedCanonicalState {binding:LocalCloudState;base:LocalCanonicalSnapshot;admission:LocalCanonicalSnapshot;application:LocalCanonicalApplication|null;token:string}
const stable=(binding:LocalCloudState)=>({...binding,sequence:0});
const identity=(state:Omit<JoinedCanonicalState,'token'>)=>syncDownloadToken({...state,binding:stable(state.binding)});
/** Integrity of installed source data is separate from fresh server authorization. */
export async function readJoinedCanonicalState(db:LocalStore):Promise<JoinedCanonicalState>{
 const saved=await db.transaction('r',db.cloudState,db.syncCanonical,db.syncApplications,async()=>{
  const binding=parseLocalCloudState(await db.cloudState.get('binding'));if(binding.version!==2||!binding.join)throw new ReconciliationError('review');const base=await db.syncCanonical.get('active');if(!base)throw new ReconciliationError('integrity');
  const admission=base.snapshot.readId===binding.join.readId?base:await db.syncCanonical.get(`join:${binding.join.readId}`);if(!admission)throw new ReconciliationError('integrity');const application=base.version===2?await db.syncApplications.get(base.snapshot.readId):null;if(application===undefined)throw new ReconciliationError('integrity');return {binding,base,admission,application};
 });
 const {binding,base,admission,application}=saved,join=binding.join!;
 for(const row of [base,admission]){if(await canonicalSnapshotHash(row.snapshot)!==row.hash)throw new ReconciliationError('integrity');parseBackup(row.snapshot.backup);}
 const scope={businessId:binding.businessId,outletId:binding.outletId,actorId:binding.ownerId,accountHash:join.accountHash,role:join.role,epoch:join.epoch,scopeVersion:join.scopeVersion};
 if(base.id!=='active'||admission.version!==1||admission.hash!==binding.manifestHash||admission.snapshot.readId!==join.readId||admission.snapshot.cursor!==join.cursor||admission.snapshot.seal!==join.readSeal||[base,admission].some(r=>r.snapshot.targetHash!==binding.targetHash||syncDownloadToken(r.snapshot.scope)!==syncDownloadToken(scope)))throw new ReconciliationError('integrity');
 if(base.version===1){if(application!==null||base.snapshot.readId!==join.readId)throw new ReconciliationError('integrity');}
 else{
  if(!application||application.version!==1||application.id!==base.snapshot.readId||application.hash!==base.applicationHash||application.baseHash!==base.hash||application.cursor!==base.snapshot.cursor||application.readSeal!==base.snapshot.seal||!Number.isSafeInteger(application.throughSequence)||application.throughSequence<0||application.throughSequence>binding.sequence)throw new ReconciliationError('integrity');
  const {hash,...value}=application;if(await applicationHash(value)!==hash||await workingSnapshotHash(restoreMaterialization(base.snapshot.backup,application.overlay))!==application.workingHash)throw new ReconciliationError('integrity');
 }
 return {...saved,token:identity(saved)};
}
/** Native transaction check after detached hashing/network work. Sequence is
 * checked by application separately; fresh selection permits genuine new edits. */
export async function assertJoinedCanonicalState(db:LocalStore,state:JoinedCanonicalState):Promise<void>{
 const binding=parseLocalCloudState(await db.cloudState.get('binding')),base=await db.syncCanonical.get('active'),admission=state.admission.id==='active'?base:await db.syncCanonical.get(state.admission.id),application=state.application?await db.syncApplications.get(state.application.id):null;
 if(!base||!admission||application===undefined||identity({binding,base,admission,application})!==state.token)throw new ReconciliationError('review');
}
