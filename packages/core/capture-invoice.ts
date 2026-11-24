import {ulid} from 'ulid';
import {assertInboxId} from './inbox';
import {recordPurchaseCommand,type PurchaseInput} from './purchases';
import {saveStockItemCommand,stockBatchCommand,type StockChange,type StockIds,type StockWriteContext} from './stock';
import {stockAtoms,stockNumber,stockNameKey,stockUnit} from './stock-quantity';
import type {AuditEvent,Purchase} from './models';

export type InvoiceStockTarget={type:'existing';id:string;revision:number}|{type:'new';id:string};
export interface ReceivedInvoiceLine {name:string;unit:string;qty:number;unitPrice:number;stock:InvoiceStockTarget}
export interface ReceivedInvoiceInput extends Omit<PurchaseInput,'lines'> {lines:ReceivedInvoiceLine[];counted:boolean}
export interface ReceivedInvoiceChange {
 created:StockChange[];received:StockChange;purchase:Purchase;event:AuditEvent;
}
/** Explicit receipt of human-checked quantities. The OCR reader cannot call this
 * by producing text: its caller supplies actual stock choices and confirmation.
 * All results are pure until a single native transaction writes them together. */
export function receiveInvoiceCommand(input:ReceivedInvoiceInput,context:StockWriteContext,identity:{purchaseId:string;eventId:string;stockNote:string},at=Date.now(),newId:StockIds=()=>ulid(at)):ReceivedInvoiceChange{
 assertInboxId(identity.purchaseId);assertInboxId(identity.eventId);
 if(input.counted!==true)throw new Error('Check and count the received quantities before adding stock and purchases.');
 if(!input.lines.length||input.lines.length>200)throw new Error('Review between one and 200 invoice lines.');
 const current={...context,items:[...context.items]},created:StockChange[]=[],newItems=new Set<string>(),quantities=new Map<string,{revision:number;quantity:bigint}>();
 const lines=input.lines.map(line=>{
  assertInboxId(line.stock.id);
  const unit=stockUnit(line.unit),name=line.name.trim();let item=current.items.find(item=>item.id===line.stock.id);
  if(line.stock.type==='new'){
   if(item&&!newItems.has(item.id))throw new Error('This new stock identity is already in use. Reopen the image review.');
   if(item&&(stockNameKey(item.name)!==stockNameKey(name)||stockUnit(item.unit)!==unit))throw new Error('Use a distinct stock item for each name and unit.');
   if(!item){
    const change=saveStockItemCommand({name,unit,onHand:0,target:0,packSize:1,supplierId:input.supplierId},current,null,0,at,(kind,itemId)=>kind==='item'?line.stock.id:newId(kind,itemId));
    created.push(change);item=change.items[0];current.items.push(item);newItems.add(item.id);
   }
  }else if(!item||item.revision!==line.stock.revision)throw new Error('Stock changed while this invoice was reviewed. Open its current quantities again.');
  if(!item||item.archivedAt!==undefined||item.outletId!==context.setup.outlet.id||stockUnit(item.unit)!==unit)throw new Error('Choose active stock in this invoice line’s unit.');
  const quantity=stockAtoms(line.qty);if(quantity<=0n)throw new Error('Enter a received quantity greater than zero.');
  const previous=quantities.get(item.id);if(previous&&previous.revision!==item.revision)throw new Error('Review one current stock revision for each item.');
  quantities.set(item.id,{revision:item.revision,quantity:(previous?.quantity??0n)+quantity});
  return {stockItemId:item.id,name,unit:item.unit,qty:line.qty,unitPrice:line.unitPrice};
 });
 const received=stockBatchCommand([...quantities].map(([id,value])=>({id,revision:value.revision,reason:'received',quantity:stockNumber(value.quantity),source:'manual',note:identity.stockNote})),current,at,false,newId);
 const {purchase,event}=recordPurchaseCommand({...input,lines},context.setup,context.suppliers,current.items,at,kind=>kind==='purchase'?identity.purchaseId:identity.eventId);
 return {created,received,purchase,event};
}
