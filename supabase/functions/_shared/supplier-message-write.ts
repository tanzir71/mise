import {decodeCommandRecord} from '../../../packages/core/cloud-records.ts';
import {parseSupplierMessageCommand,type SupplierMessageCommand} from '../../../packages/core/supplier-message-commands.ts';
import {recordSupplierMessageCommand} from '../../../packages/core/supplier-drafts.ts';
import type {Business,Outlet,StockItem,Supplier} from '../../../packages/core/models.ts';
export class SupplierMessageMutationInvalid extends Error {}
export class SupplierMessageMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
export async function supplierMessageFingerprint(c:SupplierMessageCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseSupplierMessageCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
export function supplierMessageWriteFields(value:unknown,command:SupplierMessageCommand,ticketId:string):Record<string,unknown>{
 const c=parseSupplierMessageCommand(command);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||typeof value.at!=='number'||!Number.isSafeInteger(value.at)||value.at<0||value.at>253402300799999||typeof value.contextJson!=='string')throw new Error('Invalid supplier confirmation preparation.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!(raw.supplier===null||object(raw.supplier))||!Array.isArray(raw.items)||!raw.items.every(object)||raw.message!==null)throw new Error('Invalid original supplier source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,items=raw.items.map(i=>decodeCommandRecord('stockItems',i) as unknown as StockItem),supplier=raw.supplier?decodeCommandRecord('suppliers',raw.supplier) as unknown as Supplier:null;
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||items.some(i=>i.outletId!==outlet.id)||c.message.supplierId!==(supplier?.id??null)||supplier&&supplier.outletId!==outlet.id)throw new Error('Invalid supplier confirmation scope.');
 if(c.occurredAt>value.at+300000)throw new SupplierMessageMutationConflict('Check the device clock and retain the original supplier confirmation.');
 try{
  recordSupplierMessageCommand({...c.message,supplierId:c.message.supplierId??undefined,phone:c.message.phone??undefined},{setup:{business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}},items,suppliers:supplier?[supplier]:[]},c.occurredAt,()=>c.id);
  return {p_ticket_id:ticketId,p_token:value.token,p_message_json:JSON.stringify(c.message)};
 }catch{throw new SupplierMessageMutationInvalid('Review the original supplier, stock items, message and contact method.');}
}
