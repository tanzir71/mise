import type {SupplierInput} from './stock';
import type {Purchase} from './models';
import {orderLineTotal} from './order-lines';
import {purchaseLineValue} from './purchases';
export const purchaseBodyHeader='X-Mise-Purchase-Record';
export const purchaseBodyLimit=512_000;
export interface PurchaseRecordInput {supplierId:string|null;supplierName:string;reference:string;lines:{stockItemId:string|null;name:string;unit:string;qty:number;unitPrice:number}[];paid:Purchase['paid'];wallet:string|null;note:string}
type Base={id:string;outletId:string;occurredAt:number};
export type PurchaseCommand=Base&(
 |{type:'supplier.create';supplierId:string;input:SupplierInput}
 |{type:'supplier.update';supplierId:string;revision:number;input:SupplierInput}
 |{type:'supplier.archive'|'supplier.restore';supplierId:string;revision:number}
 |{type:'purchase.record';purchaseId:string;input:PurchaseRecordInput}
 |{type:'purchase.undo';purchaseId:string});
export interface PurchaseCommandReceipt {id:string;type:PurchaseCommand['type'];outletId:string;occurredAt:number;at:number;supplierId:string|null;purchaseId:string|null;revision:number|null;total:number|null;updatedAt:number;voidedAt:number|null;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
const text=(v:unknown,max:number,line=true):v is string=>typeof v==='string'&&v.trim().length<=max&&(!line||!/[\r\n]/.test(v));
export function isPurchaseCommandType(v:unknown):v is PurchaseCommand['type']{return typeof v==='string'&&['supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo'].includes(v);}
function supplierInput(v:unknown):SupplierInput{if(!object(v)||!exact(v,'name,note,phone')||!text(v.name,120)||!v.name.trim()||!text(v.phone,80)||!text(v.note,2000,false))throw new Error('Check the supplier details.');return {name:v.name,phone:v.phone,note:v.note};}
function purchaseInput(v:unknown):PurchaseRecordInput{
 if(!object(v)||!exact(v,'lines,note,paid,reference,supplierId,supplierName,wallet')||(v.supplierId!==null&&!id(v.supplierId))||!text(v.supplierName,120)||v.supplierId===null&&!v.supplierName.trim()||!text(v.reference,120)||!text(v.note,4000,false)||!['cash','wallet','card','due'].includes(v.paid as string)||(v.wallet!==null&&!text(v.wallet,80))||!Array.isArray(v.lines)||v.lines.length<1||v.lines.length>200)throw new Error('Check the invoice details and its 1–200 lines.');
 const lines=v.lines.map(l=>{if(!object(l)||!exact(l,'name,qty,stockItemId,unit,unitPrice')||(l.stockItemId!==null&&!id(l.stockItemId))||!text(l.name,120)||!l.name.trim()||!text(l.unit,24)||!l.unit.trim()||!integer(l.unitPrice)||typeof l.qty!=='number')throw new Error('Check the priced invoice line.');orderLineTotal(l.unitPrice,l.qty);return {stockItemId:l.stockItemId as string|null,name:l.name,unit:l.unit,qty:l.qty,unitPrice:l.unitPrice};});
 const total=lines.reduce((sum,l)=>sum+BigInt(orderLineTotal(l.unitPrice,l.qty)),0n);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('The invoice total exceeds the supported amount.');
 return {supplierId:v.supplierId as string|null,supplierName:v.supplierName,reference:v.reference,lines,paid:v.paid as Purchase['paid'],wallet:v.wallet as string|null,note:v.note};
}
export function parsePurchaseCommand(v:unknown):PurchaseCommand{
 if(!object(v)||!id(v.id)||!id(v.outletId)||!integer(v.occurredAt,0,8640000000000000))throw new Error('Check the supplier/invoice command identity.');
 const base={id:v.id,outletId:v.outletId,occurredAt:v.occurredAt};let c:PurchaseCommand;
 if(v.type==='supplier.create'&&exact(v,'id,input,occurredAt,outletId,supplierId,type')&&id(v.supplierId))c={...base,type:v.type,supplierId:v.supplierId,input:supplierInput(v.input)};
 else if(v.type==='supplier.update'&&exact(v,'id,input,occurredAt,outletId,revision,supplierId,type')&&id(v.supplierId)&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))c={...base,type:v.type,supplierId:v.supplierId,revision:v.revision,input:supplierInput(v.input)};
 else if((v.type==='supplier.archive'||v.type==='supplier.restore')&&exact(v,'id,occurredAt,outletId,revision,supplierId,type')&&id(v.supplierId)&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))c={...base,type:v.type,supplierId:v.supplierId,revision:v.revision};
 else if(v.type==='purchase.record'&&exact(v,'id,input,occurredAt,outletId,purchaseId,type')&&id(v.purchaseId))c={...base,type:v.type,purchaseId:v.purchaseId,input:purchaseInput(v.input)};
 else if(v.type==='purchase.undo'&&exact(v,'id,occurredAt,outletId,purchaseId,type')&&id(v.purchaseId))c={...base,type:v.type,purchaseId:v.purchaseId};
 else throw new Error('Choose a supported supplier or invoice action and its exact fields.');
 const target='supplierId'in c?c.supplierId:c.purchaseId;if(target===c.id||c.type==='purchase.record'&&(c.input.supplierId===c.id||c.input.supplierId===c.purchaseId||c.input.lines.some(l=>l.stockItemId===c.id||l.stockItemId===c.purchaseId)))throw new Error('Keep supplier, stock, invoice and audit IDs distinct.');return c;
}
export function purchaseWritePlan(c:PurchaseCommand){const lines=c.type==='purchase.record'?c.input.lines.map(l=>purchaseLineValue({...l,stockItemId:l.stockItemId??undefined})):[];return {supplierId:'supplierId'in c?c.supplierId:c.type==='purchase.record'?c.input.supplierId:null,purchaseId:'purchaseId'in c?c.purchaseId:null,revision:c.type==='supplier.create'?0:'revision'in c?c.revision:null,stockItemIds:[...new Set(lines.flatMap(l=>l.stockItemId?[l.stockItemId]:[]))].sort(),lineFacts:lines.map(l=>({stockItemId:l.stockItemId??null,unitKey:JSON.stringify(l.unit),qty:l.qty,unitPrice:l.unitPrice})),linesJson:c.type==='purchase.record'?JSON.stringify(lines):null};}
export function parsePurchaseCommandReceipt(v:unknown,c:PurchaseCommand):PurchaseCommandReceipt{
 if(!object(v)||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!integer(v.at,0,8640000000000000)||!integer(v.updatedAt,Math.max(v.at,c.occurredAt),8640000000000000)||(v.supplierId!==null&&!id(v.supplierId))||(v.purchaseId!==null&&!id(v.purchaseId)))throw new Error('Invalid supplier/invoice receipt.');
 if('supplierId'in c){if(v.supplierId!==c.supplierId||v.purchaseId!==null||v.revision!==(c.type==='supplier.create'?1:c.revision+1)||v.total!==null||v.voidedAt!==null||v.undoOf!==null)throw new Error('Supplier receipt does not match its reviewed identity and revision.');}
 else{if(v.purchaseId!==c.purchaseId||v.revision!==null||!integer(v.total)||v.voidedAt!==(c.type==='purchase.undo'?c.occurredAt:null)||v.undoOf!==(c.type==='purchase.undo'?c.purchaseId:null)||c.type==='purchase.record'&&(v.supplierId!==c.input.supplierId||v.total!==c.input.lines.reduce((sum,l)=>sum+orderLineTotal(l.unitPrice,l.qty),0)))throw new Error('Invoice receipt does not match the retained intent.');}
 return {id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:v.at,supplierId:v.supplierId as string|null,purchaseId:v.purchaseId as string|null,revision:v.revision as number|null,total:v.total as number|null,updatedAt:v.updatedAt,voidedAt:v.voidedAt as number|null,undoOf:v.undoOf as string|null};
}
