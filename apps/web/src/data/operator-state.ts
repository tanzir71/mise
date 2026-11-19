import {operatorChoices,operatorAuthKey,parseLocalOperatorState,parseOperatorContext,resolveOperator,OperatorContextError,type LocalOperatorState,type OperatorContext,type OperatorChoice} from '@mise/core/operators';
import {parseLocalCloudState} from '@mise/core/local-outbox';
import type {LocalStore} from './local-store';
import type {SetupSnapshot} from '@mise/core/models';
import {parseSyncScope} from '@mise/core/sync-read';
import {syncDownloadToken} from '@mise/core/sync-download';
import {assertCanonicalState,readCanonicalState} from './cloud-canonical-state';

export interface LocalWorkspace {setup:SetupSnapshot|null;selection:LocalOperatorState|null;choices:OperatorChoice[];message:string;requiresSelection:boolean;cloudBound:boolean}
export async function readLocalWorkspace(db:LocalStore):Promise<LocalWorkspace> {
 return db.transaction('r',db.businesses,db.outlets,db.members,db.operatorState,db.cloudState,async()=>{
  const [businesses,outlets,members,saved,binding]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray(),db.operatorState.get('active'),db.cloudState.get('binding')]);
  let cloudBound=binding!==undefined&&parseLocalCloudState(binding).phase!=='cancelled';const choices=operatorChoices(businesses,outlets,members);let selection:LocalOperatorState|null=null;
  try{selection=saved===undefined?null:parseLocalOperatorState(saved);cloudBound=cloudBound||selection?.connection!==null&&selection?.connection!==undefined;return {setup:resolveOperator(businesses,outlets,members,selection),selection,choices,message:'',requiresSelection:false,cloudBound};}
  catch(error){if(!(error instanceof OperatorContextError))throw error;return {setup:null,selection,choices,message:error.message,requiresSelection:businesses.length>0||saved!==undefined,cloudBound};}
 });
}
function nextRevision(saved:unknown,expected:number|null){const previous=saved===undefined?null:parseLocalOperatorState(saved);if((previous?.revision??null)!==expected)throw new OperatorContextError('The operator changed in another tab. Review the current selection.');if(previous?.revision===Number.MAX_SAFE_INTEGER)throw new OperatorContextError('Keep a backup before changing this operator.');return (previous?.revision??0)+1;}
export async function selectLocalOperator(db:LocalStore,choice:Pick<OperatorChoice,'businessId'|'outletId'|'actorId'>,expectedRevision:number|null):Promise<LocalOperatorState> {
 choice=structuredClone(choice);
 return db.transaction('rw',db.operatorState,db.cloudState,db.businesses,db.outlets,db.members,async()=>{
  const saved=await db.operatorState.get('active'),revision=nextRevision(saved,expectedRevision),binding=await db.cloudState.get('binding');if(saved?.connection||binding&&parseLocalCloudState(binding).phase!=='cancelled')throw new OperatorContextError('Use the verified cloud account to change this operator.');
  const [businesses,outlets,members]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray()]),candidate=operatorChoices(businesses,outlets,members).find(c=>c.businessId===choice.businessId&&c.outletId===choice.outletId&&c.actorId===choice.actorId);if(!candidate)throw new OperatorContextError();
  const state:LocalOperatorState={id:'active',version:1,revision,phase:'active',businessId:candidate.businessId,outletId:candidate.outletId,actorId:candidate.actorId,role:candidate.role,connection:null};resolveOperator(businesses,outlets,members,state);await db.operatorState.put(state);return state;
 });
}
/** Fresh server selection establishes identity; a real write fence is still required to activate it. */
export async function selectCloudOperator(db:LocalStore,input:OperatorContext,connection:{targetHash:string;authKey:string},expectedRevision:number|null,refresh:(context:OperatorContext)=>Promise<OperatorContext>):Promise<LocalOperatorState> {
 const original=parseOperatorContext(input),{targetHash,authKey}=connection;if(!/^[a-f0-9]{64}$/.test(targetHash)||!operatorAuthKey(authKey))throw new OperatorContextError('Keep the original connection fingerprint.');
 const context=parseOperatorContext(await refresh(structuredClone(original)));for(const k of ['businessId','outletId','actorId','accountHash']as const)if(context[k]!==original[k])throw new OperatorContextError('The signed-in account or outlet changed. Review it again.');
 const preliminary=await db.cloudState.get('binding'),candidate=preliminary===undefined?null:parseLocalCloudState(preliminary),same=candidate?.targetHash===targetHash&&candidate.businessId===context.businessId&&candidate.outletId===context.outletId&&candidate.ownerId===context.actorId,hasBase=await db.syncCanonical.get('active'),canonical=same&&(candidate?.version===2||hasBase)?await readCanonicalState(db):null;
 return db.transaction('rw',[db.operatorState,db.cloudState,db.syncCanonical,db.syncApplications,db.syncAdmissions,db.businesses,db.outlets,db.members],async()=>{
  const saved=await db.operatorState.get('active'),revision=nextRevision(saved,expectedRevision),raw=await db.cloudState.get('binding'),binding=raw===undefined?null:parseLocalCloudState(raw);
  let phase:LocalOperatorState['phase']='pending';
  if(!canonical&&!hasBase&&binding?.phase==='ready'&&binding.receipt&&binding.targetHash===targetHash&&binding.businessId===context.businessId&&binding.outletId===context.outletId&&binding.ownerId===context.actorId)phase='active';
  if(canonical){await assertCanonicalState(db,canonical);if(syncDownloadToken(canonical.base.snapshot.scope)===syncDownloadToken(parseSyncScope(context)))phase='active';}
  const state:LocalOperatorState={id:'active',version:1,revision,phase,businessId:context.businessId,outletId:context.outletId,actorId:context.actorId,role:context.role,connection:{targetHash,authKey,accountHash:context.accountHash,epoch:context.epoch,scopeVersion:context.scopeVersion}};
  if(phase==='active'){const [businesses,outlets,members]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray()]);resolveOperator(businesses,outlets,members,state);}
  await db.operatorState.put(state);return state;
 });
}
/** Locking retains scope evidence and never falls back to the first cached owner. */
export async function lockLocalOperator(db:LocalStore,expectedRevision:number):Promise<void> {await db.transaction('rw',db.operatorState,async()=>{const saved=await db.operatorState.get('active'),revision=nextRevision(saved,expectedRevision);if(!saved)throw new OperatorContextError();await db.operatorState.put({...parseLocalOperatorState(saved),revision,phase:'locked'});});}
