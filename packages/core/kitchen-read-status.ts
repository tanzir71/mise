import {isDeviceId} from './device-access';
import {parseScreenJournalRecord,type ScreenJournalRecord} from './device-screen-state';

/** A negative cache barrier, never permission to read or prepare an order. */
export interface KitchenReadStatus {
  v:1;id:string;revision:string;businessId:string;outletId:string;deviceId:string;
  sessionId:string;memberId:string;denied:boolean;
}
export function kitchenReadScope(input:ScreenJournalRecord){
  const record=parseScreenJournalRecord(input);if(record.state.phase!=='signed-in')throw Error('Use this screen’s current PIN.');
  const {device}=record.state.credential,{session}=record.state;
  return {id:`read-status:${device.id}:${session.id}`,businessId:device.businessId,outletId:device.outletId,deviceId:device.id,sessionId:session.id,memberId:session.memberId};
}
export function parseKitchenReadStatus(value:unknown,input:ScreenJournalRecord):KitchenReadStatus {
  const scope=kitchenReadScope(input);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Keep this screen’s saved access status.');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!=='businessId,denied,deviceId,id,memberId,outletId,revision,sessionId,v'||row.v!==1||!isDeviceId(row.revision)||typeof row.denied!=='boolean'||
      Object.entries(scope).some(([key,expected])=>row[key]!==expected))throw Error('Keep this screen’s saved access status.');
  return {v:1,...scope,revision:row.revision,denied:row.denied};
}
