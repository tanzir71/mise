import {isDeviceId,parseStaffDeviceAccess,type SharedDevice,type StaffDeviceAccess,type StaffDeviceSession} from './device-access';
import {parseKitchenAction,parseKitchenReceipt,type KitchenAction,type KitchenReceipt} from './kitchen';

export interface RetainedKitchenTap {action:KitchenAction;sessionId:string;memberId:string}
export interface KitchenCloseIntent {id:string;access:StaffDeviceAccess;occurredAt:number}
export interface KitchenCloseRequest {id:string;sessionId:string;memberId:string;occurredAt:number}
/** Closing a saved intent is not a preparation acknowledgement. The original
 * action/source remains available and the current order is never modified. */
export interface KitchenTapClosure {
  v:1;id:string;type:'kitchen.tap-closed';businessId:string;outletId:string;deviceId:string;
  originalSessionId:string;originalMemberId:string;action:KitchenAction;
  sessionId:string;memberId:string;occurredAt:number;closedAt:number;
}
export interface KitchenTapRecovery {
  v:1;access:StaffDeviceAccess;at:number;original:RetainedKitchenTap;
  outcome:'pending'|'accepted'|'closed';receipt:KitchenReceipt|null;closure:KitchenTapClosure|null;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const invalid=()=>Error('Keep the original saved tap and review its current ticket.');
const sameAction=(a:KitchenAction,b:KitchenAction)=>JSON.stringify(parseKitchenAction(a))===JSON.stringify(parseKitchenAction(b));

export function parseRetainedKitchenTap(value:unknown):RetainedKitchenTap {
  if(!object(value)||!exact(value,'action,sessionId,memberId')||!isDeviceId(value.sessionId)||!isDeviceId(value.memberId))throw invalid();
  return {action:parseKitchenAction(value.action),sessionId:value.sessionId,memberId:value.memberId};
}
export function retainedKitchenTap(tap:{action:KitchenAction;access:StaffDeviceAccess}):RetainedKitchenTap {
  return parseRetainedKitchenTap({action:tap.action,sessionId:tap.access.sessionId,memberId:tap.access.memberId});
}
export function parseKitchenCloseRequest(value:unknown,action:KitchenAction):KitchenCloseRequest {
  if(!object(value)||!exact(value,'id,sessionId,memberId,occurredAt')||![value.id,value.sessionId,value.memberId].every(isDeviceId)||
      !time(value.occurredAt)||[action.id,action.orderId,action.outletId,...action.transitionEventIds,action.parentAckId].includes(value.id as string))throw invalid();
  return {id:value.id as string,sessionId:value.sessionId as string,memberId:value.memberId as string,occurredAt:value.occurredAt};
}
export function parseKitchenCloseIntent(value:unknown,action:KitchenAction,scope:StaffDeviceAccess,originalMemberId:string):KitchenCloseIntent {
  if(!object(value)||!exact(value,'id,access,occurredAt')||!isDeviceId(value.id)||!isDeviceId(originalMemberId)||!time(value.occurredAt)||
      [action.id,action.orderId,action.outletId,...action.transitionEventIds,action.parentAckId].includes(value.id))throw invalid();
  const access=parseStaffDeviceAccess(value.access);
  if(access.deviceId!==scope.deviceId||access.businessId!==scope.businessId||access.outletId!==scope.outletId||
      (access.memberId!==originalMemberId&&(!access.permissions.includes('orders.read')||
        !access.permissions.includes(action.type==='kitchen.acknowledge'?'orders.acknowledge':'orders.ready')||value.occurredAt>=access.expiresAt)))throw invalid();
  return {id:value.id,access,occurredAt:value.occurredAt};
}
export function parseKitchenTapClosure(value:unknown,original:RetainedKitchenTap,scope:StaffDeviceAccess):KitchenTapClosure {
  original=parseRetainedKitchenTap(original);
  if(!object(value)||!exact(value,'v,id,type,businessId,outletId,deviceId,originalSessionId,originalMemberId,action,sessionId,memberId,occurredAt,closedAt')||
      value.v!==1||value.type!=='kitchen.tap-closed'||![value.id,value.sessionId,value.memberId].every(isDeviceId)||
      value.businessId!==scope.businessId||value.outletId!==scope.outletId||value.deviceId!==scope.deviceId||
      value.originalSessionId!==original.sessionId||value.originalMemberId!==original.memberId||
      [original.action.id,original.action.orderId,original.action.outletId,...original.action.transitionEventIds,original.action.parentAckId].includes(value.id as string)||
      !time(value.occurredAt)||!time(value.closedAt)||value.occurredAt>value.closedAt+300000)throw invalid();
  const action=parseKitchenAction(value.action);if(!sameAction(action,original.action))throw invalid();
  return {v:1,id:value.id as string,type:'kitchen.tap-closed',businessId:scope.businessId,outletId:scope.outletId,deviceId:scope.deviceId,
    originalSessionId:original.sessionId,originalMemberId:original.memberId,action,
    sessionId:value.sessionId as string,memberId:value.memberId as string,occurredAt:value.occurredAt,closedAt:value.closedAt};
}
export function parseKitchenTapRecovery(value:unknown,original:RetainedKitchenTap,expected?:{device:SharedDevice;session:StaffDeviceSession}):KitchenTapRecovery {
  original=parseRetainedKitchenTap(original);
  if(!object(value)||!exact(value,'v,access,at,original,outcome,receipt,closure')||value.v!==1||!time(value.at)||
      !['pending','accepted','closed'].includes(value.outcome as string))throw invalid();
  const access=parseStaffDeviceAccess(value.access,expected),reported=parseRetainedKitchenTap(value.original);
  if((!access.permissions.includes('orders.read')&&access.memberId!==original.memberId)||value.at>=access.expiresAt||access.outletId!==original.action.outletId||
      reported.sessionId!==original.sessionId||reported.memberId!==original.memberId||!sameAction(reported.action,original.action))throw invalid();
  let receipt:KitchenReceipt|null=null,closure:KitchenTapClosure|null=null;
  if(value.outcome==='accepted') {
    if(value.closure!==null)throw invalid();receipt=parseKitchenReceipt(value.receipt,{action:original.action});
    if(receipt.businessId!==access.businessId||receipt.outletId!==access.outletId||receipt.deviceId!==access.deviceId||
        receipt.sessionId!==original.sessionId||receipt.memberId!==original.memberId||receipt.acceptedAt>value.at)throw invalid();
  } else if(value.outcome==='closed') {
    if(value.receipt!==null)throw invalid();closure=parseKitchenTapClosure(value.closure,original,access);if(closure.closedAt>value.at)throw invalid();
  } else if(value.receipt!==null||value.closure!==null)throw invalid();
  return {v:1,access,at:value.at,original,outcome:value.outcome as KitchenTapRecovery['outcome'],receipt,closure};
}
