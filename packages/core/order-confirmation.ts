import {orderLineTotal, orderPricing} from './order-lines';
import {saveOrderCommand, changeOrderStatusCommand, type OrderContext, type OrderInput} from './orders';
import {settleOrderCommand, type OrderMoneyContext} from './order-payments';
import {creditBalance} from './khata';
import {marketPacks} from './packs';
import type {AuditEvent, CreditEntry, Order, OrderLine, Sale} from './models';

export interface CheckoutWallet {id:string;name:string;phone:string;url:string}
export interface OrderQuote {
  v:1; orderId:string; revision:number; status:'requested'|'priced'; number:string; currency:string;
  lines:OrderLine[]; deliveryFee:number; discount:number;
  settingsRevision:number; wallets:CheckoutWallet[];
  credit:null|{revision:number;balance:number;limit:number;maximum:number};
}
export interface SwapDecision {lineId:string;accepted:boolean}
export interface OrderConfirmation {
  v:1; id:string; quoteHash:string; swaps:SwapDecision[];
  payment:{method:'cash'|'wallet'|'credit';walletId:string|null};
  ids:{updateEventId:string;pricedEventId:string;acceptedEventId:string;paymentEventId:string;saleId:string;saleEventId:string;entryId:string;creditEventId:string};
}
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const bad=()=>Error('Review the shop’s current prices, swaps and payment choice before confirming.');
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
export function parseCheckoutWallet(value:unknown):CheckoutWallet {
  if(!record(value)||!exact(value,'id,name,phone,url')||!id(value.id)||!text(value.name,80)||value.name==='Cash'||typeof value.phone!=='string'||!/^\+[1-9]\d{6,14}$/.test(value.phone)||!text(value.url,2048))throw bad();
  const url=new URL(value.url);
  if(url.username||url.password||!['https:','bkash:','nagad:'].includes(url.protocol)||url.protocol==='bkash:'&&value.name!=='bKash'||url.protocol==='nagad:'&&value.name!=='Nagad')throw bad();
  return {id:value.id,name:value.name,phone:value.phone as string,url:value.url};
}
function quoteLine(value:unknown):OrderLine {
  if(!record(value)||Object.keys(value).some(k=>!['id','itemId','name','unit','qty','unitPrice','lineTotal','note','unavailable','substitution'].includes(k))||!id(value.id)||value.itemId!==undefined&&!id(value.itemId)||typeof value.name!=='string'||!value.name.trim()||value.name.length>120||typeof value.unit!=='string'||!value.unit.trim()||value.unit.length>24||/[\r\n]/.test(value.name+value.unit)||typeof value.note!=='string'||value.note.length>500||typeof value.unavailable!=='boolean'||value.unitPrice!==null&&!integer(value.unitPrice)||value.lineTotal!==null&&!integer(value.lineTotal))throw bad();
  const total=orderLineTotal((value.unitPrice??0) as number,value.qty as number);
  if(value.lineTotal!==(value.unitPrice===null?null:total))throw bad();
  let substitution:OrderLine['substitution'];
  if(value.substitution!==undefined){const s=value.substitution;if(!record(s)||Object.keys(s).some(k=>!['from','accepted','acceptedAt'].includes(k))||typeof s.from!=='string'||!s.from.trim()||s.from.length>120||/[\r\n]/.test(s.from)||typeof s.accepted!=='boolean'||s.acceptedAt!==undefined&&!integer(s.acceptedAt,0,8640000000000000)||s.accepted===false&&s.acceptedAt!==undefined)throw bad();substitution={from:s.from,accepted:s.accepted,...(s.acceptedAt===undefined?{}:{acceptedAt:s.acceptedAt as number})};}
  return {id:value.id,...(value.itemId===undefined?{}:{itemId:value.itemId as string}),name:value.name,unit:value.unit,qty:value.qty as number,unitPrice:value.unitPrice as number|null,lineTotal:value.lineTotal as number|null,note:value.note,unavailable:value.unavailable,...(substitution?{substitution}:{})};
}
export function parseOrderQuote(value:unknown):OrderQuote {
  if(!record(value)||!exact(value,'v,orderId,revision,status,number,currency,lines,deliveryFee,discount,settingsRevision,wallets,credit')||value.v!==1||!id(value.orderId)||!integer(value.revision,1,Number.MAX_SAFE_INTEGER-4)||!['requested','priced'].includes(value.status as string)||!text(value.number,64)||typeof value.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency)||!Array.isArray(value.lines)||!value.lines.length||value.lines.length>200||!integer(value.deliveryFee)||!integer(value.discount)||!integer(value.settingsRevision)||!Array.isArray(value.wallets)||value.wallets.length>8)throw bad();
  const lines=value.lines.map(quoteLine),wallets=value.wallets.map(parseCheckoutWallet);
  if(new Set(lines.map(l=>l.id)).size!==lines.length||new Set(wallets.map(w=>w.id)).size!==wallets.length||new Set(wallets.map(w=>w.name)).size!==wallets.length||lines.some(l=>!l.unavailable&&l.unitPrice===null))throw bad();
  orderPricing(lines,value.deliveryFee,value.discount);
  let credit:OrderQuote['credit']=null;
  if(value.credit!==null){const c=value.credit;if(!record(c)||!exact(c,'revision,balance,limit,maximum')||!integer(c.revision,1)||!integer(c.balance,-Number.MAX_SAFE_INTEGER)||!integer(c.limit)||!integer(c.maximum))throw bad();credit={revision:c.revision,balance:c.balance,limit:c.limit,maximum:c.maximum};}
  return {v:1,orderId:value.orderId,revision:value.revision,status:value.status as OrderQuote['status'],number:value.number,currency:value.currency,lines,deliveryFee:value.deliveryFee,discount:value.discount,settingsRevision:value.settingsRevision,wallets,credit};
}
export function parseOrderConfirmation(value:unknown):OrderConfirmation {
  if(!record(value)||!exact(value,'v,id,quoteHash,swaps,payment,ids')||value.v!==1||!id(value.id)||typeof value.quoteHash!=='string'||!/^[0-9a-f]{64}$/.test(value.quoteHash)||!Array.isArray(value.swaps)||value.swaps.length>200||!record(value.payment)||!exact(value.payment,'method,walletId')||!['cash','wallet','credit'].includes(value.payment.method as string))throw bad();
  if(value.payment.method==='wallet'?!id(value.payment.walletId):value.payment.walletId!==null)throw bad();
  // Keep every allocated audit/financial identity in the original, including
  // cash/wallet branches which do not create a sale or a credit entry.
  const ids=value.ids;
  if(!record(ids)||!exact(ids,'updateEventId,pricedEventId,acceptedEventId,paymentEventId,saleId,saleEventId,entryId,creditEventId')||!Object.values(ids).every(id))throw bad();
  const swaps:SwapDecision[]=value.swaps.map(v=>{if(!record(v)||!exact(v,'lineId,accepted')||!id(v.lineId)||typeof v.accepted!=='boolean')throw bad();return {lineId:v.lineId,accepted:v.accepted};});
  if(new Set(swaps.map(s=>s.lineId)).size!==swaps.length||new Set([value.id,...Object.values(ids)]).size!==9)throw bad();
  const orderedIds=Object.fromEntries(['updateEventId','pricedEventId','acceptedEventId','paymentEventId','saleId','saleEventId','entryId','creditEventId'].map(k=>[k,ids[k]]));
  return {v:1,id:value.id,quoteHash:value.quoteHash,swaps,payment:{method:value.payment.method as OrderConfirmation['payment']['method'],walletId:value.payment.walletId as string|null},ids:orderedIds as unknown as OrderConfirmation['ids']};
}
/** A missing decision stays undecided in previews. Confirmation requires one
 * deliberate answer per proposal, including No; a missing answer is not No. */
export function decidedQuote(quote:OrderQuote,swaps:SwapDecision[],at:number,complete=true):{lines:OrderLine[];total:number|null;undecided:number} {
  const proposed=quote.lines.filter(l=>!l.unavailable&&l.substitution&&!l.substitution.accepted),answers=new Map(swaps.map(s=>[s.lineId,s.accepted]));
  if(!integer(at,0,8640000000000000)||answers.size!==swaps.length||swaps.some(s=>!proposed.some(l=>l.id===s.lineId)||typeof s.accepted!=='boolean')||complete&&proposed.some(l=>!answers.has(l.id)))throw bad();
  // No excludes the proposed item from the accepted order. The complete quote,
  // explicit decision and before image retain it in the action and audit; do
  // not mislabel a customer-declined item as an inventory shortage.
  const lines=quote.lines.filter(l=>!answers.has(l.id)||answers.get(l.id)).map(l=>!answers.has(l.id)?{...l}:{...l,substitution:{from:l.substitution!.from,accepted:true,acceptedAt:at}});
  const pricing=orderPricing(lines,quote.deliveryFee,quote.discount);
  if(complete&&!pricing.complete)throw Error('Choose at least one available, priced item before confirming.');
  return {lines,total:pricing.total,undecided:proposed.filter(l=>!answers.has(l.id)).length};
}
/** Actual domain commands produce the same order, status and money records as
 * the shop. Server context, not customer input, supplies the responsible member
 * and any explicitly granted current-currency ledger. */
export function confirmOrderCommand(before:Order,quote:OrderQuote,original:OrderConfirmation,context:OrderContext&OrderMoneyContext&{quoteHash:string},at:number):{order:Order;events:AuditEvent[];sales:Sale[];entries:CreditEntry[]} {
  const intent=parseOrderConfirmation(original),q=parseOrderQuote(quote);
  if(intent.quoteHash!==context.quoteHash||at<before.updatedAt||before.businessType!=='corner_shop'||q.status!==before.status||before.payment.status!=='pending'||before.payment.saleId||q.orderId!==before.id||q.revision!==before.revision||q.currency!==before.currency||q.number!==before.number||q.deliveryFee!==before.deliveryFee||q.discount!==before.discount||JSON.stringify(q.lines)!==JSON.stringify(before.lines.map(quoteLine))||[before.id,...q.lines.map(l=>l.id)].some(value=>Object.values(intent.ids).includes(value)||value===intent.id))throw bad();
  const choice=decidedQuote(q,intent.swaps,at),wallet=intent.payment.method==='wallet'?q.wallets.find(w=>w.id===intent.payment.walletId):null;
  if(intent.payment.method==='wallet'&&(!wallet||!marketPacks[context.setup.business.marketCode]['pay/wallets'].includes(wallet.name)))throw bad();
  if(intent.payment.method==='credit'){
    const grant=q.credit,ledger=context.ledger;
    if(!grant||!ledger||ledger.account.customerId!==before.customer.id||ledger.account.currency!==q.currency||ledger.account.currency!==context.setup.outlet.currency||!ledger.account.allowed||creditBalance(ledger.account,ledger.entries)!==grant.balance||ledger.account.limit!==grant.limit||choice.total===null||choice.total>grant.maximum||BigInt(grant.balance)+BigInt(choice.total)>BigInt(grant.limit))throw Error('The shop must review the current khata permission and available limit.');
  }
  const input:OrderInput={source:before.source,sourceText:before.sourceText,...(before.customer.id?{customerId:before.customer.id}:{}),name:before.customer.name,phone:before.customer.phone??'',type:before.type,address:before.address,table:before.table,...(before.scheduledFor===undefined?{}:{scheduledFor:before.scheduledFor}),lines:choice.lines,deliveryFee:q.deliveryFee,discount:q.discount,payment:{method:intent.payment.method,...(wallet?{wallet:wallet.name}:{})}};
  const updated=saveOrderCommand(input,context,before,before.revision,at,()=>intent.ids.updateEventId),events=[updated.event];
  let order=updated.order;
  if(order.status==='requested'){const priced=changeOrderStatusCommand(order,'priced',context.setup,order.revision,at,()=>intent.ids.pricedEventId);order=priced.order;events.push(priced.event);}
  const accepted=changeOrderStatusCommand(order,'accepted',context.setup,order.revision,at,()=>intent.ids.acceptedEventId);order=accepted.order;events.push(accepted.event);
  let sales:Sale[]=[],entries:CreditEntry[]=[];
  if(intent.payment.method==='credit'){
    const settled=settleOrderCommand(order,{method:'credit',accountId:context.ledger!.account.id},context,order.revision,at,kind=>({event:intent.ids.paymentEventId,sale:intent.ids.saleId,saleEvent:intent.ids.saleEventId,entry:intent.ids.entryId,creditEvent:intent.ids.creditEventId,refund:'',refundEvent:''})[kind]);
    order=settled.order;events.push(...settled.events);sales=settled.sales;entries=settled.entries;
  }
  for(const event of events)event.actor={type:'system',id:'public-order-confirmation'};
  return {order,events,sales,entries};
}
