import {isDeviceId} from '@mise/core/device-access';
import {parseLocalOperatorState} from '@mise/core/operators';
import {parseDeskApplicationKey,parseDeskPushMetadata,parseDeskPushSubscription,type DeskPushMetadata} from '@mise/core/desk-push';
import {parseDeskAlarmSettings} from '@mise/core/desk-tasks';
import type {DeskBinding} from './desk-cache';

export type DeskOperationRequest=
 |{kind:'register';subscriptionId:string;subscriptionHash:string;applicationKeyHash:string}
 |{kind:'revoke';subscriptionId:string}
 |{kind:'settings';enabled:boolean;minutes:number;revision:number};
export type DeskOperationReceipt=
 |{action:'register';id:string;eventId:string;subscription:DeskPushMetadata}
 |{action:'revoke';id:string;eventId:string;subscription:DeskPushMetadata|null}
 |{action:'settings';outletId:string;eventId:string;enabled:boolean;minutes:number;revision:number;expectedRevision:number;updatedAt:number};
export interface DeskOperation {v:1;id:string;profileId:string;binding:DeskBinding;selectionRevision:string;sequence:number;request:DeskOperationRequest;receipt:DeskOperationReceipt|null}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invalid=()=>Error('Keep this original notification action and open its current settings.');
export function parseDeskOperationRequest(value:unknown):DeskOperationRequest {
 if(!object(value))throw invalid();
 if(value.kind==='register'&&exact(value,'kind,subscriptionId,subscriptionHash,applicationKeyHash')&&isDeviceId(value.subscriptionId)&&hash(value.subscriptionHash)&&hash(value.applicationKeyHash))return {kind:'register',subscriptionId:value.subscriptionId,subscriptionHash:value.subscriptionHash,applicationKeyHash:value.applicationKeyHash};
 if(value.kind==='revoke'&&exact(value,'kind,subscriptionId')&&isDeviceId(value.subscriptionId))return {kind:'revoke',subscriptionId:value.subscriptionId};
 if(value.kind==='settings'&&exact(value,'kind,enabled,minutes,revision')){const settings=parseDeskAlarmSettings({enabled:value.enabled,minutes:value.minutes,revision:value.revision});if(settings.revision===Number.MAX_SAFE_INTEGER)throw invalid();return {kind:'settings',...settings};}
 throw invalid();
}
/** A read reporting absence cannot confirm a withdrawal. Only the original
 * mutation result, with its original event identity, closes this action. */
export function parseDeskOperationReceipt(value:unknown,operation:Pick<DeskOperation,'id'|'binding'|'request'>):DeskOperationReceipt {
 if(!object(value)||value.action!==operation.request.kind||value.eventId!==operation.id)throw invalid();
 const request=operation.request,binding=operation.binding;
 if(request.kind==='settings'){
  if(!exact(value,'action,outletId,eventId,enabled,minutes,revision,expectedRevision,updatedAt')||value.outletId!==binding.outletId||value.enabled!==request.enabled||value.minutes!==request.minutes||value.expectedRevision!==request.revision||value.revision!==request.revision+1||typeof value.updatedAt!=='number'||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||value.updatedAt>8640000000000000)throw invalid();
  return {action:'settings',outletId:binding.outletId,eventId:operation.id,...parseDeskAlarmSettings({enabled:value.enabled,minutes:value.minutes,revision:value.revision}),expectedRevision:request.revision,updatedAt:value.updatedAt};
 }
 if(!exact(value,'action,id,eventId,subscription')||value.id!==request.subscriptionId)throw invalid();
 const subscription=value.subscription===null?null:parseDeskPushMetadata(value.subscription);
 if(subscription&&(subscription.id!==request.subscriptionId||subscription.businessId!==binding.businessId||subscription.outletId!==binding.outletId||subscription.memberId!==binding.actorId))throw invalid();
 if(request.kind==='register'){if(!subscription||subscription.revokedAt!==null)throw invalid();return {action:'register',id:request.subscriptionId,eventId:operation.id,subscription};}
 if(subscription&&subscription.revokedAt===null)throw invalid();return {action:'revoke',id:request.subscriptionId,eventId:operation.id,subscription};
}
export function parseDeskOperation(value:unknown):DeskOperation {
 if(!object(value)||!exact(value,'v,id,profileId,binding,selectionRevision,sequence,request,receipt')||value.v!==1||!isDeviceId(value.id)||!isDeviceId(value.selectionRevision)||typeof value.sequence!=='number'||!Number.isSafeInteger(value.sequence)||value.sequence<1)throw invalid();
 const parsed=parseLocalOperatorState(value.binding);if(parsed.phase!=='active'||!parsed.connection)throw invalid();const binding=parsed as DeskBinding;
 const profileId='desk:'+binding.connection.targetHash+':'+binding.outletId+':'+binding.actorId,request=parseDeskOperationRequest(value.request);
 if(value.profileId!==profileId||request.kind!=='settings'&&request.subscriptionId===value.id)throw invalid();
 const base={v:1 as const,id:value.id,profileId,binding,selectionRevision:value.selectionRevision,sequence:value.sequence,request};
 return {...base,receipt:value.receipt===null?null:parseDeskOperationReceipt(value.receipt,base)};
}
async function registrationSource(input:{subscription:unknown;applicationKey:string},subtle:SubtleCrypto){
 // Snapshot both inputs before the first await; only their hashes enter IndexedDB.
 const subscription=parseDeskPushSubscription(input.subscription),applicationKey=parseDeskApplicationKey(input.applicationKey),encoder=new TextEncoder();
 const digest=async(value:string)=>Array.from(new Uint8Array(await subtle.digest('SHA-256',encoder.encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
 const [subscriptionHash,applicationKeyHash]=await Promise.all([digest(JSON.stringify(subscription)),digest(applicationKey)]);
 return {subscription,applicationKey,subscriptionHash,applicationKeyHash};
}
export async function deskRegistrationFingerprint(input:{subscription:unknown;applicationKey:string},subtle:SubtleCrypto=crypto.subtle){
 const source=await registrationSource(input,subtle);return {subscriptionHash:source.subscriptionHash,applicationKeyHash:source.applicationKeyHash};
}
/** Recover keys from the actual PushManager subscription for each retry. A
 * replacement endpoint/key must get a new setup, never rewrite the old action. */
export async function deskRegistrationPayload(value:DeskOperation,input:{subscription:unknown;applicationKey:string},subtle:SubtleCrypto=crypto.subtle){
 const operation=parseDeskOperation(value),source=await registrationSource(input,subtle),request=operation.request;
 if(request.kind!=='register'||request.subscriptionHash!==source.subscriptionHash||request.applicationKeyHash!==source.applicationKeyHash)throw invalid();
 return {id:request.subscriptionId,eventId:operation.id,subscription:source.subscription,applicationKey:source.applicationKey};
}
