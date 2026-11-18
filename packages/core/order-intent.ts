import {ulid} from 'ulid';
import type {AuditEvent,Order} from './models';
import type {OrderInput} from './orders';
import type {OrderCommand,OrderFinanceIds,OrderSettlement} from './order-commands';
import type {OrderMoneyIds,OrderRefundInput,OrderSettlementInput} from './order-payments';

/** Reserve every possible companion once; unused IDs never replace source records. */
export function reserveOrderFinance(at=Date.now()){
 const id=ulid(at),ids:OrderFinanceIds={saleId:ulid(at),saleEventId:ulid(at),entryId:ulid(at),creditEventId:ulid(at),refundId:ulid(at),refundEventId:ulid(at)};
 const newId:OrderMoneyIds=kind=>kind==='event'?id:ids[`${kind}Id` as keyof OrderFinanceIds];
 return {id,ids,newId};
}
export const orderIntentBase=(before:Order,event:AuditEvent)=>({id:event.id,outletId:before.outletId,orderId:before.id,revision:before.revision,occurredAt:event.at});
/** Local editors may pass saved models; emit only the requested editable fields. */
export function orderSettlementInput(input:OrderSettlementInput):OrderSettlementInput {
 return {method:input.method,...(input.method==='wallet'?{wallet:input.wallet}:{}),...(input.method==='cash'?{given:input.given}:{}),...(input.method==='credit'?{accountId:input.accountId,...(input.confirmation?{confirmation:{balance:input.confirmation.balance,limit:input.confirmation.limit}}:{})}:{})};
}
export function orderRefundInput(input:OrderRefundInput):OrderRefundInput {return {amount:input.amount,method:input.method,...(input.method==='wallet'?{wallet:input.wallet}:{}),note:input.note};}
export function orderSaveIntent(saved:{order:Order;event:AuditEvent},input:OrderInput,before:Order|null,settlement:OrderSettlement|null):Extract<OrderCommand,{type:'order.create'|'order.update'}>{
 const projected:OrderInput={source:input.source,sourceText:input.sourceText,customerId:input.customerId,name:input.name,phone:input.phone,type:input.type,address:input.address,table:input.table,scheduledFor:input.scheduledFor,deliveryFee:input.deliveryFee,discount:input.discount,payment:{method:input.payment.method,...(input.payment.method==='wallet'?{wallet:input.payment.wallet}:{})},lines:input.lines.map(line=>({id:line.id,itemId:line.itemId,name:line.name,unit:line.unit,qty:line.qty,unitPrice:line.unitPrice,note:line.note,unavailable:line.unavailable,substitution:line.substitution?{from:line.substitution.from,accepted:line.substitution.accepted}:undefined}))};
 return {id:saved.event.id,type:before?'order.update':'order.create',outletId:saved.order.outletId,orderId:saved.order.id,revision:before?.revision??0,occurredAt:saved.event.at,input:projected,newLineIds:input.lines.flatMap((line,index)=>line.id?[]:[saved.order.lines[index].id]),settlement};
}
