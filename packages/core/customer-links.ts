import type {CreditEntry,Order,OrderLine} from './models';
import {marketPacks,type MarketCode} from './packs';
import {orderFlows} from './orders';
import {orderLineTotal,orderPricing} from './order-lines';

export type CustomerLinkKind='order'|'khata';
export interface CustomerLinkRequest {kind:CustomerLinkKind;token:string;afterSequence:number;pageSize:number}
interface CustomerShop {name:string;outletName:string;url:string|null;market:MarketCode}
export type CustomerOrder=Pick<Order,'id'|'number'|'businessType'|'type'|'status'|'statusChangedAt'|'currency'|'subtotal'|'deliveryFee'|'discount'|'total'|'timezone'> & {
 scheduledFor:number|null;lines:OrderLine[];paymentStatus:Order['payment']['status'];
};
export interface CustomerEntry {id:string;sequence:number;type:Exclude<CreditEntry['type'],'reminder'>;amount:number;delta:number;at:number;reversalOf:string|null;methodName:string|null}
export type CustomerLink={v:1;kind:'order';shop:CustomerShop;order:CustomerOrder}|{v:1;kind:'khata';shop:CustomerShop;account:{id:string;customerName:string;currency:string;balance:number;entries:CustomerEntry[];nextSequence:number;hasMore:boolean;timezone:string}};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const sequence=(value:unknown):value is number=>integer(value)&&value>=0;
const time=(value:unknown):value is number=>sequence(value)&&value<=8640000000000000;
const money=(value:unknown):value is number=>sequence(value);
const text=(value:unknown):value is string=>typeof value==='string';
const invalid=()=>Error('This customer link is unavailable.');
const literal=(value:unknown):string=>{if(!text(value))throw invalid();const decoded:unknown=JSON.parse(value);if(!text(decoded))throw invalid();return decoded;};
function timezone(value:unknown):string {if(!text(value))throw invalid();try{new Intl.DateTimeFormat('en',{timeZone:value});}catch{throw invalid();}return value;}
function currency(value:unknown):string {if(!text(value)||! /^[A-Z]{3}$/.test(value))throw invalid();return value;}

export function parseCustomerLinkRequest(value:unknown):CustomerLinkRequest {
 if(!object(value)||!['order','khata'].includes(value.kind as string)||typeof value.token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value.token)||
  Object.keys(value).some(key=>!['kind','token',...(value.kind==='khata'?['afterSequence','pageSize']:[])].includes(key)))throw invalid();
 const after=value.afterSequence===undefined?0:value.afterSequence,size=value.pageSize===undefined?50:value.pageSize;
 if(!sequence(after)||!integer(size)||size<1||size>100)throw invalid();
 return {kind:value.kind as CustomerLinkKind,token:value.token,afterSequence:after,pageSize:size};
}

/** Copy only customer-approved fields; backend additions never become public
 * merely because an upstream object acquired another property. */
function line(value:unknown):OrderLine {
 if(!object(value)||!id(value.id)||!text(value.name)||!value.name||value.name.length>120||!text(value.unit)||!value.unit||value.unit.length>24||
  !text(value.note)||value.note.length>500||typeof value.qty!=='number'||!Number.isFinite(value.qty)||value.qty<=0||value.qty>999999||
  !/^\d+(?:\.\d{1,3})?$/.test(String(value.qty))||typeof value.unavailable!=='boolean'||value.unitPrice!==null&&!money(value.unitPrice)||
  value.lineTotal!==null&&!money(value.lineTotal)||value.itemId!==undefined&&!id(value.itemId))throw invalid();
 if(value.unitPrice===null?value.lineTotal!==null:value.lineTotal!==orderLineTotal(value.unitPrice as number,value.qty))throw invalid();
 let substitution:OrderLine['substitution'];
 if(value.substitution!==undefined){
  const s=value.substitution;if(!object(s)||!text(s.from)||!s.from||s.from.length>120||typeof s.accepted!=='boolean'||s.acceptedAt!==undefined&&!time(s.acceptedAt))throw invalid();
  substitution={from:s.from,accepted:s.accepted,...(s.acceptedAt===undefined?{}:{acceptedAt:s.acceptedAt as number})};
 }
 return {id:value.id,...(value.itemId===undefined?{}:{itemId:value.itemId as string}),name:value.name,unit:value.unit,qty:value.qty,
  unitPrice:value.unitPrice as number|null,lineTotal:value.lineTotal as number|null,note:value.note,unavailable:value.unavailable,...(substitution?{substitution}:{})};
}
export function projectCustomerLink(value:unknown,request:CustomerLinkRequest):CustomerLink {
 if(!object(value)||value.v!==1||value.kind!==request.kind||!text(value.marketCode)||!Object.hasOwn(marketPacks,value.marketCode)||value.shopLink!==null&&!text(value.shopLink))throw invalid();
 const shop:CustomerShop={name:literal(value.shopNameJson),outletName:literal(value.outletNameJson),url:value.shopLink as string|null,market:value.marketCode as MarketCode};
 if(request.kind==='order'){
  const o=value.order;if(!object(o)||!id(o.id)||!text(o.number)||!text(o.businessType)||!Object.hasOwn(orderFlows,o.businessType)||
   !['delivery','pickup','dine_in'].includes(o.type as string)||!text(o.status)||o.status!=='cancelled'&&!orderFlows[o.businessType as Order['businessType']].includes(o.status as Order['status'])||
   !time(o.statusChangedAt)||o.scheduledFor!==null&&!time(o.scheduledFor)||!money(o.subtotal)||!money(o.deliveryFee)||!money(o.discount)||o.total!==null&&!money(o.total)||
   !['pending','paid','credited'].includes(o.paymentStatus as string)||!text(o.linesJson))throw invalid();
  const raw:unknown=JSON.parse(o.linesJson);if(!Array.isArray(raw)||!raw.length||raw.length>200)throw invalid();const lines=raw.map(line);
  if(new Set(lines.map(x=>x.id)).size!==lines.length)throw invalid();
  const pricing=orderPricing(lines,o.deliveryFee as number,o.discount as number);if(pricing.subtotal!==o.subtotal||pricing.total!==o.total)throw invalid();
  return {v:1,kind:'order',shop,order:{id:o.id,number:o.number,businessType:o.businessType as Order['businessType'],type:o.type as Order['type'],status:o.status as Order['status'],
   statusChangedAt:o.statusChangedAt,scheduledFor:o.scheduledFor as number|null,currency:currency(o.currency),subtotal:o.subtotal as number,deliveryFee:o.deliveryFee as number,discount:o.discount as number,
   total:o.total as number|null,lines,timezone:timezone(o.timezone),paymentStatus:o.paymentStatus as Order['payment']['status']}};
 }
 const a=value.account;if(!object(a)||!id(a.id)||!integer(a.balance)||!sequence(a.nextSequence)||a.nextSequence<request.afterSequence||typeof a.hasMore!=='boolean'||
  !Array.isArray(a.entries)||a.entries.length>request.pageSize)throw invalid();
 let previous=request.afterSequence;const ids=new Set<string>();
 const entries:CustomerEntry[]=a.entries.map((entry:unknown)=>{
  if(!object(entry)||!id(entry.id)||ids.has(entry.id)||!sequence(entry.sequence)||entry.sequence<=previous||!['charge','payment','adjustment','refund'].includes(entry.type as string)||
   !integer(entry.amount)||entry.type!=='adjustment'&&entry.amount<0||!integer(entry.delta)||!time(entry.at)||entry.reversalOf!==null&&!id(entry.reversalOf)||
   entry.methodNameJson!==null&&!text(entry.methodNameJson))throw invalid();
  const delta=entry.type==='payment'?-entry.amount:entry.type==='refund'?0:entry.amount;if(entry.delta!==delta)throw invalid();
  previous=entry.sequence;ids.add(entry.id);
  return {id:entry.id,sequence:entry.sequence,type:entry.type as CustomerEntry['type'],amount:entry.amount,delta:entry.delta,at:entry.at,
   reversalOf:entry.reversalOf as string|null,methodName:entry.methodNameJson===null?null:literal(entry.methodNameJson)};
 });
 if(a.nextSequence!==previous||a.hasMore&&!entries.length)throw invalid();
 return {v:1,kind:'khata',shop,account:{id:a.id,customerName:literal(a.customerNameJson),currency:currency(a.currency),balance:a.balance,entries,nextSequence:a.nextSequence,hasMore:a.hasMore,timezone:timezone(a.timezone)}};
}
