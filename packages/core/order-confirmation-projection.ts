import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {parseOrderConfirmation,parseOrderQuote,confirmOrderCommand,type OrderConfirmation} from './order-confirmation';
import {publicOrderHash} from './public-order-submission';
import type {Business,Outlet,Member,Order,Customer,CreditAccount,CreditEntry} from './models';
import type {ShopSetup} from './shop-access';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const fail=()=>Error('Review the current order and original confirmation.');
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
/** The private service preparation supplies all tenancy, current records,
 * responsible member and clock. The customer supplies only its saved choices.
 * Raw context is never part of an anonymous HTTP response. */
export async function orderConfirmationRecords(preparation:unknown,original:OrderConfirmation):Promise<CloudRecord[]> {
 const intent=parseOrderConfirmation(original),p=preparation;
 if(!object(p)||!exact(p,'v,state,id,ticketToken,businessId,outletId,actorId,at,contextJson')||p.v!==1||p.state!=='prepared'||p.id!==intent.id||typeof p.ticketToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.ticketToken)||!id(p.businessId)||!id(p.outletId)||!id(p.actorId)||!Number.isSafeInteger(p.at)||Number(p.at)<0||typeof p.contextJson!=='string')throw fail();
 const raw:unknown=JSON.parse(p.contextJson);
 if(!object(raw)||!exact(raw,'quoteJson,business,outlet,actor,order,customer,account,entries')||typeof raw.quoteJson!=='string'||await publicOrderHash(raw.quoteJson)!==intent.quoteHash||!Array.isArray(raw.entries)||!object(raw.business)||!object(raw.outlet)||!object(raw.actor)||!object(raw.order))throw fail();
 const quote=parseOrderQuote(JSON.parse(raw.quoteJson)),business=decodeCommandRecord('businesses',raw.business) as unknown as Business,
  outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,actor=decodeCommandRecord('members',raw.actor) as unknown as Member,
  order=decodeCommandRecord('orders',raw.order) as unknown as Order;
 if(business.id!==p.businessId||outlet.businessId!==business.id||outlet.id!==p.outletId||actor.businessId!==business.id||actor.id!==p.actorId||!actor.active||!['owner','manager'].includes(actor.role)||order.outletId!==outlet.id||order.id!==quote.orderId)throw fail();
 // Current membership/assignment is checked by both SQL preparation and final
 // completion. This adapter does not take an assignment from customer data.
 const setup:ShopSetup={business,outlet,owner:{...actor,outletIds:[outlet.id]}},customer=raw.customer===null?undefined:object(raw.customer)?decodeCommandRecord('customers',raw.customer) as unknown as Customer:undefined;
 if(order.customer.id&&(!customer||customer.id!==order.customer.id||customer.businessId!==business.id))throw fail();
 let ledger;
 if(quote.credit!==null){
  if(!customer||!object(raw.account))throw fail();
  const account=decodeCommandRecord('creditAccounts',raw.account) as unknown as CreditAccount,entries=raw.entries.map(value=>{if(!object(value))throw fail();return decodeCommandRecord('creditEntries',value) as unknown as CreditEntry;});
  if(account.customerId!==customer.id||account.outletId!==outlet.id||entries.some(e=>e.accountId!==account.id||e.customerId!==customer.id||e.outletId!==outlet.id))throw fail();
  ledger={setup,customer,account,entries};
 }
 const result=confirmOrderCommand(order,quote,intent,{setup,customer,items:[],sequence:order.sequence,ledger,quoteHash:intent.quoteHash},p.at as number),records:CloudRecord[]=[];
 for(const [table,rows] of [['orders',[result.order]],['events',result.events],['sales',result.sales],['creditEntries',result.entries]] as const)
  for(const row of rows)records.push(encodeCommandRecord(table,row as unknown as Record<string,unknown>,business.id));
 return records;
}
