import type {Business,Member,Outlet,SetupSnapshot} from './models';
import {parseSyncScope,syncHash,type SyncScope} from './sync-read';

export const localOperatorTableNames=['operatorState'] as const;
export type OperatorRole='owner'|'manager';
export interface OperatorContext extends SyncScope {version:1;businessName:string|null;outletName:string|null;actorName:string|null}
export interface OperatorPosition {businessId:string;outletId:string}
export interface OperatorPage {version:1;accountHash:string;contexts:OperatorContext[];next:OperatorPosition|null}
export interface LocalOperatorState {
 id:'active';version:1;revision:number;phase:'active'|'pending'|'locked';
 businessId:string;outletId:string;actorId:string;role:OperatorRole;
 connection:{targetHash:string;authKey:string;accountHash:string;epoch:string;scopeVersion:string}|null;
}
export interface OperatorChoice {businessId:string;outletId:string;actorId:string;role:OperatorRole;businessName:string;outletName:string;actorName:string}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export const operatorId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
export const operatorAuthKey=(v:unknown):v is string=>typeof v==='string'&&/^mise\.cloud\.auth\.[a-f0-9]{64}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export class OperatorContextError extends Error {constructor(message='Choose an active owner or manager for this outlet.'){super(message);}}
export function parseOperatorPosition(v:unknown):OperatorPosition|null {
 if(v===null)return null;if(!object(v)||!exact(v,'businessId,outletId')||!operatorId(v.businessId)||!operatorId(v.outletId))throw new OperatorContextError('Keep the original outlet list position.');return {businessId:v.businessId,outletId:v.outletId};
}
export function parseOperatorContext(v:unknown):OperatorContext {
 if(!object(v)||!exact(v,'version,businessId,outletId,actorId,accountHash,role,epoch,scopeVersion,businessName,outletName,actorName')||v.version!==1||!['businessName','outletName','actorName'].every(k=>v[k]===null||typeof v[k]==='string'&&(v[k] as string).length<=4096))throw new OperatorContextError('The outlet access review is unconfirmed.');
 return {...parseSyncScope(v),version:1,businessName:v.businessName as string|null,outletName:v.outletName as string|null,actorName:v.actorName as string|null};
}
export function parseOperatorPage(v:unknown,accountHash:string,after:OperatorPosition|null,limit:number):OperatorPage {
 if(!object(v)||!exact(v,'version,accountHash,contexts,next')||v.version!==1||v.accountHash!==accountHash||!hash(accountHash)||!Array.isArray(v.contexts)||v.contexts.length>limit)throw new OperatorContextError('The signed-in account changed. Review its outlets again.');
 const contexts=v.contexts.map(parseOperatorContext),next=parseOperatorPosition(v.next);let previous=after;
 for(const c of contexts){if(c.accountHash!==accountHash||previous&&(c.businessId<previous.businessId||c.businessId===previous.businessId&&c.outletId<=previous.outletId))throw new OperatorContextError('Keep the current account and outlet list order.');previous=c;}
 if(next&&(!contexts.length||contexts.length!==limit||next.businessId!==previous!.businessId||next.outletId!==previous!.outletId))throw new OperatorContextError('The outlet list is incomplete.');
 return {version:1,accountHash,contexts,next};
}
/** Match PostgreSQL SHA256(uuid_send(uuid)); never persist the original Auth UUID. */
export async function operatorAccountHash(uuid:string):Promise<string> {
 if(typeof uuid!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))throw new OperatorContextError('Use the verified phone account.');
 return syncHash(Uint8Array.from(uuid.replaceAll('-','').match(/../g)!,part=>parseInt(part,16)));
}
export function operatorChoices(businesses:readonly Business[],outlets:readonly Outlet[],members:readonly Member[]):OperatorChoice[] {
 const result:OperatorChoice[]=[];
 for(const member of members){if(!member.active||!['owner','manager'].includes(member.role))continue;const business=businesses.find(b=>b.id===member.businessId);if(!business)continue;
  for(const outlet of outlets)if(outlet.businessId===business.id&&(member.role==='owner'||member.outletIds.includes(outlet.id)))result.push({businessId:business.id,outletId:outlet.id,actorId:member.id,role:member.role as OperatorRole,businessName:business.name,outletName:outlet.name,actorName:member.name});
 }
 return result.sort((a,b)=>a.businessId.localeCompare(b.businessId)||a.outletId.localeCompare(b.outletId)||a.actorId.localeCompare(b.actorId));
}
export function parseLocalOperatorState(v:unknown):LocalOperatorState {
 if(!object(v)||!exact(v,'id,version,revision,phase,businessId,outletId,actorId,role,connection')||v.id!=='active'||v.version!==1||!Number.isSafeInteger(v.revision)||(v.revision as number)<1||!['active','pending','locked'].includes(v.phase as string)||![v.businessId,v.outletId,v.actorId].every(operatorId)||!['owner','manager'].includes(v.role as string))throw new OperatorContextError('The saved operator needs review. Keep your local records.');
 let connection:LocalOperatorState['connection']=null;
 if(v.connection!==null){const c=v.connection;if(!object(c)||!exact(c,'targetHash,authKey,accountHash,epoch,scopeVersion')||!hash(c.targetHash)||!operatorAuthKey(c.authKey))throw new OperatorContextError('Keep the original account connection.');try{parseSyncScope({...v,accountHash:c.accountHash,epoch:c.epoch,scopeVersion:c.scopeVersion});}catch{throw new OperatorContextError('Keep the original account connection.');}connection={targetHash:c.targetHash,authKey:c.authKey,accountHash:c.accountHash as string,epoch:c.epoch as string,scopeVersion:c.scopeVersion as string};}
 return {id:'active',version:1,revision:v.revision as number,phase:v.phase as LocalOperatorState['phase'],businessId:v.businessId as string,outletId:v.outletId as string,actorId:v.actorId as string,role:v.role as OperatorRole,connection};
}
export function resolveOperator(businesses:readonly Business[],outlets:readonly Outlet[],members:readonly Member[],state:LocalOperatorState|null):SetupSnapshot|null {
 if(!businesses.length&&!state)return null;
 if(state&&state.phase!=='active')throw new OperatorContextError(state.phase==='pending'?'Finish the connection before working in this outlet.':'Choose an operator before continuing on this device.');
 if(!state){
  if(businesses.length!==1||outlets.length!==1||members.length!==1||members[0].role!=='owner')throw new OperatorContextError();
  const [business]=businesses,[outlet]=outlets,[owner]=members;
  if(!owner.active||owner.businessId!==business.id||outlet.businessId!==business.id)throw new OperatorContextError();return {business,outlet,owner};
 }
 const business=businesses.find(b=>b.id===state.businessId),outlet=outlets.find(o=>o.id===state.outletId),owner=members.find(m=>m.id===state.actorId);
 if(!business||!outlet||!owner||outlet.businessId!==business.id||owner.businessId!==business.id||!owner.active||owner.role!==state.role||!(owner.role==='owner'||owner.outletIds.includes(outlet.id)))throw new OperatorContextError('This operator is no longer active in the selected outlet. Keep local work and review access.');
 return {business,outlet,owner};
}
