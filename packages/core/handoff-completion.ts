import {ulid} from 'ulid';
import {handoffSessionToken,type HandoffCompletion,type HandoffSession} from './handoff';
import {recordCommunicationCommand,type CustomerLedgerContext} from './khata';
import {recordOrderCommunicationCommand} from './orders';
import {recordSupplierMessageCommand,sameSupplierMessage,type SupplierMessageInput} from './supplier-drafts';
import {validateShop,type ShopSetup} from './shop-access';
import {publicRecord} from './public-shop';
import type {AuditEvent,CreditEntry,Order,OrderCommunication,StockItem,Supplier,SupplierMessage} from './models';
export interface HandoffCompletionContext {setup:ShopSetup;ledger?:CustomerLedgerContext;order?:Order;suppliers?:Supplier[];items?:StockItem[];message?:SupplierMessage}
export type HandoffCompletionIds=(kind:'record'|'event')=>string;
export interface HandoffCompletionChange {entries:CreditEntry[];order?:Order;communication?:OrderCommunication;message?:SupplierMessage;reusedMessage?:SupplierMessage;events:AuditEvent[]}
/** The complete business side effect joins the caller's Sent transaction. It sends nothing. */
export function completeHandoffCommand(state:HandoffSession,value:HandoffCompletion|undefined,context:HandoffCompletionContext,at=Date.now(),newId:HandoffCompletionIds=()=>ulid(at)):HandoffCompletionChange {
 handoffSessionToken(state);validateShop(context.setup);
 if(state.outletId!==context.setup.outlet.id||state.progress.sentAt===undefined||state.eventId!==state.sentEventId)throw new Error('Confirm this exact message before completing its source record.');
 const {source,purpose,text,phone,part,parts}=state.draft,channel=state.progress.sentChannel==='whatsapp'?'whatsapp':'manual';
 const result:HandoffCompletionChange={entries:[],events:[]};
 if(source.kind==='credit'){
  const input=publicRecord(value,['kind']);if(input.kind!=='credit'||!context.ledger||context.ledger.account.id!==source.id)throw new Error('Review the credit message before marking it sent.');
  const c=recordCommunicationCommand(context.ledger,purpose as 'reminder'|'receipt'|'call',text,purpose==='call'?'call':channel,at,kind=>newId(kind==='entry'?'record':'event'));result.entries.push(c.entry);result.events.push(c.event);
 }else if(source.kind==='order'){
  const input=publicRecord(value,['kind','revision']);if(input.kind!=='order'||!Number.isSafeInteger(input.revision)||(input.revision as number)<1||!context.order||context.order.id!==source.id)throw new Error('Review the order before marking its message sent.');
  const c=recordOrderCommunicationCommand(context.order,{purpose:purpose as 'quote'|'call',text,channel:purpose==='call'?'call':channel},context.setup,input.revision as number,at,kind=>newId(kind==='communication'?'record':'event'));
  result.order=c.order;result.communication=c.communication;result.events.push(c.event);
 }else if((source.kind==='supplier'||source.kind==='shop')&&purpose==='supplier-order'){
  const input=publicRecord(value,['kind','supplierName','stockItemIds']);if(input.kind!=='supplier'||typeof input.supplierName!=='string'||!Array.isArray(input.stockItemIds)||input.stockItemIds.some(id=>typeof id!=='string'))throw new Error('Review the supplier draft before marking it sent.');
  const request:SupplierMessageInput={id:state.id,supplierId:source.kind==='supplier'?source.id:undefined,supplierName:input.supplierName,stockItemIds:input.stockItemIds as string[],phone,text,channel,part,parts};
  if(context.message){if(context.message.outletId!==state.outletId||context.message.voidedAt!==undefined||!sameSupplierMessage(request,context.message))throw new Error('This sent record changed. Reopen the supplier draft.');result.reusedMessage=context.message;}
  else{const c=recordSupplierMessageCommand(request,{setup:context.setup,items:context.items??[],suppliers:context.suppliers??[]},at,()=>newId('event'));result.message=c.message;result.events.push(c.event);}
 }else if(value!==undefined)throw new Error('This message does not use that completion record.');
 return result;
}
