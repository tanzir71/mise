import {supplierMessageName} from './supplier-drafts';
import type {AuditEvent,SupplierMessage} from './models';

/** A user's original Sent assertion; it never opens or sends a message. */
export interface SupplierMessageCommand {id:string;type:'supplier-message.record';outletId:string;occurredAt:number;message:{id:string;supplierId:string|null;supplierName:string;phone:string|null;text:string;channel:SupplierMessage['channel'];stockItemIds:string[];part:number;parts:number}}
export interface SupplierMessageCommandReceipt {id:string;type:'supplier-message.record';outletId:string;messageId:string;occurredAt:number;at:number;messageUpdatedAt:number}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
export function parseSupplierMessageCommand(v:unknown):SupplierMessageCommand {
 if(!object(v)||!exact(v,'id,type,outletId,occurredAt,message')||v.type!=='supplier-message.record'||!id(v.id)||!id(v.outletId)||v.id===v.outletId||!integer(v.occurredAt,0,253402300799999)||!object(v.message))throw new Error('Keep the original supplier confirmation, outlet and time.');
 const m=v.message;
 if(!exact(m,'id,supplierId,supplierName,phone,text,channel,stockItemIds,part,parts')||!id(m.id)||[v.id,v.outletId].includes(m.id)||!(m.supplierId===null||id(m.supplierId))||typeof m.supplierName!=='string'||!supplierMessageName(m.supplierName)||supplierMessageName(m.supplierName).length>120||!(m.phone===null||typeof m.phone==='string'&&/^\+[1-9]\d{6,14}$/.test(m.phone))||!['manual','whatsapp'].includes(m.channel as string)||m.channel==='whatsapp'&&m.phone===null||typeof m.text!=='string'||!m.text.trim()||m.text.length>4000||!Array.isArray(m.stockItemIds)||m.stockItemIds.length<1||m.stockItemIds.length>1000||!m.stockItemIds.every(id)||!integer(m.parts,1,1000)||!integer(m.part,1,m.parts))throw new Error('Keep the exact supplier, text, stock identities and message part.');
 return {id:v.id,type:'supplier-message.record',outletId:v.outletId,occurredAt:v.occurredAt,message:{id:m.id,supplierId:m.supplierId,supplierName:supplierMessageName(m.supplierName),phone:m.phone,text:m.text.trim(),channel:m.channel as SupplierMessage['channel'],stockItemIds:[...new Set(m.stockItemIds)],part:m.part,parts:m.parts}};
}
export function supplierMessageIntent(change:{message:SupplierMessage;event:AuditEvent}):SupplierMessageCommand {
 const {message:m,event:e}=change;if(e.command!=='supplier.sent'||e.id!==m.eventId||e.outletId!==m.outletId||e.at!==m.createdAt)throw new Error('Keep the original supplier sent record and audit.');
 return parseSupplierMessageCommand({id:e.id,type:'supplier-message.record',outletId:m.outletId,occurredAt:m.createdAt,message:{id:m.id,supplierId:m.supplierId??null,supplierName:m.supplierName,phone:m.phone??null,text:m.text,channel:m.channel,stockItemIds:m.stockItemIds,part:m.part,parts:m.parts}});
}
export function supplierMessageWritePlan(value:SupplierMessageCommand){const c=parseSupplierMessageCommand(value),m=c.message;return {messageId:m.id,supplierId:m.supplierId,supplierNameJson:JSON.stringify(m.supplierName),phone:m.phone,textJson:JSON.stringify(m.text),channel:m.channel,stockItemIds:m.stockItemIds,part:m.part,parts:m.parts,intentJson:JSON.stringify(c)};}
export function parseSupplierMessageCommandReceipt(v:unknown,c:SupplierMessageCommand):SupplierMessageCommandReceipt {
 if(!object(v)||!exact(v,'id,type,outletId,messageId,occurredAt,at,messageUpdatedAt')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.messageId!==c.message.id||v.occurredAt!==c.occurredAt||!integer(v.at,0,253402300799999)||v.messageUpdatedAt!==Math.max(c.occurredAt,v.at))throw new Error('The original supplier confirmation is unconfirmed.');
 return {id:c.id,type:c.type,outletId:c.outletId,messageId:c.message.id,occurredAt:c.occurredAt,at:v.at,messageUpdatedAt:v.messageUpdatedAt as number};
}
