import Dexie from 'dexie';
import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseLocalCloudState,type LocalCloudState} from '@mise/core/local-outbox';
import {operatorAccountHash,parseLocalOperatorState,parseOperatorContext} from '@mise/core/operators';
import {parseSyncScope} from '@mise/core/sync-read';
import {parseOwnerResumeSession,type OwnerResumeSession} from '@mise/core/owner-resume';
import {ScopeRecoveryError,type RecoveryProblem} from '@mise/core/scope-recovery';
import {readCloudUpload} from '@mise/core/cloud-upload';
import {parseCloudUploadProgress} from '@mise/core/cloud-upload-runner';
import {syncDownloadToken} from '@mise/core/sync-download';
import {newInboxId} from '@mise/core/inbox';
import {CloudUploadJournal} from './cloud-upload';
import {assertLocalUploadCoverage} from './local-outbox';
import {resolveCloudAuthScope} from './cloud-auth-scope';
import {cycleAccount} from './sync-cycle';
import {createCloudUploadRemote} from './cloud-upload-remote';
import {createOperatorRemote} from './operator-remote';
import {enableSync} from './sync-enable';
import {nativeRowHash} from './canonical-writes';
import {readCanonicalState} from './cloud-canonical-state';
import {readRecoveryWorkingSource,assertRecoveryWorkingCoverage} from './cloud-sync-apply';
import {parseSyncSession} from '@mise/core/sync-session';
import type {MiseDatabase} from './db';
import type {PhoneAuth} from './phone-auth';

export interface OwnerResumeOptions {
 config:CloudConnection;base:string;journal:CloudUploadJournal;
 auth:Pick<PhoneAuth,'key'|'commandAuthorization'|'assertCommandAuthorization'>;
 connectionCurrent?:()=>boolean;send?:typeof fetch;
}
const equal=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const stable=(binding:LocalCloudState)=>({...binding,sequence:0});
export function ownerResumeProblem(error:unknown):RecoveryProblem {return error&&typeof error==='object'&&'kind'in error&&['auth','review','integrity','retry'].includes(error.kind as string)?error.kind as RecoveryProblem:'retry';}
function original(value:unknown){const binding=parseLocalCloudState(value);if(binding.version!==1||binding.phase!=='ready'||!binding.receipt)throw new ScopeRecoveryError('review');return binding;}
function native(db:MiseDatabase,assertActive:()=>void){const result:unknown=assertActive();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new ScopeRecoveryError('integrity');}const tx=Dexie.currentTransaction;if(!tx||!tx.active||tx.db!==db||tx.mode!=='readwrite')throw new ScopeRecoveryError('integrity');}

/** Reuse the original installed namespace. Never copy an Auth token to another key. */
export async function ownerResumeAuthScope(db:MiseDatabase,config:CloudConnection,base:string){
 const binding=original(await db.cloudState.get('binding')),operator=await db.operatorState.get('active'),session=await db.syncSessions.get('active');
 for(const key of [operator?.connection?.authKey,session?.authKey])if(key)return resolveCloudAuthScope(config,base,binding.businessId,key);
 return base+binding.businessId;
}
async function source(db:MiseDatabase,journal:CloudUploadJournal,allowCanonical:boolean){
 const binding=original(await db.cloudState.get('binding')),snapshot=await journal.readSnapshot(binding.uploadId).catch(()=>{throw new ScopeRecoveryError('integrity');}),operatorRaw=await db.operatorState.get('active'),operator=operatorRaw?parseLocalOperatorState(operatorRaw):null,hasBase=await db.syncCanonical.where('id').equals('active').count()>0;
 if(hasBase&&!allowCanonical)throw new ScopeRecoveryError('review');
 if(snapshot.manifestHash!==binding.manifestHash||snapshot.manifest.businessId!==binding.businessId||snapshot.manifest.outletId!==binding.outletId||snapshot.manifest.ownerId!==binding.ownerId||!equal(snapshot.progress?.receipt,binding.receipt))throw new ScopeRecoveryError('integrity');
 if(operator&&(operator.businessId!==binding.businessId||operator.outletId!==binding.outletId||operator.actorId!==binding.ownerId))throw new ScopeRecoveryError('review');
 const backup=await readCloudUpload(snapshot).catch(()=>{throw new ScopeRecoveryError('integrity');}),business=backup.tables.businesses.find(row=>row.id===binding.businessId),outlet=backup.tables.outlets.find(row=>row.id===binding.outletId),owner=backup.tables.members.find(row=>row.id===binding.ownerId);
 if(!business||!outlet||!owner||owner.role!=='owner'||!owner.active)throw new ScopeRecoveryError('integrity');
 if(hasBase){if(!operator)throw new ScopeRecoveryError('integrity');const canonical=await readCanonicalState(db),working=await readRecoveryWorkingSource(db,canonical,operator.revision);await assertRecoveryWorkingCoverage(canonical,working);}
 else await assertLocalUploadCoverage(db,snapshot,binding.targetHash);
 return {binding,snapshot,operator,setup:{business,outlet,owner},hasBase};
}
async function pauseDelivery(db:MiseDatabase,session:OwnerResumeSession){const raw=await db.syncSessions.get('active');if(!raw)return;const sync=parseSyncSession(raw);if(sync.target.targetHash===session.targetHash&&sync.target.businessId===session.businessId&&sync.target.outletId===session.outletId&&sync.target.actorId===session.actorId)await db.syncSessions.put({...sync,paused:true});}
async function remember(db:MiseDatabase,id:string,error:unknown){try{await db.transaction('rw',db.scopeRecoveries,db.syncSessions,async()=>{const raw=await db.scopeRecoveries.get('owner:active');if(raw?.kind!=='owner-session'||raw.operationId!==id||raw.phase!=='pending'||raw.revision===Number.MAX_SAFE_INTEGER)return;const session=parseOwnerResumeSession(raw);await pauseDelivery(db,session);await db.scopeRecoveries.put({...session,revision:raw.revision+1,problem:ownerResumeProblem(error)});});}catch{/* No error record can replace the shop or its original upload. */}}

/** Restore only the real accepted original upload. This never uploads, replaces
 * domain rows, resets its fence or manufactures a join/canonical admission. */
export async function resumeOriginalOwner(db:MiseDatabase,options:OwnerResumeOptions,forceNew=false,signal?:AbortSignal):Promise<OwnerResumeSession>{
 const previousRaw=await db.scopeRecoveries.get('owner:active'),previous=previousRaw?parseOwnerResumeSession(previousRaw):null,s=await source(db,options.journal,previous?.phase==='pending'),config=parseCloudConnection(options.config),scope=options.base+s.binding.businessId;
 try{await resolveCloudAuthScope(config,options.base,s.binding.businessId,options.auth.key);}catch{throw new ScopeRecoveryError('auth');}
 const initial=await options.auth.commandAuthorization();
 const target={targetHash:s.binding.targetHash,businessId:s.binding.businessId,outletId:s.binding.outletId,actorId:s.binding.ownerId,accountHash:await operatorAccountHash(initial.userId),role:'owner' as const};
 const account=cycleAccount({...options,config,scope},{target,authKey:options.auth.key});let authorization=await account.getAuth();
 const check=()=>{signal?.throwIfAborted();account.assertCurrent(authorization);};
 const getAuth=async()=>{check();authorization=await account.getAuth();check();return authorization;};
 const remote=createCloudUploadRemote(config.apiUrl,config.publishableKey,account,options.send),progress=parseCloudUploadProgress(await remote.status(s.binding.uploadId,signal),s.snapshot.manifest,s.snapshot.manifestHash);check();remote.assertCurrent();
 if(!progress.receipt||!equal(progress.receipt,s.binding.receipt))throw new ScopeRecoveryError('review');
 const bindingHash=await nativeRowHash(stable(s.binding)),receiptHash=await nativeRowHash(s.binding.receipt);
 if(previous?.phase==='pending'&&!forceNew&&(previous.originalBindingHash!==bindingHash||previous.manifestHash!==s.binding.manifestHash||previous.receiptHash!==receiptHash||previous.accountHash!==target.accountHash||previous.authKey!==options.auth.key))throw new ScopeRecoveryError('review');
 const revision=(previous?.revision??0)+1;if(!Number.isSafeInteger(revision))throw new ScopeRecoveryError('integrity');
 const session=parseOwnerResumeSession({id:'owner:active',kind:'owner-session',version:1,operationId:previous?.phase==='pending'&&!forceNew?previous.operationId:newInboxId(),revision,phase:'pending',problem:null,uploadId:s.binding.uploadId,businessId:s.binding.businessId,outletId:s.binding.outletId,actorId:s.binding.ownerId,targetHash:s.binding.targetHash,originalBindingHash:bindingHash,manifestHash:s.binding.manifestHash,receiptHash,authKey:options.auth.key,accountHash:target.accountHash,operatorRevision:s.operator?.revision??null});
 await db.transaction('rw',db.scopeRecoveries,db.cloudState,db.operatorState,async()=>{
  native(db,check);const binding=original(await db.cloudState.get('binding'));
  if(!equal(stable(binding),stable(s.binding))||!equal((await db.operatorState.get('active'))??null,s.operator)||!equal((await db.scopeRecoveries.get('owner:active'))??null,previousRaw??null))throw new ScopeRecoveryError('review');
  if(previous&&previous.operationId!==session.operationId){await db.scopeRecoveries.put({...previous,id:`owner:saved:${previous.operationId}`});native(db,check);}
  await db.scopeRecoveries.put(session);native(db,check);
 });
 try{
  const pinnedAuth={key:options.auth.key,commandAuthorization:getAuth,assertCommandAuthorization:account.assertCurrent};
  const enabled=await enableSync(db,{setup:s.setup,config,scope,auth:pinnedAuth,journal:options.journal,send:options.send,connectionCurrent:options.connectionCurrent,expectedOperatorRevision:s.operator?.revision??null},signal);check();
  const metadata=createOperatorRemote(config,getAuth,options.send),c=enabled.operator.connection!;
  const context=await metadata.select(parseOperatorContext({version:1,...parseSyncScope({...target,epoch:c.epoch,scopeVersion:c.scopeVersion}),businessName:null,outletName:null,actorName:null}),signal);check();
  if(context.role!=='owner'||context.epoch!==c.epoch||context.scopeVersion!==c.scopeVersion)throw new ScopeRecoveryError('review');
  return await db.transaction('rw',db.scopeRecoveries,db.cloudState,db.operatorState,db.syncSessions,async()=>{
   native(db,check);const current=parseOwnerResumeSession(await db.scopeRecoveries.get('owner:active')),binding=original(await db.cloudState.get('binding')),operator=parseLocalOperatorState(await db.operatorState.get('active')),sync=parseSyncSession(await db.syncSessions.get('active'));
   if(!equal(current,session)||!equal(stable(binding),stable(s.binding))||!equal(operator,enabled.operator)||operator.phase!=='active'||!equal(sync.target,target)||sync.operatorRevision!==operator.revision||sync.authKey!==options.auth.key||sync.epoch!==context.epoch||sync.scopeVersion!==context.scopeVersion||current.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError('review');
   const ready=parseOwnerResumeSession({...current,revision:current.revision+1,phase:'ready',problem:null,operatorRevision:operator.revision});await db.scopeRecoveries.put(ready);native(db,check);return ready;
  });
 }catch(error){await remember(db,session.operationId,error);throw error;}
}
export async function cancelOwnerResume(db:MiseDatabase){await db.transaction('rw',db.scopeRecoveries,db.syncSessions,async()=>{const raw=await db.scopeRecoveries.get('owner:active');if(!raw)return;const session=parseOwnerResumeSession(raw);if(session.phase!=='pending')return;if(session.revision===Number.MAX_SAFE_INTEGER)throw new ScopeRecoveryError('review');await pauseDelivery(db,session);await db.scopeRecoveries.put({...session,revision:session.revision+1,phase:'cancelled',problem:null});});}
