import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isPurchaseCommand,parseShopCommand} from '@mise/core/shop-commands';
import {parsePurchaseReviewRequest,type PurchaseReviewRequest} from '@mise/core/purchase-review';
import {nativeRowHash} from './canonical-writes';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const fields=(v:unknown)=>object(v)?Object.fromEntries(['id','outletId','supplierId','supplierName','reference','lines','total','currency','timezone','paid','methodName','note','photoRef','createdBy','eventId','createdAt','updatedAt','voidedAt'].filter(key=>v[key]!==undefined).map(key=>[key,v[key]])):null;
/** The original batch, receipt prefix and image bytes stay on the device. Only
 * its selected invoice and actual earlier creation witness go on the wire. */
export async function preparePurchaseReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<PurchaseReviewRequest>{
 if(row.status!=='pending'||index!==row.receipts.length||!row.commands[index])throw Error('Review the first unconfirmed original invoice action.');
 const command=parseShopCommand(row.commands[index]);
 if(!isPurchaseCommand(command)||!('purchaseId'in command)||command.outletId!==row.outletId)throw Error('Choose the original saved invoice action.');
 const selected=row.changes.filter(change=>change.table==='purchases'&&change.key===command.purchaseId);if(selected.length!==1)throw Error('Keep the complete original invoice image.');
 const change=selected[0],purchase={table:change.table,key:change.key,before:fields(change.before),after:fields(change.after)};
 let priorCommands:ReturnType<typeof parseShopCommand>[]=[];
 if(command.type==='purchase.undo'&&purchase.before===null){
  priorCommands=row.commands.slice(0,index).map(parseShopCommand).filter(prior=>prior.type==='purchase.record'&&prior.purchaseId===command.purchaseId&&prior.outletId===command.outletId);
  if(priorCommands.length!==1)throw Error('Keep the actual earlier original invoice creation.');
 }
 return parsePurchaseReviewRequest({id,replacementId,command,sourceHash:await nativeRowHash({...row,commands:row.commands.map(parseShopCommand),status:'pending',receipts:[]}),sourceJson:JSON.stringify({v:1,entryId:row.id,sequence:row.sequence,commandIndex:index,at:row.at,purchase,priorCommands})},false);
}
