import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isOrderCommand,parseShopCommand} from '@mise/core/shop-commands';
import {parseOrderReviewRequest,type OrderReviewRequest} from '@mise/core/order-review';
import {nativeRowHash} from './canonical-writes';
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const fields=(value:unknown,names:string[])=>object(value)?Object.fromEntries(names.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])):null;
/** The complete original remains in the outbox, including literal sources and
 * Blob bytes. This bounded financial review records its hash and monetary facts
 * without duplicating every large before/after audit or photograph on the wire. */
export async function prepareOrderReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<OrderReviewRequest> {
 if(row.status!=='pending'||index!==row.receipts.length||!row.commands[index])throw new Error('Review the first unconfirmed original action.');
 const command=parseShopCommand(row.commands[index]);if(!isOrderCommand(command)||command.type==='order.warning-settings'||command.outletId!==row.outletId)throw new Error('Choose the original saved order action.');
 const order=(value:unknown)=>{
  if(!object(value))return null;
  return {...fields(value,['id','number','revision','status','currency','subtotal','deliveryFee','discount','total','payment','customer','createdAt','updatedAt','eventId','statusEventId']),lines:Array.isArray(value.lines)?value.lines.map(line=>fields(line,['id','itemId','qty','unitPrice','lineTotal','unavailable'])):[]};
 };
 const money=new Set(['sales','creditEntries','orderRefunds']);
 const source={v:1,entryId:row.id,sequence:row.sequence,commandIndex:index,at:row.at,orders:row.changes.filter(change=>change.table==='orders'&&change.key===command.orderId).map(change=>({key:change.key,before:order(change.before),after:order(change.after)})),money:row.changes.filter(change=>money.has(change.table)).map(change=>({table:change.table,key:change.key,before:fields(change.before,['id','outletId','orderId','saleId','accountId','customerId','refundId','amount','currency','method','given','change','type','sequence','createdAt','updatedAt','eventId','voidedAt','reversalOf']),after:fields(change.after,['id','outletId','orderId','saleId','accountId','customerId','refundId','amount','currency','method','given','change','type','sequence','createdAt','updatedAt','eventId','voidedAt','reversalOf'])}))};
 return parseOrderReviewRequest({id,replacementId,command,sourceHash:await nativeRowHash({...row,commands:row.commands.map(parseShopCommand),status:'pending',receipts:[]}),sourceJson:JSON.stringify(source)},false);
}
