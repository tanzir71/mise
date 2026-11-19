import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {parseHandoffCommand,type HandoffCommand} from './handoff-commands';
import {changeHandoffCommand,handoffDraftToken,handoffEventSession,handoffSourceTables,handoffTopic,prepareHandoffCommand,type HandoffSession} from './handoff';
import {completeHandoffCommand,type HandoffCompletionContext,type HandoffCompletionChange} from './handoff-completion';
import {undoSupplierMessageCommand} from './supplier-drafts';
import type {ShopSetup} from './shop-access';
import type {AuditEvent,Business,CreditAccount,CreditEntry,Customer,Order,Outlet,StockItem,Supplier,SupplierMessage} from './models';
export class HandoffMutationInvalid extends Error {}
export class HandoffMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
export async function handoffFingerprint(c:HandoffCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseHandoffCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
export function replayHandoffRecords(value:unknown,command:HandoffCommand):CloudRecord[]{
 const c=parseHandoffCommand(command);
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid message preparation.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.root,raw.previousRoot,raw.latest,raw.source,raw.customer,raw.message].every(r=>r===null||object(r))||!Array.isArray(raw.entries)||!raw.entries.every(object)||!Array.isArray(raw.items)||!raw.items.every(object))throw new Error('Invalid message source records.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id)throw new Error('Invalid message shop scope.');
 const setup:ShopSetup={business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}};
 const read=(r:unknown)=>r?decodeCommandRecord('events',r as Record<string,unknown>) as unknown as AuditEvent:null;
 const root=read(raw.root),previousRoot=read(raw.previousRoot),latest=read(raw.latest);
 const message=raw.message?decodeCommandRecord('supplierMessages',raw.message as Record<string,unknown>) as unknown as SupplierMessage:undefined;
 if(message&&message.outletId!==outlet.id)throw new Error('Invalid supplier message scope.');
 let state:HandoffSession|undefined,event:AuditEvent,completion:HandoffCompletionChange={entries:[],events:[]},undone:SupplierMessage|undefined;
 try{
  if(c.occurredAt>value.at+300000)throw new HandoffMutationConflict('Check the device clock and retain the original message intent.');
  if(c.type==='supplier-message.undo'){
   if(!message||message.id!==c.messageId||c.occurredAt<message.createdAt)throw new Error('Keep the original supplier sent record.');
   const r=undoSupplierMessageCommand(message,setup,value.at,()=>c.id);undone=r.message;undone.voidedAt=c.occurredAt;event=r.event;
  }else{
   if(!Number.isSafeInteger(raw.generation)||(raw.generation as number)<1||(raw.generation as number)>Number.MAX_SAFE_INTEGER)throw new Error('Keep a supported attempt generation.');
   let before:HandoffSession|undefined;
   if(c.type==='handoff.prepare'){
    if(root)throw new HandoffMutationConflict('This message attempt identity already exists.');
    if(previousRoot||latest){if(!previousRoot||!latest||previousRoot.command!=='handoff.prepare')throw new Error('The earlier message attempt is incomplete.');const first=handoffEventSession(previousRoot);before=handoffEventSession(latest);if(first.id!==before.id||first.outletId!==outlet.id||first.generation!==before.generation||first.createdAt!==before.createdAt||handoffDraftToken(first.draft)!==handoffDraftToken(before.draft)||handoffTopic(before.draft)!==handoffTopic(c.draft)||raw.generation!==before.generation+1)throw new Error('The preceding attempt changed.');}
    else if(raw.generation!==1)throw new Error('The first attempt generation is missing.');
   }else{
    if(!root||!latest||root.command!=='handoff.prepare')throw new Error('The original message attempt is missing.');const first=handoffEventSession(root);before=handoffEventSession(latest);
    if(first.id!==c.handoffId||before.id!==c.handoffId||before.outletId!==outlet.id||first.generation!==before.generation||first.createdAt!==before.createdAt||handoffDraftToken(first.draft)!==handoffDraftToken(before.draft)||raw.generation!==first.generation)throw new Error('The original message attempt changed.');
    if(before.progress.revision!==c.revision)throw new HandoffMutationConflict('Review the latest message progress and retain this choice.');
    if(c.choice.type==='undo-sent'&&(before.progress.sentAt===undefined||value.at<before.progress.sentAt||value.at-before.progress.sentAt>600000))throw new HandoffMutationConflict('Undo Sent within ten minutes of the original confirmation.');
   }
   const draft=c.type==='handoff.prepare'?c.draft:before!.draft,sourceKind=draft.source.kind,sourceId=draft.source.id;
   if(raw.sourceKind!==sourceKind||raw.sourceId!==sourceId||!object(raw.source)||raw.source.id!==sourceId||raw.source.business_id!==business.id||(sourceKind==='shop'?sourceId!==outlet.id:sourceKind!=='customer'&&raw.source.outlet_id!==outlet.id))throw new Error('The message source is missing or outside this outlet.');
   const source=decodeCommandRecord(handoffSourceTables[sourceKind],raw.source),at=Math.max(c.occurredAt,before?.progress.updatedAt??0);
   const r=c.type==='handoff.prepare'?prepareHandoffCommand(c.draft,setup,raw.generation as number,at,()=>c.id):changeHandoffCommand(before!,c.choice,setup,c.revision,c.id,at);state=r.session;event=r.event;
   if(c.type==='handoff.change'&&c.choice.type==='sent'){
    const context:HandoffCompletionContext={setup};
    if(sourceKind==='credit'){
     const account=source as unknown as CreditAccount,customer=raw.customer?decodeCommandRecord('customers',raw.customer as Record<string,unknown>) as unknown as Customer:undefined,entries=raw.entries.map(e=>decodeCommandRecord('creditEntries',e) as unknown as CreditEntry);
     if(!customer||customer.businessId!==business.id||account.customerId!==customer.id||entries.some(e=>e.outletId!==outlet.id||e.accountId!==account.id||e.customerId!==customer.id))throw new Error('The message khata changed.');context.ledger={setup,account,customer,entries};
    }
    if(sourceKind==='order'){context.order=source as unknown as Order;context.currentOrderRevision=true;if(c.completion?.kind==='order'&&context.order.revision<c.completion.revision)throw new HandoffMutationConflict('Review the latest order before confirming its exact message.');}
    if((sourceKind==='supplier'||sourceKind==='shop')&&draft.purpose==='supplier-order'){
     context.items=raw.items.map(i=>decodeCommandRecord('stockItems',i) as unknown as StockItem);if(context.items.some(i=>i.outletId!==outlet.id))throw new Error('Choose stock items from this outlet.');
     context.suppliers=sourceKind==='supplier'?[source as unknown as Supplier]:[];context.message=message;
    }
    completion=completeHandoffCommand(state,c.completion??undefined,context,at,kind=>{const v=kind==='record'?c.related?.recordId:c.related?.eventId;if(!v)throw new Error('Keep all companion identities.');return v;});
   }
  }
 }catch(error){if(error instanceof HandoffMutationConflict)throw error;throw new HandoffMutationInvalid('Review the exact message source, progress, completion, original sent record or device time.');}
 const normalize=(row:{createdAt:number;updatedAt:number})=>{row.updatedAt=Math.max(value.at as number,c.occurredAt,row.createdAt,row.updatedAt);};
 if(undone)normalize(undone);if(completion.order){normalize(completion.order);if(object(raw.source)&&typeof raw.source.updated_at==='number')completion.order.updatedAt=Math.max(completion.order.updatedAt,raw.source.updated_at);}if(completion.communication)normalize(completion.communication);if(completion.message)normalize(completion.message);for(const e of completion.entries)normalize(e);
 for(const e of completion.events)e.at=value.at;
 // Hand-off history requires event.at === progress.updatedAt. Admission time is in the receipt.
 if(c.type==='supplier-message.undo')event.at=value.at;
 const records:CloudRecord[]=[];if(undone)records.push(encodeCommandRecord('supplierMessages',undone,business.id));if(completion.order)records.push(encodeCommandRecord('orders',completion.order,business.id));if(completion.communication)records.push(encodeCommandRecord('orderCommunications',completion.communication,business.id));if(completion.message)records.push(encodeCommandRecord('supplierMessages',completion.message,business.id));records.push(...completion.entries.map(e=>encodeCommandRecord('creditEntries',e,business.id)),...completion.events.map(e=>encodeCommandRecord('events',e,business.id)),encodeCommandRecord('events',event,business.id));
 if(event.id!==c.id||event.actor.id!==value.actorId||event.outletId!==outlet.id)throw new Error('Invalid message audit identity.');
 return records;
}
