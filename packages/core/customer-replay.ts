import {customerSaveMutation} from './customer-mutation';
import {archiveCustomerCommand,type CustomerSetup} from './customers';
import {saveCreditTermsCommand} from './khata';
import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import type {Business,CreditAccount,Customer,Outlet} from './models';
import {parseShopCommand,type CustomerCommand} from './shop-commands';
export class CustomerMutationInvalid extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
/** Pure tentative projection. Server authorization and ticket admission are separate. */
export function replayCustomerRecords(value:unknown,c:CustomerCommand):CloudRecord[]{
  if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid customer context.');
  const raw:unknown=JSON.parse(value.contextJson);
  if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!(raw.customer===null||object(raw.customer))||!Array.isArray(raw.accounts)||!raw.accounts.every(object)||typeof raw.hasBalance!=='boolean')throw new Error('Invalid customer records.');
  const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
  const customer=raw.customer===null?null:decodeCommandRecord('customers',raw.customer) as unknown as Customer;
  const accounts=raw.accounts.map(a=>decodeCommandRecord('creditAccounts',a) as unknown as CreditAccount);
  if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||(c.type==='customer.create'?customer!==null:!customer||customer.id!==c.customerId||customer.businessId!==business.id)||!accounts.every(a=>a.outletId===outlet.id&&a.customerId===c.customerId))throw new Error('Invalid customer scope.');
  const setup:CustomerSetup={business,outlet,owner:{id:value.actorId}};let eventIndex=0;
  const mutationId=(kind:'customer'|'account'|'entry'|'event')=>{
    if(kind==='customer')return c.customerId;if(kind==='event'&&eventIndex++===0)return c.id;
    if(!('ids'in c))throw new Error('Unexpected status companion.');
    return kind==='account'?c.ids.accountId:kind==='entry'?c.ids.openingEntryId:eventIndex===2?c.ids.accountEventId:c.ids.openingEventId;
  };
  let records:CloudRecord[]=[];
  try{
    if(c.type==='customer.create'||c.type==='customer.update'){
      const existing=accounts.find(a=>a.currency===outlet.currency);if(existing&&existing.id!==c.ids.accountId)throw new Error('Khata identity changed.');
      const result=customerSaveMutation(c.input,{...(c.type==='customer.update'?{id:c.customerId}:{}),...(c.credit?{credit:c.credit}:{}),...(c.opening?{opening:c.opening}:{})},{setup,customers:customer?[customer]:[],accounts},value.at,mutationId);
      records.push(encodeCommandRecord('customers',result.customer,business.id));
      if(result.account)records.push(encodeCommandRecord('creditAccounts',result.account,business.id));
      if(result.entry)records.push(encodeCommandRecord('creditEntries',result.entry,business.id));
      records.push(...result.events.map(e=>encodeCommandRecord('events',e,business.id)));
    }else if(c.type==='khata.settings'){
      const before=c.accountId?accounts.find(a=>a.id===c.accountId):accounts.find(a=>a.currency===outlet.currency);
      if(c.accountId&&!before)throw new Error('Khata not found.');
      const result=saveCreditTermsCommand(c.input,customer!,setup,before??null,value.at,mutationId);
      records=[encodeCommandRecord('creditAccounts',result.account,business.id),encodeCommandRecord('events',result.event,business.id)];
    }else{
      const result=archiveCustomerCommand(customer!,setup,raw.hasBalance,c.type==='customer.archive',value.at,()=>mutationId('event'));
      records=[encodeCommandRecord('customers',result.customer,business.id),encodeCommandRecord('events',result.event,business.id)];
    }
  }catch{throw new CustomerMutationInvalid('Check the customer, credit terms or opening balance. Settle all khata before archiving.');}
  const events=records.filter(r=>r.table==='events');
  if(!events.some(e=>e.values.id===c.id)||events.some(e=>e.values.actor_id!==value.actorId)||records.some(r=>r.values.business_id!==value.businessId))throw new Error('Invalid generated customer records.');
  return records;
}
export async function customerFingerprint(c:CustomerCommand):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseShopCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');
}
