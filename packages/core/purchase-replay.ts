import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {parsePurchaseCommand,purchaseWritePlan,type PurchaseCommand} from './purchase-commands';
import {archiveSupplierCommand,saveSupplierCommand} from './stock';
import {recordPurchaseCommand,undoPurchaseCommand} from './purchases';
import type {ShopSetup} from './shop-access';
import type {AuditEvent,Business,Outlet,Purchase,StockItem,Supplier} from './models';
export class PurchaseMutationInvalid extends Error {}
export class PurchaseMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function purchaseFingerprint(c:PurchaseCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parsePurchaseCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
export function replayPurchaseRecords(value:unknown,c:PurchaseCommand):CloudRecord[]{
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid supplier/invoice context.');
 const raw:unknown=JSON.parse(value.contextJson);if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.supplier,raw.purchase].every(r=>r===null||object(r))||!Array.isArray(raw.stock)||!raw.stock.every(object))throw new Error('Invalid supplier/invoice records.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,supplier=raw.supplier?decodeCommandRecord('suppliers',raw.supplier as Record<string,unknown>) as unknown as Supplier:null,purchase=raw.purchase?decodeCommandRecord('purchases',raw.purchase as Record<string,unknown>) as unknown as Purchase:null,stock=raw.stock.map(s=>decodeCommandRecord('stockItems',s) as unknown as StockItem),plan=purchaseWritePlan(c);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||supplier&&(supplier.outletId!==outlet.id||supplier.id!==plan.supplierId)||purchase&&(purchase.outletId!==outlet.id||purchase.id!==plan.purchaseId)||stock.some(s=>s.outletId!==outlet.id||!plan.stockItemIds.includes(s.id)))throw new Error('Invalid supplier/invoice scope.');
 const setup:ShopSetup={business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}};
 let savedSupplier:Supplier|undefined,savedPurchase:Purchase|undefined,event:AuditEvent;
 try{
  if(c.occurredAt>value.at+300000)throw new Error('Check the device clock.');
  if('supplierId'in c){
   if(c.type==='supplier.create'?supplier!==null:!supplier||supplier.revision<c.revision||supplier.revision>=Number.MAX_SAFE_INTEGER)throw new PurchaseMutationConflict('Review the latest supplier revision. Keep the retained intent.');
   if(c.type==='supplier.create'||c.type==='supplier.update')({supplier:savedSupplier,event}=saveSupplierCommand(c.input,setup,c.type==='supplier.create'?null:supplier,c.type==='supplier.create'?0:supplier!.revision,c.occurredAt,kind=>kind==='supplier'?c.supplierId:c.id));
   else if((supplier!.archivedAt!==undefined)===(c.type==='supplier.archive')){
    savedSupplier={...supplier!,revision:supplier!.revision+1,eventId:c.id,updatedAt:c.occurredAt};event={id:c.id,outletId:outlet.id,supplierId:supplier!.id,actor:{type:'member',id:value.actorId},command:c.type,before:supplier,after:savedSupplier,at:c.occurredAt};
   }else ({supplier:savedSupplier,event}=archiveSupplierCommand(supplier!,c.type==='supplier.archive',supplier!.revision,setup,c.occurredAt,()=>c.id));
  }else if(c.type==='purchase.record')({purchase:savedPurchase,event}=recordPurchaseCommand({...c.input,supplierId:c.input.supplierId??undefined,wallet:c.input.wallet??undefined,lines:c.input.lines.map(l=>({...l,stockItemId:l.stockItemId??undefined}))},setup,supplier?[supplier]:[],stock,c.occurredAt,kind=>kind==='purchase'?c.purchaseId:c.id));
  else{
   if(!purchase||c.occurredAt<purchase.createdAt)throw new Error('Choose the original invoice.');
   ({purchase:savedPurchase,event}=undoPurchaseCommand(purchase,setup,value.at,()=>c.id));savedPurchase.voidedAt=c.occurredAt;
  }
 }catch(error){if(error instanceof PurchaseMutationConflict)throw error;throw new PurchaseMutationInvalid('Check the supplier, invoice lines, payment method, original invoice or device time.');}
 const saved=savedSupplier??savedPurchase!;saved.updatedAt=Math.max(value.at,saved.createdAt,c.occurredAt,(savedSupplier?supplier:purchase)?.updatedAt??0);event.at=value.at;
 if(saved.eventId!==('supplierId'in c?c.id:c.type==='purchase.record'?c.id:purchase?.eventId)||event.id!==c.id||event.actor.id!==value.actorId)throw new Error('Invalid supplier/invoice audit identity.');
 const records:CloudRecord[]=[savedSupplier?encodeCommandRecord('suppliers',savedSupplier,business.id):encodeCommandRecord('purchases',savedPurchase!,business.id),encodeCommandRecord('events',event,business.id)];
 return records;
}
