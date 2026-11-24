import Dexie from 'dexie';
import type {MiseDatabase} from './db';
import type {StoredInboxItem,StoredInboxImage,InboxDestination} from './inbox';
import {captureBindingToken} from './inbox';
import type {SetupSnapshot,Purchase,Order,StockMove} from '@mise/core/models';
import {newInboxId,captureInboxCommand,validateInboxItem,validateInboxImageBytes} from '@mise/core/inbox';
import {receiveInvoiceCommand,type ReceivedInvoiceInput,type ReceivedInvoiceLine} from '@mise/core/capture-invoice';
import {undoPurchaseCommand} from '@mise/core/purchases';
import {undoStockMoveCommand,type StockWriteContext,type StockChange} from '@mise/core/stock';
import {stockAtoms,stockNameKey,stockUnit} from '@mise/core/stock-quantity';
import {saveOrderCommand,type OrderInput} from '@mise/core/orders';
import {normalisePhone} from '@mise/core/phone';
import {syncDownloadToken} from '@mise/core/sync-download';
import {parseLocalOperatorState,resolveOperator} from '@mise/core/operators';
import {captureOrderLineToken,assertCapturedLinesConfirmed} from '@mise/core/capture-order';
import {withOutboxIntents,withOutboxIntent} from './outbox-capture';
import {purchaseIntent,stockSaveIntent,stockBatchIntent} from './outbox-intents';
import {orderSaveIntent} from '@mise/core/order-intent';
import {inboxCaptureIntent} from '@mise/core/inbox-intent';

export type CaptureDestination=InboxDestination;
export interface SavedImageReview {readonly itemId:string;readonly image:Readonly<StoredInboxImage>;readonly title:string;readonly originalText:string;readonly archived:boolean}
type Proof={destination:CaptureDestination;selection:string;binding:string;shop:string;revision:number;content:string;imageId:string;itemId:string;purchaseId:string;orderId:string;textId:string;textEventId:string};
const proofs=new WeakMap<SavedImageReview,Proof>();
export type ImageInvoiceLine=Omit<ReceivedInvoiceLine,'stock'>&{stock:{type:'new'}|{type:'existing';id:string;revision:number}};
export type ImageInvoiceInput=Omit<ReceivedInvoiceInput,'lines'>&{lines:ImageInvoiceLine[]};
export type ImageReceipt={kind:'invoice';purchase:Purchase;original:Purchase;moves:StockMove[];reversedMoveIds:string[]}|{kind:'order';order:Order;original:Order};
const sourceLabel=(itemId:string,imageId:string)=>`Mise image: ${itemId}/${imageId}`;
const stockLabel=(imageId:string)=>`Image invoice ${imageId}`;
const sourceNote=(proof:Proof,note:string,trim=true)=>[sourceLabel(proof.itemId,proof.imageId),trim?note.trim():note].filter(Boolean).join('\n');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
async function digest(bytes:Uint8Array<ArrayBuffer>):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}
async function contentToken(item:StoredInboxItem):Promise<string>{
 validateInboxItem(item);
 const images=await Promise.all(item.images.map(async image=>{
  if(!(image.blob instanceof Blob)||image.blob.size!==image.size||image.blob.type!==image.type)throw new Error('Keep the complete original saved image.');
  const bytes=new Uint8Array(await image.blob.arrayBuffer());validateInboxImageBytes(image.type,bytes.subarray(0,12));
  return {id:image.id,name:image.name,type:image.type,size:image.size,sha256:await digest(bytes)};
 }));
 return syncDownloadToken({id:item.id,outletId:item.outletId,createdAt:item.createdAt,title:item.title,text:item.text,url:item.url,images});
}
function shopToken(setup:SetupSnapshot){return syncDownloadToken({business:setup.business,outlet:setup.outlet,owner:setup.owner});}
function matches(setup:SetupSnapshot|null,destination:CaptureDestination):setup is SetupSnapshot{return !!setup&&setup.business.id===destination.businessId&&setup.outlet.id===destination.outletId&&setup.owner.id===destination.actorId;}
async function guard(db:MiseDatabase,review:SavedImageReview,writing=false):Promise<{proof:Proof;setup:SetupSnapshot;item:StoredInboxItem}>{
 const proof=proofs.get(review);if(!proof)throw new Error('Open the saved image again before recording its details.');
 const [businesses,outlets,members,selection,item]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray(),db.operatorState.get('active'),db.inboxItems.get(proof.itemId)]);
 if(syncDownloadToken(selection??null)!==proof.selection||captureBindingToken(await db.cloudState.get('binding'))!==proof.binding)throw new Error('The outlet, member or connection changed. Open the saved image again.');
 const setup=resolveOperator(businesses,outlets,members,selection===undefined?null:parseLocalOperatorState(selection));
 if(!matches(setup,proof.destination)||syncDownloadToken(selection??null)!==proof.selection||captureBindingToken(await db.cloudState.get('binding'))!==proof.binding||shopToken(setup)!==proof.shop)throw new Error('The outlet, member or connection changed. Open the saved image again.');
 if(!item||item.outletId!==setup.outlet.id||!item.images.some(image=>image.id===proof.imageId)||await Dexie.waitFor(contentToken(item))!==proof.content)throw new Error('The original saved source changed. Open its current Inbox item.');
 if(writing&&(item.archived||item.revision!==proof.revision))throw new Error('The source was sorted or archived in another view. Reopen it before recording.');
 return {proof,setup,item};
}
/** Read the real immutable Blob and original native selection together. The proof
 * stays in memory; cloning or importing a view cannot grant recording authority. */
export async function openSavedImage(db:MiseDatabase,itemId:string,imageId:string,destination:CaptureDestination):Promise<SavedImageReview>{
 destination=structuredClone(destination);
 return db.transaction('r',db.tables,async()=>{
  const [businesses,outlets,members,item,selection]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray(),db.inboxItems.get(itemId),db.operatorState.get('active')]);
  const setup=resolveOperator(businesses,outlets,members,selection===undefined?null:parseLocalOperatorState(selection));
  const binding=captureBindingToken(await db.cloudState.get('binding'));
  if(!matches(setup,destination)||!item||item.outletId!==setup.outlet.id||destination.selectionToken!==undefined&&destination.selectionToken!==syncDownloadToken(selection??null)||destination.bindingToken!==undefined&&destination.bindingToken!==binding)throw new Error('Choose a saved image in the selected outlet.');
  const image=item.images.find(image=>image.id===imageId);if(!image)throw new Error('Saved image not found.');
  const [content,purchaseId,orderId,textId,textEventId]=await Dexie.waitFor(Promise.all([contentToken(item),captureRecordId(imageId,'purchase'),captureRecordId(imageId,'order'),captureRecordId(imageId,'text'),captureRecordId(imageId,'text-event')]));
  const review:SavedImageReview=Object.freeze({itemId,image:Object.freeze({...image}),title:item.title,originalText:item.text,archived:item.archived});
  proofs.set(review,{destination,selection:syncDownloadToken(selection??null),binding,shop:shopToken(setup),revision:item.revision,content,imageId,itemId,purchaseId,orderId,textId,textEventId});return review;
 });
}
async function originalReceipt(db:MiseDatabase,proof:Proof):Promise<ImageReceipt|null>{
 const event=await db.events.get(proof.imageId);if(!event)return null;
 if(event.outletId!==proof.destination.outletId||event.actor.type!=='member'||!object(event.after)||event.after.eventId!==proof.imageId)throw new Error('This image identity already belongs to another recorded action.');
 const prefix=sourceLabel(proof.itemId,proof.imageId);
 if(event.command==='purchase.record'){
  const original=event.after as unknown as Purchase,purchase=await db.purchases.get(proof.purchaseId);
  if(!purchase||original.id!==proof.purchaseId||original.outletId!==event.outletId||original.createdBy!==event.actor.id||original.eventId!==event.id||!original.note.startsWith(prefix)||purchase.eventId!==event.id)throw new Error('The original invoice receipt is incomplete. Keep the original image and review the saved records in a backup.');
  const normalized={...purchase,updatedAt:original.updatedAt};delete normalized.voidedAt;
  if(syncDownloadToken(normalized)!==syncDownloadToken(original))throw new Error('The recorded invoice differs from its original receipt. Keep the original image and review the saved records in a backup.');
  const expected=new Map<string,bigint>();for(const line of original.lines){if(!line.stockItemId)throw new Error('This invoice has no recorded stock receipt.');expected.set(line.stockItemId,(expected.get(line.stockItemId)??0n)+stockAtoms(line.qty));}
  const allMoves=await db.stockMoves.where('outletId').equals(event.outletId).toArray(),moves=allMoves.filter(move=>!move.undoOf&&move.note===stockLabel(proof.imageId)&&move.createdAt===original.createdAt&&move.createdBy===original.createdBy);
  const positions=new Map([...expected.keys()].map((id,index)=>[id,index]));moves.sort((left,right)=>(positions.get(left.stockItemId)??-1)-(positions.get(right.stockItemId)??-1));
  const events=await db.events.bulkGet(moves.map(move=>move.eventId));
  if(moves.length!==expected.size||moves.some((move,index)=>move.reason!=='received'||stockAtoms(move.delta)!==expected.get(move.stockItemId)||events[index]?.command!=='stock.received'||!object(events[index]?.after)||syncDownloadToken((events[index]!.after as {move?:unknown}).move)!==syncDownloadToken(move)))throw new Error('The stock receipt is incomplete. Inspect its original movements before making another change.');
  return {kind:'invoice',purchase,original,moves,reversedMoveIds:moves.filter(original=>allMoves.some(move=>move.undoOf===original.id)).map(move=>move.id)};
 }
 if(event.command==='order.create'){
  const original=event.after as unknown as Order,order=await db.orders.get(proof.orderId);
  if(!order||original.id!==proof.orderId||original.outletId!==event.outletId||original.createdBy!==event.actor.id||original.eventId!==event.id||!original.sourceText.startsWith(prefix)||order.createdBy!==original.createdBy||order.createdAt!==original.createdAt)throw new Error('The original order receipt is incomplete. Open Orders to inspect it.');
  return {kind:'order',order,original};
 }
 throw new Error('This image already belongs to another recorded action.');
}
export async function savedImageReceipt(db:MiseDatabase,review:SavedImageReview):Promise<ImageReceipt|null>{return db.transaction('r',db.tables,async()=>{const {proof}=await guard(db,review);return originalReceipt(db,proof);});}
export async function savedImageText(db:MiseDatabase,review:SavedImageReview):Promise<StoredInboxItem|null>{
 return db.transaction('r',db.tables,async()=>{const {proof}=await guard(db,review),item=await db.inboxItems.get(proof.textId),event=await db.events.get(proof.textEventId);if(!item&&!event)return null;if(!item||!event||event.command!=='inbox.capture'||event.outletId!==proof.destination.outletId||!object(event.after)||event.after.id!==item.id||item.outletId!==proof.destination.outletId||!item.text.startsWith(sourceLabel(proof.itemId,proof.imageId))||event.after.text!==item.text||event.after.title!==item.title||item.images.length)throw new Error('The saved text differs from its original capture. Inspect it in Inbox.');return item;});
}
/** A separate derived text source leaves the original image and any later
 * invoice/order action intact. Repeating the same save cannot duplicate it. */
export async function recordImageText(db:MiseDatabase,review:SavedImageReview,value:{title:string;text:string}):Promise<StoredInboxItem>{
 value=structuredClone(value);if(!value.text.trim())throw new Error('Read or type some text before saving it to Inbox.');
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup}=await guard(db,review),text=sourceNote(proof,value.text,false),existing=await savedImageText(db,review);
  if(existing){if(existing.text!==text||existing.title!==value.title)throw new Error('This image text was already saved with different details. Open its original text in Inbox.');return existing;}
  await guard(db,review,true);
  const command=captureInboxCommand({title:value.title,text,url:'',images:[]},setup,Date.now(),proof.textId,()=>proof.textEventId);
  return withOutboxIntent(db,inboxCaptureIntent(command.item,command.event!,[]),async()=>{await db.inboxItems.add(command.item);await db.events.add(command.event!);return command.item;});
 });
}
async function newStockId(imageId:string,name:string,unit:string):Promise<string>{
 const hex=await digest(new TextEncoder().encode(JSON.stringify(['mise-image-stock-v1',imageId,stockNameKey(name),stockUnit(unit)])));
 let value=BigInt('0x'+hex.slice(0,20)),suffix='';for(let n=0;n<16;n++){suffix='0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value&31n)]+suffix;value>>=5n;}return imageId.slice(0,10)+suffix;
}
async function captureRecordId(imageId:string,slot:string):Promise<string>{
 const hex=await digest(new TextEncoder().encode(`mise-image-record-v1\0${imageId}\0${slot}`));let value=BigInt('0x'+hex.slice(0,20)),suffix='';for(let n=0;n<16;n++){suffix='0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value&31n)]+suffix;value>>=5n;}return imageId.slice(0,10)+suffix;
}
function sameInvoice(input:ReceivedInvoiceInput,purchase:Purchase):boolean{
 return input.counted===true&&(input.supplierId??undefined)===purchase.supplierId&&(input.supplierId?purchase.supplierName:input.supplierName.trim())===purchase.supplierName&&input.reference.trim()===purchase.reference&&input.note.trim()===purchase.note&&input.paid===purchase.paid&&(input.paid!=='wallet'||input.wallet===purchase.methodName)&&input.lines.length===purchase.lines.length&&input.lines.every((line,index)=>{const saved=purchase.lines[index];return line.stock.id===saved.stockItemId&&line.name.trim()===saved.name&&stockUnit(line.unit)===stockUnit(saved.unit)&&line.qty===saved.qty&&line.unitPrice===saved.unitPrice;});
}
export async function recordImageInvoice(db:MiseDatabase,review:SavedImageReview,value:ImageInvoiceInput):Promise<ImageReceipt&{kind:'invoice'}>{
 const input=structuredClone(value),proof=proofs.get(review);if(!proof)throw new Error('Open the saved image again.');
 if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>200)throw new Error('Review between one and 200 invoice lines.');
 const prepared:ReceivedInvoiceInput={...input,note:sourceNote(proof,input.note),lines:await Promise.all(input.lines.map(async line=>({...line,stock:line.stock.type==='new'?{type:'new',id:await newStockId(proof.imageId,line.name,line.unit)}:line.stock})))};
 return db.transaction('rw',db.tables,async()=>{
  const {setup}=await guard(db,review),receipt=await originalReceipt(db,proof);
  if(receipt){if(receipt.kind!=='invoice'||!sameInvoice(prepared,receipt.original))throw new Error('This image was already recorded with different details. Inspect its original receipt.');return receipt;}
  await guard(db,review,true);
  const [items,suppliers]=await Promise.all([db.stockItems.where('outletId').equals(setup.outlet.id).toArray(),db.suppliers.where('outletId').equals(setup.outlet.id).toArray()]);
  const change=receiveInvoiceCommand(prepared,{setup,items,suppliers,moves:[]},{purchaseId:proof.purchaseId,eventId:proof.imageId,stockNote:stockLabel(proof.imageId)});
  await withOutboxIntents(db,[...change.created.map(change=>stockSaveIntent(change,null)),stockBatchIntent(change.received,false),purchaseIntent(change.purchase,change.event)],async()=>{
   for(const created of change.created){await db.stockItems.bulkPut(created.items);await db.stockMoves.bulkAdd(created.moves);await db.events.bulkAdd(created.events);}
   await db.stockItems.bulkPut(change.received.items);await db.stockMoves.bulkAdd(change.received.moves);await db.events.bulkAdd(change.received.events);await db.purchases.add(change.purchase);await db.events.add(change.event);
  });
  return {kind:'invoice',purchase:change.purchase,original:change.purchase,moves:change.received.moves,reversedMoveIds:[]};
 });
}
export async function undoImageInvoice(db:MiseDatabase,review:SavedImageReview):Promise<ImageReceipt&{kind:'invoice'}>{
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup}=await guard(db,review),receipt=await originalReceipt(db,proof);if(!receipt||receipt.kind!=='invoice')throw new Error('Open the recorded invoice first.');
  const [items,suppliers,moves]=await Promise.all([db.stockItems.where('outletId').equals(setup.outlet.id).toArray(),db.suppliers.where('outletId').equals(setup.outlet.id).toArray(),db.stockMoves.where('outletId').equals(setup.outlet.id).toArray()]);
  const at=Date.now(),purchase=receipt.purchase.voidedAt===undefined?undoPurchaseCommand(receipt.purchase,setup,at):null,context:StockWriteContext={setup,items:[...items],suppliers,moves:[...moves]},changes:StockChange[]=[];
  for(const original of receipt.moves){if(receipt.reversedMoveIds.includes(original.id))continue;const item=context.items.find(item=>item.id===original.stockItemId);if(!item)throw new Error('Stock item not found.');const change=undoStockMoveCommand(original,item.revision,context,at);changes.push(change);context.items=context.items.map(item=>change.items.find(value=>value.id===item.id)??item);context.moves.push(...change.moves);}
  const commands=[...(purchase?[{id:purchase.event.id,type:'purchase.undo' as const,outletId:setup.outlet.id,purchaseId:purchase.purchase.id,occurredAt:at}]:[]),...changes.map(change=>({id:change.events[0].id,type:'stock.undo' as const,outletId:setup.outlet.id,occurredAt:at,stockItemId:change.items[0].id,revision:change.items[0].revision-1,undoMoveId:change.moves[0].undoOf!,moveId:change.moves[0].id}))];
  if(commands.length)await withOutboxIntents(db,commands,async()=>{for(const change of changes){await db.stockItems.bulkPut(change.items);await db.stockMoves.bulkAdd(change.moves);await db.events.bulkAdd(change.events);}if(purchase){await db.purchases.put(purchase.purchase);await db.events.add(purchase.event);}});
  return {...receipt,purchase:purchase?.purchase??receipt.purchase,reversedMoveIds:receipt.moves.map(move=>move.id)};
 });
}
function sameOrder(input:OrderInput,order:Order,setup:SetupSnapshot):boolean{
 const phone=input.phone.trim()?normalisePhone(input.phone,setup.business.marketCode):input.customerId?order.customer.phone:undefined;
 return input.source==='other'&&input.sourceText===order.sourceText&&(input.customerId??undefined)===order.customer.id&&(input.name.trim()||(input.customerId?order.customer.name:'Customer'))===order.customer.name&&phone===order.customer.phone&&input.type===order.type&&(input.type==='delivery'?input.address.trim():'')===order.address&&(input.type==='dine_in'?input.table.trim():'')===order.table&&input.scheduledFor===order.scheduledFor&&(input.type==='delivery'?input.deliveryFee:0)===order.deliveryFee&&input.discount===order.discount&&input.payment.method===order.payment.method&&(input.payment.method!=='wallet'||input.payment.wallet===order.payment.wallet)&&input.lines.length===order.lines.length&&input.lines.every((line,index)=>captureOrderLineToken(line)===captureOrderLineToken(order.lines[index]));
}
/** Always creates an unpaid draft. Each final image line, including substitutions
 * and unavailable lines, needs its exact human confirmation before this writer. */
export async function recordImageOrder(db:MiseDatabase,review:SavedImageReview,value:OrderInput,checked:readonly string[]):Promise<ImageReceipt&{kind:'order'}>{
 const input=structuredClone(value),confirmed=[...checked],proof=proofs.get(review);if(!proof)throw new Error('Open the saved image again.');
 assertCapturedLinesConfirmed(input.lines,confirmed);
 if(input.payment.method==='credit')throw new Error('Create this image request unpaid. Record payment or khata from the order later.');
 input.source='other';input.sourceText=sourceNote(proof,input.sourceText,false);
 return db.transaction('rw',db.tables,async()=>{
  const {setup}=await guard(db,review),receipt=await originalReceipt(db,proof);
  if(receipt){if(receipt.kind!=='order'||!sameOrder(input,receipt.original,setup))throw new Error('This image was already recorded with different details. Inspect its original receipt.');return receipt;}
  await guard(db,review,true);
  const [items,customer,last]=await Promise.all([db.items.where('outletId').equals(setup.outlet.id).toArray(),input.customerId?db.customers.get(input.customerId):undefined,db.orders.where('[outletId+sequence]').between([setup.outlet.id,Dexie.minKey],[setup.outlet.id,Dexie.maxKey]).last()]);
  const at=Date.now(),change=saveOrderCommand(input,{setup,items,customer,sequence:(last?.sequence??0)+1},null,0,at,kind=>kind==='event'?proof.imageId:kind==='order'?proof.orderId:newInboxId(at));
  if(change.order.lines.some((line,index)=>captureOrderLineToken(line)!==confirmed[index]))throw new Error('A catalogue line changed after your check. Review and confirm its current details again.');
  await withOutboxIntent(db,orderSaveIntent(change,input,null,null),async()=>{await db.orders.add(change.order);await db.events.add(change.event);});
  return {kind:'order',order:change.order,original:change.order};
 });
}
