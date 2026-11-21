import type {CustomerInput} from './customers';
import type {CreditTermsInput} from './khata';
/** Reserve every possible companion ID once on the originating device. */
export interface CustomerRecordIds {accountId:string;accountEventId:string;openingEntryId:string;openingEventId:string}
export type CustomerCommand=
  |{id:string;type:'customer.create'|'customer.update';customerId:string;outletId:string;input:CustomerInput;credit:CreditTermsInput|null;opening:{amount:number;occurredAt:number}|null;ids:CustomerRecordIds}
  |{id:string;type:'customer.archive'|'customer.restore';customerId:string;outletId:string}
  |{id:string;type:'khata.settings';customerId:string;outletId:string;accountId:string|null;input:CreditTermsInput;ids:CustomerRecordIds};
export interface CustomerCommandReceipt {id:string;type:CustomerCommand['type'];customerId:string;outletId:string;accountId:string|null;accountEventId:string|null;entryId:string|null;openingEventId:string|null;at:number;customerUpdatedAt:number;accountUpdatedAt:number|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,max=8640000000000000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
function terms(v:unknown):CreditTermsInput {
  if(!object(v)||!exact(v,'allowed,limit,reminder')||typeof v.allowed!=='boolean'||!integer(v.limit,Number.MAX_SAFE_INTEGER)||!object(v.reminder)||!exact(v.reminder,'channel,dayOfMonth,enabled,tone')||typeof v.reminder.enabled!=='boolean'||!integer(v.reminder.dayOfMonth,31)||v.reminder.dayOfMonth<1||!['gentle','direct'].includes(v.reminder.tone as string)||v.reminder.channel!=='whatsapp')throw new Error('Check the credit terms.');
  return {allowed:v.allowed,limit:v.limit,reminder:{enabled:v.reminder.enabled,dayOfMonth:v.reminder.dayOfMonth,tone:v.reminder.tone as 'gentle'|'direct',channel:'whatsapp'}};
}
function recordIds(v:unknown,commandId:string,customerId:string):CustomerRecordIds {
  if(!object(v)||!exact(v,'accountEventId,accountId,openingEntryId,openingEventId')||!Object.values(v).every(id)||new Set([commandId,customerId,...Object.values(v)]).size!==6)throw new Error('Use distinct, stable customer record IDs.');
  return {accountId:v.accountId as string,accountEventId:v.accountEventId as string,openingEntryId:v.openingEntryId as string,openingEventId:v.openingEventId as string};
}
/** Normalize the existing customer protocol without changing its wire order. */
export function parseCustomerCommand(v:unknown):CustomerCommand {
  if(!object(v))throw new Error('Use valid command and shop IDs.');
  if(!id(v.id)||!id(v.customerId)||!id(v.outletId))throw new Error('Use valid command and shop IDs.');
  const base={id:v.id,customerId:v.customerId,outletId:v.outletId};
  if((v.type==='customer.archive'||v.type==='customer.restore')&&exact(v,'customerId,id,outletId,type'))return {...base,type:v.type};
  if(v.type==='khata.settings'&&exact(v,'accountId,customerId,id,ids,input,outletId,type')&&(v.accountId===null||id(v.accountId))){const ids=recordIds(v.ids,v.id,v.customerId);if(v.accountId!==null&&v.accountId!==ids.accountId)throw new Error('Keep the original khata ID.');return {...base,type:v.type,accountId:v.accountId,input:terms(v.input),ids};}
  if((v.type==='customer.create'||v.type==='customer.update')&&exact(v,'credit,customerId,id,ids,input,opening,outletId,type')&&object(v.input)){
    const p=v.input;
    if(!exact(p,'address,name,nickname,notes,phone,tags')||!['name','nickname','phone','address','notes'].every(k=>typeof p[k]==='string')||!Array.isArray(p.tags)||p.tags.length>20||!p.tags.every(t=>typeof t==='string'&&t.trim().length<=32)||typeof p.name!=='string'||!p.name.trim()||/[\r\n]/.test(p.name)||p.name.trim().length>80||typeof p.nickname!=='string'||p.nickname.trim().length>80||typeof p.phone!=='string'||p.phone.length>80||typeof p.address!=='string'||p.address.trim().length>250||typeof p.notes!=='string'||p.notes.trim().length>2000)throw new Error('Check the customer profile.');
    const opening=v.opening;if(opening!==null&&(!object(opening)||!exact(opening,'amount,occurredAt')||!integer(opening.amount,Number.MAX_SAFE_INTEGER)||opening.amount<1||!integer(opening.occurredAt)))throw new Error('Check the opening balance.');
    return {...base,type:v.type,input:{name:p.name,nickname:p.nickname,phone:p.phone,address:p.address,notes:p.notes,tags:p.tags as string[]},credit:v.credit===null?null:terms(v.credit),opening:opening===null?null:{amount:opening.amount as number,occurredAt:opening.occurredAt as number},ids:recordIds(v.ids,v.id,v.customerId)};
  }
  throw new Error('Choose a supported customer action and its exact fields.');
}
export function parseCustomerCommandReceipt(v:unknown,c:CustomerCommand):CustomerCommandReceipt {
  if(!object(v)||v.id!==c.id||v.type!==c.type||v.customerId!==c.customerId||v.outletId!==c.outletId||!(v.accountId===null||id(v.accountId))||!integer(v.at)||!integer(v.customerUpdatedAt)||!(v.accountUpdatedAt===null||integer(v.accountUpdatedAt))||((v.accountId===null)!==(v.accountUpdatedAt===null))||((c.type==='customer.archive'||c.type==='customer.restore')!==(v.accountId===null))||(c.type==='khata.settings'&&c.accountId!==null&&v.accountId!==c.accountId))throw new Error('Invalid customer command receipt.');
  if(c.type==='customer.archive'||c.type==='customer.restore'){if(v.accountEventId!==null||v.entryId!==null||v.openingEventId!==null)throw new Error('Invalid status receipt.');}
  else{
    if(!('ids'in c))throw new Error('Missing customer record IDs.');
    if(v.accountId!==c.ids.accountId||v.entryId!==('opening'in c&&c.opening?c.ids.openingEntryId:null)||v.openingEventId!==('opening'in c&&c.opening?c.ids.openingEventId:null)
      ||(c.type==='khata.settings'?v.accountEventId!==c.id:v.accountEventId!==c.ids.accountEventId&&v.accountEventId!==null)
      ||(c.type==='customer.create'||'credit'in c&&c.credit!==null||'opening'in c&&c.opening!==null)&&v.accountEventId===null)throw new Error('Customer receipt does not match the device record IDs.');
  }
  return {id:c.id,type:c.type,customerId:c.customerId,outletId:c.outletId,accountId:v.accountId,accountEventId:v.accountEventId as string|null,entryId:v.entryId as string|null,openingEventId:v.openingEventId as string|null,at:v.at,customerUpdatedAt:v.customerUpdatedAt,accountUpdatedAt:v.accountUpdatedAt};
}
export async function customerFingerprint(c:CustomerCommand):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseCustomerCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');
}
