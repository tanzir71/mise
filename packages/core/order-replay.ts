import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {isOrderSave,parseOrderCommand,usesCurrentOrderRevision,type OrderCommand,type OrderFinanceIds} from './order-commands';
import {addOrderNoteCommand,changeOrderStatusCommand,recordOrderCommunicationCommand,saveOrderCommand,saveOrderWarningCommand,undoOrderStatusCommand,validateOrder,orderEvent,type OrderIds} from './orders';
import {cancelOrderCommand,refundOrderCommand,settleOrderCommand,undoOrderCancellationCommand,undoOrderPaymentCommand,undoOrderRefundCommand,type OrderMoneyChange,type OrderMoneyContext,type OrderMoneyIds} from './order-payments';
import {CreditLimitError} from './khata';
import type {ShopSetup} from './shop-access';
import type {AuditEvent,Business,CreditAccount,CreditEntry,Customer,Item,Order,OrderCommunication,OrderNote,OrderRefund,Outlet,Sale} from './models';
export class OrderMutationInvalid extends Error {}
export class OrderMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function orderFingerprint(c:OrderCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseOrderCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
function financialIds(eventId:string,ids:OrderFinanceIds):OrderMoneyIds {return kind=>kind==='event'?eventId:ids[`${kind}Id` as keyof OrderFinanceIds];}
export function replayOrderRecords(value:unknown,c:OrderCommand):CloudRecord[]{
 c=parseOrderCommand(c);
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid order preparation.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.order,raw.customer,raw.account,raw.sale,raw.statusEvent,raw.refund].every(r=>r===null||object(r))||!Array.isArray(raw.items)||!raw.items.every(object)||!Array.isArray(raw.entries)||!raw.entries.every(object)||typeof raw.sequence!=='number'||!Number.isSafeInteger(raw.sequence)||raw.sequence<1)throw new Error('Invalid order source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 const before=raw.order?decodeCommandRecord('orders',raw.order as Record<string,unknown>) as unknown as Order:undefined,customer=raw.customer?decodeCommandRecord('customers',raw.customer as Record<string,unknown>) as unknown as Customer:undefined,account=raw.account?decodeCommandRecord('creditAccounts',raw.account as Record<string,unknown>) as unknown as CreditAccount:undefined;
 const sale=raw.sale?decodeCommandRecord('sales',raw.sale as Record<string,unknown>) as unknown as Sale:undefined,statusEvent=raw.statusEvent?decodeCommandRecord('events',raw.statusEvent as Record<string,unknown>) as unknown as AuditEvent:undefined,refund=raw.refund?decodeCommandRecord('orderRefunds',raw.refund as Record<string,unknown>) as unknown as OrderRefund:undefined;
 const items=raw.items.map(r=>decodeCommandRecord('items',r) as unknown as Item),entries=raw.entries.map(r=>decodeCommandRecord('creditEntries',r) as unknown as CreditEntry);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||before&&(before.outletId!==outlet.id||!('orderId'in c)||before.id!==c.orderId)||customer&&customer.businessId!==business.id||account&&(account.outletId!==outlet.id||!customer||account.customerId!==customer.id)||items.some(i=>i.outletId!==outlet.id)||entries.some(e=>!account||e.accountId!==account.id||e.outletId!==outlet.id||e.customerId!==account.customerId)||sale&&(!before||sale.orderId!==before.id||sale.outletId!==outlet.id||sale.id!==before.payment.saleId)||statusEvent&&(!before||statusEvent.id!==before.statusEventId||statusEvent.orderId!==before.id||statusEvent.outletId!==outlet.id)||refund&&(!before||refund.orderId!==before.id||refund.outletId!==outlet.id||c.type!=='order.refund-undo'||refund.id!==c.refundId))throw new Error('Invalid order scope.');
 const setup:ShopSetup={business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}},context:OrderMoneyContext={setup,ledger:account&&customer?{setup,customer,account,entries}:undefined};
 let order:Order|undefined,changedOutlet:Outlet|undefined,note:OrderNote|undefined,communication:OrderCommunication|undefined,sales:Sale[]=[],createdEntries:CreditEntry[]=[],refunds:OrderRefund[]=[];
 const events:AuditEvent[]=[];
 const take=(change:OrderMoneyChange)=>{order=change.order;sales=change.sales;createdEntries=change.entries;refunds=change.refunds;events.push(...change.events);};
 let nextLine=0;
 const localIds:OrderIds=kind=>{if(kind==='event')return c.id;if(kind==='order'&&'orderId'in c)return c.orderId;if(kind==='line'&&isOrderSave(c)&&c.newLineIds[nextLine])return c.newLineIds[nextLine++];if(kind==='note'&&c.type==='order.note')return c.noteId;if(kind==='communication'&&c.type==='order.communication')return c.communicationId;throw new Error('Unplanned order identity.');};
 try{
  if(c.occurredAt>value.at+300000)throw new OrderMutationConflict('Check the device clock and keep the original intent.');
  if(c.type!=='order.warning-settings'&&c.type!=='order.create'&&(!before||(usesCurrentOrderRevision(c)?before.revision<c.revision:before.revision!==c.revision)))throw new OrderMutationConflict('Review the latest order revision. Keep the retained intent.');
  const revision='revision'in c&&usesCurrentOrderRevision(c)?before!.revision:'revision'in c?c.revision:0;
  if('sourceSaleId'in c&&c.sourceSaleId!==(before?.payment.saleId??null)||c.type==='order.payment-undo'&&c.sourcePaymentAt!==before?.payment.at)throw new OrderMutationConflict('Review the original order payment and retain its identities.');
  if(c.type==='order.warning-settings')({outlet:changedOutlet,event:events[0]}=saveOrderWarningCommand(c.minutes,setup,c.occurredAt,localIds));
  else if(isOrderSave(c)){
   if(c.type==='order.create'&&before)throw new OrderMutationConflict('This order identity already exists.');
   if(c.type==='order.update'&&c.newLineIds.some(id=>before!.lines.some(line=>line.id===id)))throw new OrderMutationConflict('Keep distinct original new-line identities.');
   const saved=saveOrderCommand(c.input,{setup,items,customer,sequence:raw.sequence},c.type==='order.create'?null:before,revision,c.occurredAt,localIds);order=saved.order;events.push(saved.event);
   if(nextLine!==c.newLineIds.length)throw new Error('Keep the new line plan.');
   if(c.settlement){const p=c.settlement;take(settleOrderCommand(order,{...p.input,accountId:p.input.method==='credit'?p.input.accountId??account?.id:p.input.accountId},context,order.revision,c.occurredAt,financialIds(p.id,p.ids)));}
  }else if(c.type==='order.status'){
   if(c.status==='cancelled')take(cancelOrderCommand(before!,sale,context,c.revision,c.occurredAt,financialIds(c.id,c.ids)));
   else if(before!.status===c.status){validateOrder(before!,setup,revision);order={...before!,revision:revision+1,eventId:c.id,updatedAt:c.occurredAt};events.push(orderEvent(order,setup,'order.status',before!,order,c.occurredAt,()=>c.id));}
   else{const r=changeOrderStatusCommand(before!,c.status,setup,revision,c.occurredAt,localIds);order=r.order;events.push(r.event);}
  }else if(c.type==='order.status-undo'){
   if(!statusEvent)throw new Error('The status history is missing.');
   if(before!.status==='cancelled')take(undoOrderCancellationCommand(before!,statusEvent,sale,context,c.revision,c.occurredAt,financialIds(c.id,c.ids)));
   else{const r=undoOrderStatusCommand(before!,statusEvent,setup,c.revision,c.occurredAt,localIds);order=r.order;events.push(r.event);}
  }else if(c.type==='order.note'){const r=addOrderNoteCommand(before!,c.text,setup,revision,c.occurredAt,localIds);order=r.order;note=r.note;events.push(r.event);}
  else if(c.type==='order.communication'){const r=recordOrderCommunicationCommand(before!,c.input,setup,revision,c.occurredAt,localIds);order=r.order;communication=r.communication;events.push(r.event);}
  else if(c.type==='order.payment')take(settleOrderCommand(before!,{...c.input,accountId:c.input.method==='credit'?c.input.accountId??account?.id:c.input.accountId},context,c.revision,c.occurredAt,financialIds(c.id,c.ids)));
  else if(c.type==='order.payment-undo'){
   if(c.occurredAt<(sale?.createdAt??before!.payment.at??0))throw new Error('Keep the original payment time.');
   take(undoOrderPaymentCommand(before!,sale,context,c.revision,value.at,financialIds(c.id,c.ids)));
  }else if(c.type==='order.refund'){if(!sale)throw new Error('The original receipt is missing.');take(refundOrderCommand(before!,sale,c.input,context,c.revision,c.occurredAt,financialIds(c.id,c.ids)));}
  else{if(!refund||c.occurredAt<refund.createdAt)throw new Error('The original refund is missing.');take(undoOrderRefundCommand(before!,refund,context,c.revision,value.at,financialIds(c.id,c.ids)));}
 }catch(error){if(error instanceof OrderMutationConflict)throw error;if(error instanceof CreditLimitError)throw new OrderMutationConflict('Review the exact current credit balance and limit.');throw new OrderMutationInvalid('Check the order, pricing, payment, status history, refund or device time.');}
 const normalize=(row:{createdAt:number;updatedAt:number})=>{row.updatedAt=Math.max(value.at as number,c.occurredAt,row.createdAt,row.updatedAt);};
 if(order){normalize(order);order.updatedAt=Math.max(order.updatedAt,before?.updatedAt??0);}if(changedOutlet)normalize(changedOutlet);if(note)normalize(note);if(communication)normalize(communication);
 for(const s of sales){normalize(s);if(c.type==='order.payment-undo'&&s.voidedAt!==undefined)s.voidedAt=c.occurredAt;}
 for(const e of createdEntries){e.createdAt=c.occurredAt;normalize(e);}
 for(const r of refunds){normalize(r);if(c.type==='order.refund-undo'&&r.voidedAt!==undefined)r.voidedAt=c.occurredAt;}
 for(const e of events){e.at=value.at;if(isOrderSave(c)&&object(e.after)&&e.after.id===c.orderId&&typeof e.after.createdAt==='number'&&typeof e.after.updatedAt==='number'){normalize(e.after as unknown as Order);e.after.updatedAt=Math.max(e.after.updatedAt as number,before?.updatedAt??0);}}
 if(!events.some(e=>e.id===c.id)||events.some(e=>e.actor.id!==value.actorId||e.outletId!==outlet.id))throw new Error('Invalid order audit identity.');
 const records:CloudRecord[]=[];if(order)records.push(encodeCommandRecord('orders',order,business.id));if(changedOutlet)records.push(encodeCommandRecord('outlets',changedOutlet,business.id));if(note)records.push(encodeCommandRecord('orderNotes',note,business.id));if(communication)records.push(encodeCommandRecord('orderCommunications',communication,business.id));
 records.push(...sales.map(s=>encodeCommandRecord('sales',s,business.id)),...createdEntries.map(e=>encodeCommandRecord('creditEntries',e,business.id)),...refunds.map(r=>encodeCommandRecord('orderRefunds',r,business.id)),...events.map(e=>encodeCommandRecord('events',e,business.id)));
 return records;
}
