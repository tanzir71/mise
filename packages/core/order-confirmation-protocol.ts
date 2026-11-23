import {decidedQuote,parseCheckoutWallet,parseOrderConfirmation,parseOrderQuote,type CheckoutWallet,type OrderConfirmation,type OrderQuote} from './order-confirmation';
import {publicOrderHash} from './public-order-submission';
export interface QuotedOrder {v:1;state:'quote';quoteJson:string;quoteHash:string;quote:OrderQuote}
export interface ConfirmationReceipt {orderId:string;revision:number;total:number;currency:string;paymentStatus:'pending'|'paid'|'credited';at:number;saleId:string|null;entryId:string|null}
export interface ConfirmationOutcome {v:1;id:string;intentJson:string;state:'pending'|'closed'|'applied';closedAt:number|null;receipt:ConfirmationReceipt|null}
export interface CheckoutRequest {token:string;action:'quote'|'submit'|'inspect'|'close'|'payment';intent:OrderConfirmation|null}
export interface CheckoutPayment {v:1;state:'payment';id:string;orderId:string;settingsRevision:number;wallet:CheckoutWallet}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=()=>Error('Keep the original confirmation and check it before sending another.');
export const confirmationIntentJson=(value:OrderConfirmation)=>JSON.stringify(parseOrderConfirmation(value));
export function parseCheckoutRequest(value:unknown,quote:boolean):CheckoutRequest {
 if(!object(value)||!exact(value,quote?'v,token':'v,token,action,intent')||value.v!==1||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token))throw fail();
 if(quote)return {token:value.token,action:'quote',intent:null};
 if(!['submit','inspect','close','payment'].includes(value.action as string))throw fail();
 return {token:value.token,action:value.action as CheckoutRequest['action'],intent:parseOrderConfirmation(value.intent)};
}
export function parseCheckoutPayment(value:unknown,original:OrderConfirmation,quote?:OrderQuote):CheckoutPayment {
 const intent=parseOrderConfirmation(original);
 if(intent.payment.method!=='wallet'||!object(value)||!exact(value,'v,state,id,orderId,settingsRevision,wallet')||value.v!==1||value.state!=='payment'||value.id!==intent.id||!id(value.orderId)||!int(value.settingsRevision,1))throw fail();
 const wallet=parseCheckoutWallet(value.wallet);
 if(wallet.id!==intent.payment.walletId||quote&&(value.orderId!==quote.orderId||wallet.name!==quote.wallets.find(w=>w.id===intent.payment.walletId)?.name))throw fail();
 return {v:1,state:'payment',id:intent.id,orderId:value.orderId,settingsRevision:value.settingsRevision,wallet};
}
export async function parseQuotedOrder(value:unknown):Promise<QuotedOrder> {
 if(!object(value)||!exact(value,'v,state,quoteJson,quoteHash')||value.v!==1||value.state!=='quote'||typeof value.quoteJson!=='string'||new TextEncoder().encode(value.quoteJson).byteLength>1048576||typeof value.quoteHash!=='string'||!/^[0-9a-f]{64}$/.test(value.quoteHash)||await publicOrderHash(value.quoteJson)!==value.quoteHash)throw fail();
 return {v:1,state:'quote',quoteJson:value.quoteJson,quoteHash:value.quoteHash,quote:parseOrderQuote(JSON.parse(value.quoteJson))};
}
export function parseConfirmationOutcome(value:unknown,original:OrderConfirmation,quote?:OrderQuote):ConfirmationOutcome {
 const intent=parseOrderConfirmation(original);
 if(!object(value)||!exact(value,'v,id,intentJson,state,closedAt,receipt')||value.v!==1||value.id!==intent.id||value.intentJson!==confirmationIntentJson(intent)||!['pending','closed','applied'].includes(value.state as string))throw fail();
 if(value.state!=='applied'){
  if(value.receipt!==null||(value.state==='pending'?value.closedAt!==null:!int(value.closedAt,0,8640000000000000)))throw fail();
  return {v:1,id:intent.id,intentJson:value.intentJson as string,state:value.state as 'pending'|'closed',closedAt:value.closedAt as number|null,receipt:null};
 }
 const r=value.receipt;
 if(value.closedAt!==null||!quote||!object(r)||!exact(r,'orderId,revision,total,currency,paymentStatus,at,saleId,entryId')||!id(r.orderId)||r.orderId!==quote.orderId||r.currency!==quote.currency||!int(r.total)||!int(r.at,0,8640000000000000))throw fail();
 const total=decidedQuote(quote,intent.swaps,r.at).total,credit=intent.payment.method==='credit'&&r.total>0;
 if(r.total!==total||r.revision!==quote.revision+1+(quote.status==='requested'?2:1)+(intent.payment.method==='credit'?1:0)||r.paymentStatus!==(credit?'credited':intent.payment.method==='credit'?'paid':'pending')||r.saleId!==(credit?intent.ids.saleId:null)||r.entryId!==(credit?intent.ids.entryId:null))throw fail();
 return {v:1,id:intent.id,intentJson:value.intentJson as string,state:'applied',closedAt:null,receipt:{orderId:r.orderId,revision:r.revision as number,total:r.total,currency:r.currency as string,paymentStatus:r.paymentStatus as ConfirmationReceipt['paymentStatus'],at:r.at,saleId:r.saleId as string|null,entryId:r.entryId as string|null}};
}
