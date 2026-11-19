import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {parseMoneyCommand,type MoneyCommand} from './money-commands';
import {recordSaleCommand,undoSaleCommand} from './sales';
import {recordCreditSaleCommand,undoCreditSaleCommand} from './credit-sales';
import {CreditLimitError,recordCreditPaymentCommand,undoCreditEntryCommand,recordCommunicationCommand,type CustomerLedgerContext} from './khata';
import type {CustomerSetup} from './customers';
import {marketPacks} from './packs';
import type {AuditEvent,Business,CreditAccount,CreditEntry,Customer,Item,Outlet,Sale} from './models';
export class MoneyMutationInvalid extends Error {}
export class MoneyMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function moneyFingerprint(c:MoneyCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseMoneyCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
/** Pure tentative projection; callers must separately verify authorization and canonical context. */
export function replayMoneyRecords(value:unknown,c:MoneyCommand):CloudRecord[]{
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid money context.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.customer,raw.account,raw.sale,raw.entry].every(r=>r===null||object(r))||!Array.isArray(raw.entries)||!raw.entries.every(object)||!Array.isArray(raw.items)||!raw.items.every(object))throw new Error('Invalid money records.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 const customer=raw.customer?decodeCommandRecord('customers',raw.customer as Record<string,unknown>) as unknown as Customer:null;
 const account=raw.account?decodeCommandRecord('creditAccounts',raw.account as Record<string,unknown>) as unknown as CreditAccount:null;
 const before=raw.sale?decodeCommandRecord('sales',raw.sale as Record<string,unknown>) as unknown as Sale:null;
 const entry=raw.entry?decodeCommandRecord('creditEntries',raw.entry as Record<string,unknown>) as unknown as CreditEntry:null;
 const entries=raw.entries.map(e=>decodeCommandRecord('creditEntries',e) as unknown as CreditEntry),items=raw.items.map(i=>decodeCommandRecord('items',i) as unknown as Item);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||items.some(i=>i.outletId!==outlet.id)||account&&(account.outletId!==outlet.id||!customer||account.customerId!==customer.id||customer.businessId!==business.id)||entries.some(e=>!account||e.accountId!==account.id||e.outletId!==outlet.id||e.customerId!==account.customerId)||before&&before.outletId!==outlet.id||entry&&(!account||entry.accountId!==account.id))throw new Error('Invalid money scope.');
 const setup:CustomerSetup={business,outlet,owner:{id:value.actorId}},wallets=marketPacks[business.marketCode]['pay/wallets'];
 const ledger=():CustomerLedgerContext=>{if(!account||!customer)throw new Error('Khata unavailable');return {setup,customer,account,entries};};
 let sale:Sale|null=null,createdEntry:CreditEntry|null=null,events:AuditEvent[]=[];
 try{
  if(c.occurredAt>value.at+300000)throw new Error('Check the device clock.');
  if(c.type==='sale.record'){
   const r=recordSaleCommand({...c.input,wallet:c.input.wallet??undefined,given:c.input.given??undefined},{setup,wallets,items},c.occurredAt,kind=>kind==='sale'?c.saleId:c.id);sale=r.sale;events=[r.event];
  }else if(c.type==='sale.credit'){
   if(account?.id!==c.accountId)throw new Error('Khata changed.');
   const r=recordCreditSaleCommand({expression:c.input.expression,items:c.input.items,accountId:c.accountId,customerId:customer!.id,confirmation:c.input.confirmation??undefined},ledger(),{setup,wallets,items},c.occurredAt,kind=>kind==='sale'?c.saleId:kind==='entry'?c.entryId:kind==='event'?c.id:c.creditEventId);
   sale=r.sale;createdEntry=r.entry;events=[r.event,r.creditEvent];
  }else if(c.type==='sale.undo'){
   if(!before||before.id!==c.saleId||before.orderId||c.occurredAt<before.createdAt)throw new Error('Use the original counter receipt.');
   if(before.method==='credit'){
    if(!entry||!c.entryId||!c.creditEventId)throw new Error('Use the matching credit reversal IDs.');
    const r=undoCreditSaleCommand(before,entry,ledger(),value.at,kind=>kind==='entry'?c.entryId!:kind==='event'?c.id:c.creditEventId!);sale=r.sale;createdEntry=r.entry;events=[r.event,r.creditEvent];
   }else{
    if(c.entryId||c.creditEventId)throw new Error('A cash receipt has no khata reversal.');
    const r=undoSaleCommand(before,value.actorId,value.at,()=>c.id);sale=r.sale;events=[r.event];
   }
   sale.voidedAt=c.occurredAt;
  }else if(c.type==='khata.payment'){
   if(account?.id!==c.accountId)throw new Error('Khata changed.');
   const r=recordCreditPaymentCommand(c.input.amount,c.input.method,c.input.wallet??undefined,ledger(),wallets,c.input.note,c.occurredAt,kind=>kind==='entry'?c.entryId:c.id);createdEntry=r.entry;events=[r.event];
  }else if(c.type==='khata.undo'){
   if(!entry||entry.id!==c.entryId||entry.saleId||entry.orderId||entry.refundId||entry.returnsChargeId||c.occurredAt<entry.createdAt)throw new Error('Undo the original sale or order for linked money.');
   const r=undoCreditEntryCommand(entry,ledger(),value.at,false,kind=>kind==='entry'?c.reversalId:c.id);createdEntry=r.entry;events=[r.event];
  }else{
   if(account?.id!==c.accountId)throw new Error('Khata changed.');
   const r=recordCommunicationCommand(ledger(),c.input.purpose,c.input.text,c.input.channel,c.occurredAt,kind=>kind==='entry'?c.entryId:c.id);createdEntry=r.entry;events=[r.event];
  }
 }catch(error){if(error instanceof CreditLimitError)throw new MoneyMutationConflict('Review the exact current credit balance and limit.');throw new MoneyMutationInvalid('Check this money action, balance, receipt or device time.');}
 if(sale)sale.updatedAt=Math.max(value.at,sale.createdAt,c.occurredAt);
 if(createdEntry){createdEntry.createdAt=c.occurredAt;createdEntry.updatedAt=Math.max(value.at,c.occurredAt);}
 for(const e of events)e.at=value.at;
 const records:CloudRecord[]=[];if(sale)records.push(encodeCommandRecord('sales',sale,business.id));if(createdEntry)records.push(encodeCommandRecord('creditEntries',createdEntry,business.id));records.push(...events.map(e=>encodeCommandRecord('events',e,business.id)));
 if(!events.some(e=>e.id===c.id)||events.some(e=>e.actor.id!==value.actorId))throw new Error('Invalid money audit identity.');
 return records;
}
