import {operatorAuthKey,operatorId} from './operators';
import {ScopeRecoveryError,type RecoveryProblem} from './scope-recovery';

/** Control-only resumption of an already accepted initial owner upload. */
export interface OwnerResumeSession {
 id:'owner:active'|`owner:saved:${string}`;kind:'owner-session';version:1;
 operationId:string;revision:number;phase:'pending'|'ready'|'cancelled';problem:RecoveryProblem|null;
 uploadId:string;businessId:string;outletId:string;actorId:string;targetHash:string;
 originalBindingHash:string;manifestHash:string;receiptHash:string;authKey:string;accountHash:string;
 operatorRevision:number|null;
}
const keys='id,kind,version,operationId,revision,phase,problem,uploadId,businessId,outletId,actorId,targetHash,originalBindingHash,manifestHash,receiptHash,authKey,accountHash,operatorRevision';
export function parseOwnerResumeSession(value:unknown):OwnerResumeSession {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ScopeRecoveryError('integrity');
 const v=value as Record<string,unknown>,hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),positive=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
 if(Object.keys(v).sort().join(',')!==keys.split(',').sort().join(',')||v.kind!=='owner-session'||v.version!==1||!operatorId(v.operationId)||v.id!=='owner:active'&&v.id!=='owner:saved:'+v.operationId||!positive(v.revision)||!['pending','ready','cancelled'].includes(v.phase as string)||v.problem!==null&&!['auth','retry','review','integrity'].includes(v.problem as string)||![v.uploadId,v.businessId,v.outletId,v.actorId].every(operatorId)||![v.targetHash,v.originalBindingHash,v.manifestHash,v.receiptHash,v.accountHash].every(hash)||!operatorAuthKey(v.authKey)||v.operatorRevision!==null&&!positive(v.operatorRevision)||v.phase==='ready'&&v.operatorRevision===null)throw new ScopeRecoveryError('integrity');
 return v as unknown as OwnerResumeSession;
}
