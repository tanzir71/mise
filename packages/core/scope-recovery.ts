import {parseBackup} from './backup';
import type {MiseBackup} from './backup-tables';
import {parseLocalCloudState,type LocalCloudState} from './local-outbox';
import {operatorAuthKey,operatorId,parseLocalOperatorState,type LocalOperatorState} from './operators';
import {parseSyncScope,type SyncScope} from './sync-read';
import {parseSyncDownloadTarget,type SyncDownloadTarget} from './sync-download';
import {materializationHash,workingSnapshotHash} from './sync-materialize';
import type {OwnerResumeSession} from './owner-resume';

export const localRecoveryTableNames=['scopeRecoveries'] as const;
export type RecoveryProblem='auth'|'retry'|'review'|'integrity';
export class ScopeRecoveryError extends Error {
 constructor(readonly kind:RecoveryProblem='review'){
  super(kind==='auth'?'Verify the original account for this outlet.':kind==='retry'?'Recovery is unconfirmed. Your original shop and download are kept.':kind==='integrity'?'Keep the original shop and recovery records. Their saved evidence needs review.':'Review this outlet and its saved actions before applying changes.');
 }
}
export interface ScopeRecoverySession {
 id:'active'|`saved:${string}`;kind:'session';version:1;operationId:string;revision:number;
 phase:'pending'|'paused'|'admitted'|'ready'|'cancelled';problem:RecoveryProblem|null;
 originalBindingHash:string;originalBaseHash:string;originalScope:SyncScope;
 target:SyncDownloadTarget;epoch:string;scopeVersion:string;authKey:string;
 expectedOperatorRevision:number;readId:string;admissionHash:string|null;
}
export interface ScopeRecoveryAdmission {
 id:`admission:${string}`;kind:'admission';version:1;operationId:string;
 source:{binding:LocalCloudState;operator:LocalOperatorState;scope:SyncScope;baseHash:string;applicationHash:string|null;working:MiseBackup;workingHash:string;queueHash:string;sequence:number};
 target:{scope:SyncScope;targetHash:string;readId:string;readSourceHash:string;readSeal:string;cursor:string;canonicalHash:string;applicationHash:string};
 previousRecoveryHash:string|null;hash:string;
}
export type ScopeRecoveryRecord=ScopeRecoverySession|ScopeRecoveryAdmission|OwnerResumeSession;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,fields:string)=>Object.keys(v).sort().join(',')===fields.split(',').sort().join(',');
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
function scope(v:unknown){if(!object(v)||!exact(v,'businessId,outletId,actorId,accountHash,role,epoch,scopeVersion'))throw new ScopeRecoveryError('integrity');return parseSyncScope(v);}
export function sameRecoveryIdentity(a:SyncScope,b:SyncScope){return ['businessId','outletId','actorId','accountHash'].every(k=>a[k as keyof SyncScope]===b[k as keyof SyncScope]);}
export function parseScopeRecoverySession(v:unknown):ScopeRecoverySession {
 try{
  if(!object(v)||!exact(v,'id,kind,version,operationId,revision,phase,problem,originalBindingHash,originalBaseHash,originalScope,target,epoch,scopeVersion,authKey,expectedOperatorRevision,readId,admissionHash')||v.kind!=='session'||v.version!==1||!operatorId(v.operationId)||v.id!=='active'&&v.id!=='saved:'+v.operationId||!positive(v.revision)||!positive(v.expectedOperatorRevision)||!['pending','paused','admitted','ready','cancelled'].includes(v.phase as string)||v.problem!==null&&!['auth','retry','review','integrity'].includes(v.problem as string)||![v.originalBindingHash,v.originalBaseHash].every(hash)||!operatorId(v.readId)||!operatorAuthKey(v.authKey)||v.admissionHash!==null&&!hash(v.admissionHash)||(['admitted','ready'].includes(v.phase as string))!==(v.admissionHash!==null))throw Error();
  const originalScope=scope(v.originalScope),target=parseSyncDownloadTarget(v.target),current=parseSyncScope({...target,epoch:v.epoch,scopeVersion:v.scopeVersion});
  if(!sameRecoveryIdentity(originalScope,current))throw Error();
  return {...v,originalScope,target,epoch:current.epoch,scopeVersion:current.scopeVersion} as unknown as ScopeRecoverySession;
 }catch{throw new ScopeRecoveryError('integrity');}
}
export function parseScopeRecoveryAdmission(v:unknown):ScopeRecoveryAdmission {
 try{
  if(!object(v)||!exact(v,'id,kind,version,operationId,source,target,previousRecoveryHash,hash')||v.kind!=='admission'||v.version!==1||!operatorId(v.operationId)||v.id!=='admission:'+v.operationId||!hash(v.hash)||v.previousRecoveryHash!==null&&!hash(v.previousRecoveryHash)||!object(v.source)||!exact(v.source,'binding,operator,scope,baseHash,applicationHash,working,workingHash,queueHash,sequence')||!object(v.target)||!exact(v.target,'scope,targetHash,readId,readSourceHash,readSeal,cursor,canonicalHash,applicationHash'))throw Error();
  const s=v.source,t=v.target,binding=parseLocalCloudState(s.binding),operator=parseLocalOperatorState(s.operator),old=scope(s.scope),fresh=scope(t.scope),working=parseBackup(s.working);
  if(!sameRecoveryIdentity(old,fresh)||![s.baseHash,s.workingHash,s.queueHash,t.targetHash,t.readSourceHash,t.readSeal,t.canonicalHash,t.applicationHash].every(hash)||s.applicationHash!==null&&!hash(s.applicationHash)||!Number.isSafeInteger(s.sequence)||s.sequence!==binding.sequence||!operatorId(t.readId)||typeof t.cursor!=='string'||!t.cursor||t.cursor.length>131072||binding.phase!=='ready'||binding.targetHash!==t.targetHash||binding.businessId!==old.businessId||binding.outletId!==old.outletId||binding.ownerId!==old.actorId||operator.businessId!==old.businessId||operator.outletId!==old.outletId||operator.actorId!==old.actorId||operator.connection?.accountHash!==old.accountHash||operator.connection.targetHash!==binding.targetHash||v.previousRecoveryHash!==(binding.recovery?.hash??null))throw Error();
  return {...v,source:{...s,binding,operator,scope:old,working},target:{...t,scope:fresh}} as unknown as ScopeRecoveryAdmission;
 }catch{throw new ScopeRecoveryError('integrity');}
}
export function scopeRecoveryHash(value:Omit<ScopeRecoveryAdmission,'hash'>){return materializationHash(value);}
export async function verifyScopeRecoveryAdmission(value:unknown){const row=parseScopeRecoveryAdmission(value),{hash:stored,...unsigned}=row;if(await scopeRecoveryHash(unsigned)!==stored||await workingSnapshotHash(row.source.working)!==row.source.workingHash)throw new ScopeRecoveryError('integrity');return row;}
