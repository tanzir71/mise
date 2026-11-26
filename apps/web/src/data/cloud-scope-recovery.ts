import Dexie from 'dexie';
import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {originalCloudAdmission,parseLocalCloudState} from '@mise/core/local-outbox';
import {parseLocalOperatorState,parseOperatorContext,type OperatorContext} from '@mise/core/operators';
import {parseScopeRecoverySession,sameRecoveryIdentity,ScopeRecoveryError,type ScopeRecoverySession,type RecoveryProblem} from '@mise/core/scope-recovery';
import {parseSyncScope} from '@mise/core/sync-read';
import {syncDownloadToken,type SyncDownloadTarget} from '@mise/core/sync-download';
import {readCanonicalState,assertCanonicalState} from './cloud-canonical-state';
import {cycleAccount} from './sync-cycle';
import {createOperatorRemote} from './operator-remote';
import {resolveCloudAuthScope,discoveryAuthScope} from './cloud-auth-scope';
import {selectCloudOperator} from './operator-state';
import {prepareSyncDownload,runSyncDownload} from './cloud-sync-journal';
import {downloadSyncImages} from './cloud-sync-images';
import {createCloudSyncRemote} from './cloud-sync-remote';
import {createCloudImageRemote} from './cloud-image-remote';
import {createCloudCoverageRemote} from './cloud-coverage-remote';
import {prepareScopeRecoveryReview,applyScopeRecoveryReview,type ScopeRecoveryReview} from './cloud-scope-apply';
import {ensureSyncSession,requestSync} from './sync-session';
import {parseSyncSession} from '@mise/core/sync-session';
import {nativeRowHash} from './canonical-writes';
import type {MiseDatabase} from './db';
import type {PhoneAuth} from './phone-auth';
import type {CommandAuthorization} from './command-request';

export interface ScopeRecoveryOptions {
 config:CloudConnection;base:string;auth:Pick<PhoneAuth,'key'|'commandAuthorization'|'assertCommandAuthorization'>;
 connectionCurrent?:()=>boolean;send?:typeof fetch;
}
const equal=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
export function scopeRecoveryProblem(error:unknown):RecoveryProblem {
 if(error&&typeof error==='object'&&'kind'in error&&['conflict','retained'].includes(error.kind as string))return 'review';
 if(error&&typeof error==='object'&&'kind'in error&&['auth','retry','review','integrity'].includes(error.kind as string))return error.kind as RecoveryProblem;
 return 'retry';
}
function native(db:MiseDatabase,check:()=>void){check();const tx=Dexie.currentTransaction;if(!tx||tx.db!==db||!tx.active||tx.mode!=='readwrite')throw new ScopeRecoveryError('integrity');}
/** Locate the original installed Auth namespace, without copying a token or JWT. */
export async function scopeRecoveryAuthScope(db:MiseDatabase,config:CloudConnection,base:string){
 const canonical=await readCanonicalState(db),business=canonical.base.snapshot.scope.businessId,operator=await db.operatorState.get('active'),session=await db.syncSessions.get('active');
 for(const key of [operator?.connection?.authKey,session?.authKey])if(key){try{return await resolveCloudAuthScope(config,base,business,key);}catch{/* A different selected outlet cannot choose the original Auth namespace. */}}
 return originalCloudAdmission(canonical.binding).version===2?discoveryAuthScope(base):base+business;
}
async function access(db:MiseDatabase,options:ScopeRecoveryOptions,signal?:AbortSignal){
 const config=parseCloudConnection(options.config),canonical=await readCanonicalState(db);
 if(canonical.native)throw new ScopeRecoveryError('review');
 const scope=canonical.base.snapshot.scope,target:SyncDownloadTarget={targetHash:canonical.binding.targetHash,businessId:scope.businessId,outletId:scope.outletId,actorId:scope.actorId,accountHash:scope.accountHash,role:scope.role};
 await resolveCloudAuthScope(config,options.base,scope.businessId,options.auth.key);
 const account=cycleAccount({...options,config,scope:options.base+scope.businessId},{target,authKey:options.auth.key});
 let latest:CommandAuthorization=await account.getAuth();
 const assertActive=()=>{signal?.throwIfAborted();account.assertCurrent(latest);};
 const getAuth=async()=>{assertActive();latest=await account.getAuth();assertActive();return latest;};
 const metadata=createOperatorRemote(config,getAuth,options.send);
 const refresh=async(context:OperatorContext)=>{assertActive();const current=await metadata.select(context,signal);await getAuth();assertActive();return current;};
 return {canonical,config,target,scope,refresh,getAuth,assertActive,signal};
}
function selectedContext(scope:ReturnType<typeof parseSyncScope>):OperatorContext{return parseOperatorContext({...scope,version:1,businessName:null,outletName:null,actorName:null});}
async function rememberProblem(db:MiseDatabase,operationId:string,error:unknown){
 try{await db.transaction('rw',db.scopeRecoveries,async()=>{const raw=await db.scopeRecoveries.get('active');if(raw?.kind!=='session')return;const state=parseScopeRecoverySession(raw);if(state.operationId!==operationId||['ready','cancelled'].includes(state.phase)||state.revision===Number.MAX_SAFE_INTEGER)return;await db.scopeRecoveries.put(parseScopeRecoverySession({...state,revision:state.revision+1,problem:scopeRecoveryProblem(error)}));});}catch{/* An unavailable error record never replaces original shop data. */}
}
async function prepare(db:MiseDatabase,options:ScopeRecoveryOptions,forceNew:boolean,signal?:AbortSignal){
 let a=await access(db,options,signal);const context=await a.refresh(selectedContext(a.scope));
 if(!sameRecoveryIdentity(a.scope,parseSyncScope(context)))throw new ScopeRecoveryError('auth');
 let operator=parseLocalOperatorState(await db.operatorState.get('active'));
 // Returning to the actual original outlet is a fresh server selection, never a
 // cached-owner fallback. A different scope remains pending until reviewed.
 if(operator.businessId!==a.scope.businessId||operator.outletId!==a.scope.outletId||operator.actorId!==a.scope.actorId||operator.connection?.accountHash!==a.scope.accountHash||operator.connection.targetHash!==a.target.targetHash||operator.connection.authKey!==options.auth.key){
  await selectCloudOperator(db,context,{targetHash:a.target.targetHash,authKey:options.auth.key},operator.revision,a.refresh,a.assertActive);a=await access(db,options,signal);operator=parseLocalOperatorState(await db.operatorState.get('active'));
 }
 const target={...a.target,role:context.role},bindingHash=await nativeRowHash({...a.canonical.binding,sequence:0}),previousRaw=await db.scopeRecoveries.get('active'),previous=previousRaw?parseScopeRecoverySession(previousRaw):null;
 if(previous&&['admitted','ready'].includes(previous.phase)&&!forceNew)throw new ScopeRecoveryError();
 if(previous&&['pending','paused'].includes(previous.phase)&&!forceNew){
  if(previous.originalBindingHash!==bindingHash||previous.originalBaseHash!==a.canonical.base.hash||!equal(previous.originalScope,a.scope)||!equal(previous.target,target)||previous.epoch!==context.epoch||previous.scopeVersion!==context.scopeVersion||previous.authKey!==options.auth.key||previous.expectedOperatorRevision!==operator.revision)throw new ScopeRecoveryError();
 }
 const revision=(previous?.revision??0)+1;if(!Number.isSafeInteger(revision))throw new ScopeRecoveryError();
 const session=parseScopeRecoverySession(previous&&!forceNew&&['pending','paused'].includes(previous.phase)?{...previous,revision,phase:'pending',problem:null}:{id:'active',kind:'session',version:1,operationId:newInboxId(),revision,phase:'pending',problem:null,originalBindingHash:bindingHash,originalBaseHash:a.canonical.base.hash,originalScope:a.scope,target,epoch:context.epoch,scopeVersion:context.scopeVersion,authKey:options.auth.key,expectedOperatorRevision:operator.revision,readId:newInboxId(),admissionHash:null});
 await db.transaction('rw',[db.cloudState,db.operatorState,db.syncCanonical,db.syncApplications,db.syncAdmissions,db.scopeRecoveries,db.syncSessions],async()=>{
  native(db,a.assertActive);await assertCanonicalState(db,a.canonical);if(!equal(await db.operatorState.get('active'),operator)||!equal(await db.scopeRecoveries.get('active'),previousRaw))throw new ScopeRecoveryError();
  if(previous&&previous.operationId!==session.operationId)await db.scopeRecoveries.put({...previous,id:`saved:${previous.operationId}`});
  const sync=await db.syncSessions.get('active');if(sync)await db.syncSessions.put({...parseSyncSession(sync),paused:true});
  await db.scopeRecoveries.put(session);native(db,a.assertActive);
 });
 return {a,session};
}
/** Resume the exact saved full download; previewing cannot replace working rows. */
export async function reviewScopeRecovery(db:MiseDatabase,options:ScopeRecoveryOptions,forceNew=false,signal?:AbortSignal):Promise<ScopeRecoveryReview>{
 const {a,session}=await prepare(db,options,forceNew,signal);
 try{
  await prepareSyncDownload(db,{id:session.readId,target:session.target,previousCursor:null});
  const read=createCloudSyncRemote(a.config,async()=>(await a.getAuth()).jwt,options.send),images=createCloudImageRemote(a.config,options.base+session.target.businessId,a.getAuth,options.send),coverage=createCloudCoverageRemote(a.config,options.base+session.target.businessId,a.getAuth,options.send);
  await runSyncDownload(db,session.readId,session.target,read,signal);await a.getAuth();await downloadSyncImages(db,session.readId,session.target,images,signal);a.assertActive();
  return await prepareScopeRecoveryReview(db,session,coverage,a);
 }catch(error){await rememberProblem(db,session.operationId,error);throw error;}
}
/** The domain admission is durable before automatic sync is enabled, so a lost
 * activation response resumes it without applying the shop or queue again. */
export async function activateScopeRecovery(db:MiseDatabase,options:ScopeRecoveryOptions,signal?:AbortSignal):Promise<ScopeRecoverySession>{
 const a=await access(db,options,signal),session=parseScopeRecoverySession(await db.scopeRecoveries.get('active'));
 if(!['admitted','ready'].includes(session.phase)||a.canonical.binding.recovery?.id!==session.operationId||a.canonical.binding.recovery.hash!==session.admissionHash||!equal(a.canonical.base.snapshot.scope,parseSyncScope({...session.target,epoch:session.epoch,scopeVersion:session.scopeVersion})))throw new ScopeRecoveryError();
 try{
  const context=await a.refresh(selectedContext(a.canonical.base.snapshot.scope));if(!equal(parseSyncScope(context),a.canonical.base.snapshot.scope))throw new ScopeRecoveryError();
  const operator=parseLocalOperatorState(await db.operatorState.get('active'));if(operator.phase!=='active'||operator.revision!==session.expectedOperatorRevision||operator.connection?.authKey!==options.auth.key)throw new ScopeRecoveryError();
  await ensureSyncSession(db,{target:session.target,authKey:session.authKey,operatorRevision:operator.revision,epoch:session.epoch,scopeVersion:session.scopeVersion},newInboxId());a.assertActive();await requestSync(db,true);a.assertActive();
  return await db.transaction('rw',db.scopeRecoveries,db.cloudState,db.operatorState,async()=>{
   native(db,a.assertActive);const current=parseScopeRecoverySession(await db.scopeRecoveries.get('active'));
   if(current.phase==='ready'&&current.operationId===session.operationId&&current.admissionHash===session.admissionHash)return current;
   const binding=parseLocalCloudState(await db.cloudState.get('binding'));
   if(!equal(current,session)||!equal(await db.operatorState.get('active'),operator)||binding.sequence<a.canonical.binding.sequence||!equal({...binding,sequence:0},{...a.canonical.binding,sequence:0})||current.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError();
   const ready=parseScopeRecoverySession({...current,revision:current.revision+1,phase:'ready',problem:null});await db.scopeRecoveries.put(ready);native(db,a.assertActive);return ready;
  });
 }catch(error){await rememberProblem(db,session.operationId,error);throw error;}
}
export async function applyReviewedScopeRecovery(db:MiseDatabase,review:ScopeRecoveryReview,options:ScopeRecoveryOptions,signal?:AbortSignal){
 const a=await access(db,options,signal);
 try{
  const current=await db.scopeRecoveries.get('active');
  if(current?.kind==='session'&&current.operationId===review.operationId&&['admitted','ready'].includes(current.phase))return await activateScopeRecovery(db,options,signal);
  await applyScopeRecoveryReview(db,review,a);return await activateScopeRecovery(db,options,signal);
 }catch(error){await rememberProblem(db,review.operationId,error);throw error;}
}
export async function pauseScopeRecovery(db:MiseDatabase,cancel=false){
 await db.transaction('rw',db.scopeRecoveries,async()=>{const raw=await db.scopeRecoveries.get('active');if(!raw)return;const session=parseScopeRecoverySession(raw);if(!['pending','paused'].includes(session.phase))throw new ScopeRecoveryError();if(session.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError();await db.scopeRecoveries.put(parseScopeRecoverySession({...session,revision:session.revision+1,phase:cancel?'cancelled':'paused',problem:null}));});
}
/** Manual fallback stops delivery; it never unlocks or changes an operator. */
export async function continueRecoveryOffline(db:MiseDatabase){
 return db.transaction('rw',db.scopeRecoveries,db.cloudState,db.syncSessions,async()=>{const session=parseScopeRecoverySession(await db.scopeRecoveries.get('active')),binding=await db.cloudState.get('binding');if(session.phase!=='admitted'||binding?.recovery?.id!==session.operationId||binding.recovery.hash!==session.admissionHash||session.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError();const sync=await db.syncSessions.get('active');if(sync)await db.syncSessions.put({...parseSyncSession(sync),paused:true});const next=parseScopeRecoverySession({...session,revision:session.revision+1,phase:'ready',problem:null});await db.scopeRecoveries.put(next);return next;});
}
