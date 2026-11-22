import {isDeviceId} from './device-access';
import {isKitchenPreparation,kitchenAlarmStart} from './kitchen-preparation';
import type {KitchenTicket} from './kitchen-tickets';

/** Pure timing rules for a server-owned kitchen alarm.
 * The caller must supply a fresh scoped server ticket with its current ACK. */
export interface KitchenAlarmSettings {enabled:boolean;minutes:number}
export interface KitchenAlarmEvaluation {
 v:1;businessId:string;outletId:string;orderId:string;sourceRevision:number;contentHash:string;
 at:number;dueAt:number;state:'disabled'|'cancelled'|'finished'|'acknowledged'|'waiting'|'due';acknowledgementId:string|null;
}
const maximumTime=8640000000000000;
const time=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=maximumTime;
export function parseKitchenAlarmSettings(input:unknown):KitchenAlarmSettings {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='enabled,minutes')throw Error('Use the current kitchen alarm settings.');
 const value=input as Record<string,unknown>;
 if(typeof value.enabled!=='boolean'||typeof value.minutes!=='number'||!Number.isInteger(value.minutes)||value.minutes<1||value.minutes>1440)throw Error('Choose a kitchen warning between 1 and 1440 minutes.');
 return {enabled:value.enabled,minutes:value.minutes};
}
export function evaluateKitchenAlarm(ticket:KitchenTicket,settings:KitchenAlarmSettings,scope:{businessId:string;outletId:string},at:number):KitchenAlarmEvaluation {
 settings=parseKitchenAlarmSettings(settings);
 const dueAt=kitchenAlarmStart(ticket)+settings.minutes*60000;
 if(!isDeviceId(scope.businessId)||!isDeviceId(scope.outletId)||ticket.outletId!==scope.outletId||!time(at)||!time(ticket.createdAt)||ticket.scheduledFor!==undefined&&!time(ticket.scheduledFor)||!time(dueAt))throw Error('Use the current scoped preparation ticket.');
 const ack=ticket.acknowledgement;
 if(ack&&(ack.type!=='kitchen.acknowledge'||ack.businessId!==scope.businessId||ack.outletId!==scope.outletId||ack.orderId!==ticket.id||
    ack.contentHash!==ticket.contentHash||ack.revision>ticket.revision||ack.acceptedAt>at))throw Error('Keep the actual current acknowledgement with its original ticket.');
 const state=!settings.enabled?'disabled':ticket.status==='cancelled'?'cancelled':!isKitchenPreparation(ticket)?'finished':ack?'acknowledged':at<dueAt?'waiting':'due';
 return {v:1,...scope,orderId:ticket.id,sourceRevision:ticket.revision,contentHash:ticket.contentHash,at,dueAt,state,acknowledgementId:ack?.id??null};
}
