import type {CreditAccount,CreditEntry,Customer,Order,OrderRefund,Sale,SetupSnapshot} from './models';
import type {ParsedPaymentText,PaymentTextChannel} from './payments';
import {isOrderFinished} from './orders';
import {literalToken as syncDownloadToken} from './literal-token';

export interface PaymentMatchRecords {
  setup:SetupSnapshot;
  orders:readonly Order[];
  sales:readonly Sale[];
  entries:readonly CreditEntry[];
  accounts:readonly CreditAccount[];
  customers:readonly Customer[];
  refunds:readonly OrderRefund[];
}
export interface PaymentTextMatch {
  kind:'order'|'sale'|'credit';
  id:string;
  outletId:string;
  businessId:string;
  state:'open'|'recorded';
  amount:number;
  currency:string;
  at:number;
  distanceMs:number;
  label:string;
  customerName:string;
  phone:string|null;
  methodName:string|null;
  orderId:string|null;
  /** Complete current data, for exact comparison; never recording authority. */
  fingerprint:string;
}
export interface PaymentMatchOptions {
  windowMs?:number;
  methodNames?:Partial<Record<Exclude<PaymentTextChannel,'unknown'>,readonly string[]>>;
  receivedTimeConfirmed?:boolean;
  /** Confirmed associations supplied by the native reader, not a message field. */
  usedReceipts?:readonly {kind:'sale'|'credit';id:string}[];
}
export interface PaymentTextMatches {
  selection:'automatic'|'choose'|'none';
  candidates:PaymentTextMatch[];
  eligibleCount:number;
  windowMs:number;
}
export const paymentMatchWindowMs=30*60000;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&typeof value==='number'&&value>=0&&value<=253402300799999;
const amount=(value:unknown):value is number=>Number.isSafeInteger(value)&&typeof value==='number'&&value>0;
const methodKey=(value:string)=>value.trim().normalize('NFKC').toLowerCase();
type Draft=Omit<PaymentTextMatch,'fingerprint'>&{snapshot:()=>unknown};
const rank=(a:Draft,b:Draft)=>a.distanceMs-b.distanceMs||Number(b.phone!==null)-Number(a.phone!==null)||({order:0,sale:1,credit:2}[a.kind]-{order:0,sale:1,credit:2}[b.kind])||b.at-a.at||(a.id<b.id?-1:a.id>b.id?1:0);

/** Association proposals only. An automatic selection never settles an order,
 * creates a counter receipt or collects debt. The native action must reread the
 * actual source and final candidate in its transaction before recording. */
export function findPaymentTextMatches(source:ParsedPaymentText,records:PaymentMatchRecords,options:PaymentMatchOptions={}):PaymentTextMatches {
  const windowMs=options.windowMs??paymentMatchWindowMs;
  if(!Number.isSafeInteger(windowMs)||windowMs<1||windowMs>86400000)throw new Error('Choose a payment matching window within one day.');
  if(!time(source.receivedAt)||!/^[A-Z]{3}$/.test(source.currency))throw new Error('Keep the original payment currency and received time.');
  const result:PaymentTextMatches={selection:'none',candidates:[],eligibleCount:0,windowMs};
  if(source.amount===null||!amount(source.amount)||source.direction==='outgoing')return result;
  const {setup}=records,outletId=setup.outlet.id,businessId=setup.business.id;
  if(!id(outletId)||!id(businessId)||setup.outlet.businessId!==businessId)throw new Error('Choose the actual payment outlet.');
  const customers=new Map(records.customers.filter(c=>c.businessId===businessId).map(c=>[c.id,c]));
  const orders=new Map(records.orders.filter(o=>o.outletId===outletId).map(o=>[o.id,o]));
  const accounts=new Map(records.accounts.filter(a=>a.outletId===outletId&&customers.has(a.customerId)).map(a=>[a.id,a]));
  const reversals=new Set(records.entries.filter(e=>e.outletId===outletId&&e.reversalOf&&accounts.get(e.accountId)?.customerId===e.customerId).map(e=>e.reversalOf!));
  const refunded=new Set(records.refunds.filter(r=>r.outletId===outletId&&r.voidedAt===undefined&&r.amount>0).map(r=>r.saleId));
  const used=new Set((options.usedReceipts??[]).map(r=>r.kind+':'+r.id)),seen=new Map<string,()=>unknown>(),best:Draft[]=[];
  let invalidDuplicate=false;
  const methodNames=source.channel==='unknown'?null:(options.methodNames?.[source.channel]??{bkash:['bKash'],nagad:['Nagad'],bank:['Bank transfer']}[source.channel]).map(methodKey);
  function consider(draft:Draft){
    if(!id(draft.id)||!amount(draft.amount)||!time(draft.at)||draft.amount!==source.amount||draft.currency!==source.currency||draft.distanceMs>windowMs)return;
    if(draft.phone!==null&&source.fromPhone!==null&&draft.phone!==source.fromPhone)return;
    if(draft.state==='recorded'&&(used.has(draft.kind+':'+draft.id)||methodNames!==null&&(draft.methodName===null||!methodNames.includes(methodKey(draft.methodName)))))return;
    // Two conflicting copies of one native identity cannot become a unique match.
    const key=draft.kind+':'+draft.id,prior=seen.get(key);
    if(prior){if(syncDownloadToken(prior())!==syncDownloadToken(draft.snapshot()))invalidDuplicate=true;return;}
    seen.set(key,draft.snapshot);result.eligibleCount++;
    best.push(draft);best.sort(rank);if(best.length>3)best.pop();
  }
  const base=(at:number)=>({outletId,businessId,amount:source.amount!,currency:source.currency,at,distanceMs:Math.abs(source.receivedAt-at)});
  for(const order of records.orders){
    if(order.outletId!==outletId||order.payment.status!=='pending'||isOrderFinished(order)||!amount(order.total)||order.total!==source.amount||order.currency!==source.currency||!time(order.createdAt))continue;
    consider({...base(order.createdAt),kind:'order',id:order.id,state:'open',label:order.number,customerName:order.customer.name,phone:order.customer.phone??null,methodName:order.payment.method==='wallet'?order.payment.wallet??null:order.payment.method==='card'?'Card':order.payment.method==='cash'?'Cash':null,orderId:order.id,snapshot:()=>({scope:{businessId,outletId},order})});
  }
  for(const sale of records.sales){
    if(source.channel!=='unknown'&&sale.method!=='wallet')continue;
    if(sale.outletId!==outletId||sale.voidedAt!==undefined||sale.method==='credit'||refunded.has(sale.id)||sale.amount!==source.amount||sale.currency!==source.currency||!time(sale.createdAt))continue;
    const order=sale.orderId?orders.get(sale.orderId):undefined;
    if(sale.orderId&&(!order||order.payment.status!=='paid'||order.payment.saleId!==sale.id||order.payment.cancellation))continue;
    const customer=sale.customerId?customers.get(sale.customerId):undefined;
    if(sale.customerId&&!customer)continue;
    consider({...base(sale.createdAt),kind:'sale',id:sale.id,state:'recorded',label:order?.number??'Counter receipt',customerName:customer?.nickname||customer?.name||sale.who,phone:customer?.phone??order?.customer.phone??null,methodName:sale.methodName,orderId:order?.id??null,snapshot:()=>({scope:{businessId,outletId},sale,order:order??null,customer:customer??null})});
  }
  for(const entry of records.entries){
    const account=accounts.get(entry.accountId),customer=account?customers.get(account.customerId):undefined;
    const at=entry.occurredAt??entry.createdAt;
    if(entry.outletId!==outletId||entry.type!=='payment'||entry.reversalOf||entry.refundId||reversals.has(entry.id)||!account||!customer||entry.customerId!==customer.id||entry.currency!==account.currency||entry.amount!==source.amount||entry.currency!==source.currency||!time(at))continue;
    consider({...base(at),kind:'credit',id:entry.id,state:'recorded',label:'Khata collection',customerName:customer.nickname||customer.name,phone:customer.phone??null,methodName:entry.methodName??null,orderId:entry.orderId??null,snapshot:()=>({scope:{businessId,outletId},entry,account,customer})});
  }
  result.candidates=best.map(({snapshot,...candidate})=>({...candidate,fingerprint:syncDownloadToken(snapshot())}));
  result.selection=result.candidates.length===0?'none':result.eligibleCount===1&&!invalidDuplicate&&source.status==='recognized'&&source.direction==='incoming'&&(source.timeSource==='message'||options.receivedTimeConfirmed===true)?'automatic':'choose';
  return result;
}
