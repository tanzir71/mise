import {isDeviceId} from './device-access';
import {parseDeskPushContext,type DeskPushContext} from './desk-push';
import {parseOwnerTask,type OwnerTask} from './owner-tasks';

export interface UrgentInboxConsent extends DeskPushContext {
 id:string;subscriptionId:string;createdAt:number;revokedAt:number|null;
}
export interface UrgentInboxClosure {
 v:1;id:string;eventId:string;closedAt:number;consent:UrgentInboxConsent|null;
}
export interface UrgentInboxRegistration {
 v:1;id:string;eventId:string;at:number;consent:UrgentInboxConsent;
}
export interface UrgentInboxNotice {
 v:1;type:'urgent-inbox';consentId:string;subscriptionId:string;
 businessId:string;outletId:string;taskId:string;generation:number;
}
export interface UrgentInboxTarget {
 v:1;at:number;scope:DeskPushContext;notice:UrgentInboxNotice;
 currentGeneration:number;active:boolean;task:OwnerTask;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const invalid=()=>Error('Keep the original urgent notification choice.');
export function parseUrgentInboxConsent(input:unknown):UrgentInboxConsent {
 if(!object(input)||!exact(input,'v,id,subscriptionId,businessId,outletId,memberId,role,createdAt,revokedAt')||![input.id,input.subscriptionId].every(isDeviceId)||!time(input.createdAt)||input.revokedAt!==null&&(!time(input.revokedAt)||input.revokedAt<input.createdAt))throw invalid();
 const scope=parseDeskPushContext({v:input.v,businessId:input.businessId,outletId:input.outletId,memberId:input.memberId,role:input.role});
 return {...scope,id:input.id as string,subscriptionId:input.subscriptionId as string,createdAt:input.createdAt,revokedAt:input.revokedAt as number|null};
}
export function parseUrgentInboxClosure(input:unknown,id:string,eventId:string):UrgentInboxClosure {
 if(!isDeviceId(id)||!isDeviceId(eventId)||id===eventId||!object(input)||!exact(input,'v,id,eventId,closedAt,consent')||input.v!==1||input.id!==id||input.eventId!==eventId||!time(input.closedAt))throw invalid();
 const consent=input.consent===null?null:parseUrgentInboxConsent(input.consent);
 if(consent&&(consent.id!==id||consent.revokedAt===null||consent.revokedAt<input.closedAt))throw invalid();
 return {v:1,id,eventId,closedAt:input.closedAt,consent};
}
export function parseUrgentInboxRegistration(input:unknown,id:string,subscriptionId:string,eventId:string):UrgentInboxRegistration {
 if(![id,subscriptionId,eventId].every(isDeviceId)||!object(input)||!exact(input,'v,id,eventId,at,consent')||input.v!==1||input.id!==id||input.eventId!==eventId||!time(input.at))throw invalid();
 const consent=parseUrgentInboxConsent(input.consent);if(consent.id!==id||consent.subscriptionId!==subscriptionId||consent.createdAt!==input.at||consent.revokedAt!==null)throw invalid();
 return {v:1,id,eventId,at:input.at,consent};
}
/** No customer text, amount, endpoint, credential, or caller-chosen URL. */
export function parseUrgentInboxNotice(input:unknown):UrgentInboxNotice {
 if(!object(input)||!exact(input,'v,type,consentId,subscriptionId,businessId,outletId,taskId,generation')||input.v!==1||input.type!=='urgent-inbox'||![input.consentId,input.subscriptionId,input.businessId,input.outletId,input.taskId].every(isDeviceId)||typeof input.generation!=='number'||!Number.isSafeInteger(input.generation)||input.generation<1)throw invalid();
 return {v:1,type:'urgent-inbox',consentId:input.consentId as string,subscriptionId:input.subscriptionId as string,businessId:input.businessId as string,outletId:input.outletId as string,taskId:input.taskId as string,generation:input.generation};
}
export function parseUrgentInboxTarget(input:unknown,notice:UrgentInboxNotice):UrgentInboxTarget {
 const expected=parseUrgentInboxNotice(notice);
 if(!object(input)||!exact(input,'v,at,scope,notice,currentGeneration,active,task')||input.v!==1||!time(input.at)||typeof input.active!=='boolean'||typeof input.currentGeneration!=='number'||!Number.isSafeInteger(input.currentGeneration)||input.currentGeneration<expected.generation)throw invalid();
 const actual=parseUrgentInboxNotice(input.notice),scope=parseDeskPushContext(input.scope),task=parseOwnerTask(input.task,scope);
 if(JSON.stringify(actual)!==JSON.stringify(expected)||scope.businessId!==actual.businessId||scope.outletId!==actual.outletId||task.id!==actual.taskId||input.active&&(input.currentGeneration!==actual.generation||!task.urgent||!['open','waiting'].includes(task.status)))throw invalid();
 return {v:1,at:input.at,scope,notice:actual,currentGeneration:input.currentGeneration,active:input.active,task};
}
