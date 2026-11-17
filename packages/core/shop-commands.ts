import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommand,type CloudCommandReceipt} from './cloud-commands';
import type {CustomerInput} from './customers';
import type {CreditTermsInput} from './khata';
import {isMoneyCommandType,parseMoneyCommand,parseMoneyCommandReceipt,type MoneyCommand,type MoneyCommandReceipt} from './money-commands';
export type CustomerCommand=
  |{id:string;type:'customer.create'|'customer.update';customerId:string;outletId:string;input:CustomerInput;credit:CreditTermsInput|null;opening:{amount:number;occurredAt:number}|null}
  |{id:string;type:'customer.archive'|'customer.restore';customerId:string;outletId:string}
  |{id:string;type:'khata.settings';customerId:string;outletId:string;accountId:string|null;input:CreditTermsInput};
export type ShopCommand=CloudCommand|CustomerCommand|MoneyCommand;
export interface CustomerCommandReceipt {id:string;type:CustomerCommand['type'];customerId:string;outletId:string;accountId:string|null;at:number;customerUpdatedAt:number;accountUpdatedAt:number|null}
export type ShopCommandReceipt=CloudCommandReceipt|CustomerCommandReceipt|MoneyCommandReceipt;
export function isMoneyCommand(c:ShopCommand):c is MoneyCommand {return isMoneyCommandType(c.type);}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,max=8640000000000000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
export function isCustomerCommand(c:ShopCommand):c is CustomerCommand {return c.type==='khata.settings'||c.type.startsWith('customer.');}
function terms(v:unknown):CreditTermsInput {
  if(!object(v)||!exact(v,'allowed,limit,reminder')||typeof v.allowed!=='boolean'||!integer(v.limit,Number.MAX_SAFE_INTEGER)||!object(v.reminder)||!exact(v.reminder,'channel,dayOfMonth,enabled,tone')||typeof v.reminder.enabled!=='boolean'||!integer(v.reminder.dayOfMonth,31)||v.reminder.dayOfMonth<1||!['gentle','direct'].includes(v.reminder.tone as string)||v.reminder.channel!=='whatsapp')throw new Error('Check the credit terms.');
  return {allowed:v.allowed,limit:v.limit,reminder:{enabled:v.reminder.enabled,dayOfMonth:v.reminder.dayOfMonth,tone:v.reminder.tone as 'gentle'|'direct',channel:'whatsapp'}};
}
export function parseShopCommand(v:unknown):ShopCommand {
  if(object(v)&&isMoneyCommandType(v.type))return parseMoneyCommand(v);
  if(!object(v)||typeof v.type!=='string'||(!v.type.startsWith('customer.')&&v.type!=='khata.settings'))return parseCloudCommand(v);
  if(!id(v.id)||!id(v.customerId)||!id(v.outletId))throw new Error('Use valid command and shop IDs.');
  const base={id:v.id,customerId:v.customerId,outletId:v.outletId};
  if((v.type==='customer.archive'||v.type==='customer.restore')&&exact(v,'customerId,id,outletId,type'))return {...base,type:v.type};
  if(v.type==='khata.settings'&&exact(v,'accountId,customerId,id,input,outletId,type')&&(v.accountId===null||id(v.accountId)))return {...base,type:v.type,accountId:v.accountId,input:terms(v.input)};
  if((v.type==='customer.create'||v.type==='customer.update')&&exact(v,'credit,customerId,id,input,opening,outletId,type')&&object(v.input)){
    const p=v.input;
    if(!exact(p,'address,name,nickname,notes,phone,tags')||!['name','nickname','phone','address','notes'].every(k=>typeof p[k]==='string')||!Array.isArray(p.tags)||p.tags.length>20||!p.tags.every(t=>typeof t==='string'&&t.trim().length<=32)||typeof p.name!=='string'||!p.name.trim()||/[\r\n]/.test(p.name)||p.name.trim().length>80||typeof p.nickname!=='string'||p.nickname.trim().length>80||typeof p.phone!=='string'||p.phone.length>80||typeof p.address!=='string'||p.address.trim().length>250||typeof p.notes!=='string'||p.notes.trim().length>2000)throw new Error('Check the customer profile.');
    const opening=v.opening;if(opening!==null&&(!object(opening)||!exact(opening,'amount,occurredAt')||!integer(opening.amount,Number.MAX_SAFE_INTEGER)||opening.amount<1||!integer(opening.occurredAt)))throw new Error('Check the opening balance.');
    return {...base,type:v.type,input:{name:p.name,nickname:p.nickname,phone:p.phone,address:p.address,notes:p.notes,tags:p.tags as string[]},credit:v.credit===null?null:terms(v.credit),opening:opening===null?null:{amount:opening.amount as number,occurredAt:opening.occurredAt as number}};
  }
  throw new Error('Choose a supported customer action and its exact fields.');
}
export function parseShopCommandReceipt(v:unknown,c:ShopCommand):ShopCommandReceipt {
  if(isMoneyCommand(c))return parseMoneyCommandReceipt(v,c);
  if(!isCustomerCommand(c))return parseCloudCommandReceipt(v,c);
  if(!object(v)||v.id!==c.id||v.type!==c.type||v.customerId!==c.customerId||v.outletId!==c.outletId||!(v.accountId===null||id(v.accountId))||!integer(v.at)||!integer(v.customerUpdatedAt)||!(v.accountUpdatedAt===null||integer(v.accountUpdatedAt))||((v.accountId===null)!==(v.accountUpdatedAt===null))||((c.type==='customer.archive'||c.type==='customer.restore')!==(v.accountId===null))||(c.type==='khata.settings'&&c.accountId!==null&&v.accountId!==c.accountId))throw new Error('Invalid customer command receipt.');
  return {id:c.id,type:c.type,customerId:c.customerId,outletId:c.outletId,accountId:v.accountId,at:v.at,customerUpdatedAt:v.customerUpdatedAt,accountUpdatedAt:v.accountUpdatedAt};
}
