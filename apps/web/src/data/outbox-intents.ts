import type {AuditEvent,StockItem,StockMove,Purchase,Supplier} from '@mise/core/models';
import type {StockChange} from '@mise/core/stock';
import type {StockCommand,StockDelta,StockSaveInput} from '@mise/core/stock-commands';
import type {PurchaseCommand} from '@mise/core/purchase-commands';
import type {ClosingChange} from '@mise/core/closing';
import type {ClosingCommand} from '@mise/core/closing-commands';

const stockInput=(item:StockItem):StockSaveInput=>({name:item.name,nameLocal:item.nameLocal,unit:item.unit,category:item.category,aliases:[...item.aliases],onHand:item.onHand,target:item.target,packSize:item.packSize,lowAt:item.lowAt,supplierId:item.supplierId??null});
const delta=(move:StockMove):StockDelta=>{if(move.reason==='undo')throw new Error('Keep the original undo source.');return {id:move.stockItemId,revision:move.revision-1,reason:move.reason,quantity:move.reason==='count'?move.after:Math.abs(move.delta),source:move.source,note:move.note};};
export function stockSaveIntent(change:StockChange,before:StockItem|null):StockCommand {
 const item=change.items[0],base={id:change.events[0].id,outletId:item.outletId,stockItemId:item.id,occurredAt:change.events[0].at,input:stockInput(item)};
 return before?{...base,type:'stock.update',revision:before.revision,moveId:change.moves[0]?.id??null}:{...base,type:'stock.create',moveId:change.moves[0].id};
}
export function stockAdjustmentIntent(change:StockChange):StockCommand {const movement=change.moves[0];return {id:change.events[0].id,type:'stock.adjust',outletId:movement.outletId,occurredAt:movement.createdAt,moveId:movement.id,change:delta(movement)};}
export function stockBatchIntent(change:StockChange,count:boolean):StockCommand {
 const first=change.moves[0];return {id:change.events[0].id,type:'stock.batch',outletId:first.outletId,occurredAt:first.createdAt,count,batchId:count?first.countBatchId!:null,changes:change.moves.map(move=>({...delta(move),eventId:move.eventId,moveId:move.id}))};
}
export function supplierSaveIntent(supplier:Supplier,event:AuditEvent,before:Supplier|null):PurchaseCommand {
 const base={id:event.id,outletId:supplier.outletId,supplierId:supplier.id,occurredAt:event.at,input:{name:supplier.name,phone:supplier.phone??'',note:supplier.note}};
 return before?{...base,type:'supplier.update',revision:before.revision}:{...base,type:'supplier.create'};
}
export function purchaseIntent(purchase:Purchase,event:AuditEvent):PurchaseCommand {
 return {id:event.id,type:'purchase.record',outletId:purchase.outletId,purchaseId:purchase.id,occurredAt:purchase.createdAt,input:{supplierId:purchase.supplierId??null,supplierName:purchase.supplierName,reference:purchase.reference,lines:purchase.lines.map(line=>({stockItemId:line.stockItemId??null,name:line.name,unit:line.unit,qty:line.qty,unitPrice:line.unitPrice})),paid:purchase.paid,wallet:purchase.paid==='wallet'?purchase.methodName:null,note:purchase.note}};
}
export function closingIntent(change:ClosingChange,undo=false):ClosingCommand {
 const closing=change.closing,event=change.events.find(e=>e.command===(undo?'closing.undo':'closing.record'))!,saleEvent=change.events.find(e=>e.command===(undo?'sale.closing-undo':'sale.record'));
 const base={id:event.id,outletId:closing.outletId,closingId:closing.id,occurredAt:event.at,saleId:change.sale?.id??null,saleEventId:saleEvent?.id??null};
 return undo?{...base,type:'closing.undo'}:{...base,type:'closing.record',input:{day:closing.day,fingerprint:closing.previewFingerprint,countedCash:closing.countedCash,addDifference:closing.addedWalkIn>0,note:closing.note}};
}
