import {cloudRecordMaps,decodeCommandRecord,decodeProposedCommandRecord,type CloudRecord} from './cloud-records';
import {validateBackupRow} from './backup-schema';
import {reviewedCustomerProposal} from './customer-review';
import {parseCustomerReviewRequest,parseCustomerReviewSource,type CustomerReviewRequest,type CustomerSourceAccount,type CustomerSourceOpening,type CustomerSourceProfile} from './customer-review-source';
import {customerReviewEffectsMatch} from './customer-review-effects';
import {replayCustomerRecords} from './customer-replay';
import {syncDownloadToken} from './sync-download';
import type {Business,Outlet,Customer,CreditAccount} from './models';

// A serialized view escapes its opaque context again. Preserve the complete
// 4 MB context within a separately bounded HTTP envelope.
export const customerReviewContextLimit=4_000_000;
export const customerReviewResponseLimit=16_000_000;
export interface CustomerReviewContext {business:Business;outlet:Outlet;customer:Customer|null;accounts:CreditAccount[];hasBalance:boolean}
export interface CustomerReviewCurrent {
 stateHash:string;contextJson:string;balances:{accountId:string;balance:number}[];phoneTaken:boolean;available:boolean;
}
export type CustomerReviewProfileProjection=Omit<CustomerSourceProfile,'createdAt'|'updatedAt'|'archivedAt'|'consent'>&{archived:boolean;consentRenewed:boolean};
export type CustomerReviewAccountProjection=Omit<CustomerSourceAccount,'createdAt'|'updatedAt'>;
export type CustomerReviewOpeningProjection=Omit<CustomerSourceOpening,'createdAt'|'updatedAt'>;
export type CustomerReviewProposal=
 |{enabled:false;reason:'account'|'unit'|'phone'|'unavailable'}
 |{enabled:true;customer:CustomerReviewProfileProjection|null;account:CustomerReviewAccountProjection|null;opening:CustomerReviewOpeningProjection|null};
export interface PreparedCustomerReview {
 v:1;id:string;replacementId:string;commandId:string;commandHash:string;sourceHash:string;businessId:string;outletId:string;actorId:string;
 token:string;at:number;expiresAt:number;current:CustomerReviewCurrent;proposal:CustomerReviewProposal;
}
export type CustomerReviewMetadata=Omit<PreparedCustomerReview,'current'|'proposal'>;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);

/** Decode only the original customer's current outlet. SQL-only public fields
 * are allowlisted; Auth identities, tokens and other private columns are refused.
 * The opaque context retains literal code units without a JSONB conversion. */
export function readCustomerReviewContext(contextJson:string,businessId:string,outletId:string,customerId:string):CustomerReviewContext{
 if(typeof contextJson!=='string'||new TextEncoder().encode(contextJson).length>customerReviewContextLimit)throw Error('Keep the complete bounded customer comparison.');
 const raw:unknown=JSON.parse(contextJson);
 if(!object(raw)||!exact(raw,'business,outlet,customer,accounts,hasBalance')||!object(raw.business)||!object(raw.outlet)||!(raw.customer===null||object(raw.customer))||!Array.isArray(raw.accounts)||!raw.accounts.every(object)||typeof raw.hasBalance!=='boolean')throw Error('Keep the complete current customer context.');
 const decode=(table:'businesses'|'outlets'|'customers'|'creditAccounts',value:Record<string,unknown>)=>{
  const allowed=new Set([...Object.keys(cloudRecordMaps[table].fields),'business_id',...(table==='outlets'?['opening_hours','delivery_zones']:table==='creditAccounts'?['notes']:[])]);
  if(Object.keys(value).some(k=>!allowed.has(k))||(table!=='businesses'||value.business_id!==undefined)&&value.business_id!==businessId||table==='creditAccounts'&&value.notes!==undefined&&typeof value.notes!=='string')throw Error('Keep only scoped public customer records.');
  const row=decodeCommandRecord(table,value);validateBackupRow(table,row,'Customer review '+table);return row;
 };
 const business=decode('businesses',raw.business) as unknown as Business,outlet=decode('outlets',raw.outlet) as unknown as Outlet,
  customer=raw.customer===null?null:decode('customers',raw.customer) as unknown as Customer,
  accounts=raw.accounts.map(row=>decode('creditAccounts',row) as unknown as CreditAccount);
 if(business.id!==businessId||outlet.id!==outletId||outlet.businessId!==businessId||customer&&(customer.id!==customerId||customer.businessId!==businessId)||
  accounts.some(a=>a.customerId!==customerId||a.outletId!==outletId)||new Set(accounts.map(a=>a.id)).size!==accounts.length||new Set(accounts.map(a=>a.currency)).size!==accounts.length)throw Error('Keep the original customer and current outlet accounts.');
 return {business,outlet,customer,accounts,hasBalance:raw.hasBalance};
}
/** Proposal clocks are recorded on admission. They are not user choices; opening
 * balance occurrence dates and all financial identities remain in the projection. */
export function customerReviewProjection(records:readonly CloudRecord[],before:Customer|null):Extract<CustomerReviewProposal,{enabled:true}>{
 const find=(table:string)=>records.find(r=>r.table===table);
 const customerRow=find('customers'),accountRow=find('credit_accounts'),openingRow=find('credit_entries');
 let customer:CustomerReviewProfileProjection|null=null,account:CustomerReviewAccountProjection|null=null,opening:CustomerReviewOpeningProjection|null=null;
 if(customerRow){
  const after=decodeProposedCommandRecord('customers',customerRow) as unknown as Customer;
  customer={id:after.id,businessId:after.businessId,name:after.name,nickname:after.nickname,phone:after.phone??null,address:after.address,notes:after.notes,tags:[...after.tags],archived:after.archivedAt!==undefined,consentRenewed:before===null||before.phone!==after.phone};
 }
 if(accountRow){const after=decodeProposedCommandRecord('creditAccounts',accountRow) as unknown as CreditAccount;account={id:after.id,customerId:after.customerId,outletId:after.outletId,currency:after.currency,allowed:after.allowed,limit:after.limit,reminder:{...after.reminder}};}
 if(openingRow){const after=decodeProposedCommandRecord('creditEntries',openingRow) as unknown as CustomerSourceOpening;opening={id:after.id,accountId:after.accountId,customerId:after.customerId,outletId:after.outletId,currency:after.currency,sequence:after.sequence,type:after.type,amount:after.amount,note:after.note,occurredAt:after.occurredAt,createdBy:after.createdBy,eventId:after.eventId};}
 return {enabled:true,customer,account,opening};
}
function projection(input:CustomerReviewRequest,metadata:CustomerReviewMetadata,current:CustomerReviewCurrent,context:CustomerReviewContext):CustomerReviewProposal{
 const c=input.command,source=parseCustomerReviewSource(input),savedAccount=source.events.find(e=>e.kind==='account');
 if(!current.available)return {enabled:false,reason:'unavailable'};
 if(current.phoneTaken&&(c.type==='customer.create'||c.type==='customer.update'))return {enabled:false,reason:'phone'};
 if(savedAccount&&savedAccount.kind==='account'&&savedAccount.before===null&&savedAccount.after.currency!==context.outlet.currency)return {enabled:false,reason:'unit'};
 try{
  const records=replayCustomerRecords({...metadata,contextJson:current.contextJson},reviewedCustomerProposal(c,input.replacementId));
  if(!customerReviewEffectsMatch(input,records))return {enabled:false,reason:'account'};
  return customerReviewProjection(records,context.customer);
 }catch{return {enabled:false,reason:'unavailable'};}
}
/** A structural/current-state contract. The caller must also verify the original
 * command hash and authoritative state hash; this parser grants no permission. */
export function parsePreparedCustomerReview(value:unknown,request:CustomerReviewRequest):PreparedCustomerReview{
 const input=parseCustomerReviewRequest(request,false),c=input.command,source=parseCustomerReviewSource(input);
 if(!object(value)||!exact(value,'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal')||value.v!==1||
  value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||!hash(value.commandHash)||value.sourceHash!==input.sourceHash||
  value.businessId!==source.businessId||value.outletId!==c.outletId||!id(value.actorId)||value.actorId!==source.events[0].actorId||
  typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>300000||
  !object(value.current)||!object(value.proposal))throw Error('Review the original customer action again.');
 const raw=value.current;
 if(!exact(raw,'stateHash,contextJson,balances,phoneTaken,available')||!hash(raw.stateHash)||typeof raw.contextJson!=='string'||!Array.isArray(raw.balances)||typeof raw.phoneTaken!=='boolean'||typeof raw.available!=='boolean')throw Error('Keep the complete current customer comparison.');
 const context=readCustomerReviewContext(raw.contextJson,source.businessId,c.outletId,c.customerId),accounts=new Set(context.accounts.map(a=>a.id));
 const balances=raw.balances.map(row=>{
  if(!object(row)||!exact(row,'accountId,balance')||!id(row.accountId)||!accounts.has(row.accountId)||typeof row.balance!=='number'||!Number.isSafeInteger(row.balance))throw Error('Keep each actual scoped khata balance.');
  return {accountId:row.accountId,balance:row.balance};
 });
 if(balances.length!==accounts.size||new Set(balances.map(b=>b.accountId)).size!==balances.length||
  (c.type==='customer.archive'||c.type==='customer.restore')&&!context.hasBalance&&balances.some(b=>b.balance!==0)||
  c.type!=='customer.archive'&&c.type!=='customer.restore'&&context.hasBalance)throw Error('Keep the complete scoped balance comparison.');
 const current:CustomerReviewCurrent={stateHash:raw.stateHash,contextJson:raw.contextJson,balances,phoneTaken:raw.phoneTaken,available:raw.available},
  metadata:CustomerReviewMetadata={v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:source.businessId,outletId:c.outletId,actorId:value.actorId,token:value.token,at:value.at,expiresAt:value.expiresAt};
 let proposal:CustomerReviewProposal;
 if(value.proposal.enabled===false){
  if(!exact(value.proposal,'enabled,reason')||!['account','unit','phone','unavailable'].includes(value.proposal.reason as string))throw Error('Keep the unavailable customer proposal.');
  proposal={enabled:false,reason:value.proposal.reason as Extract<CustomerReviewProposal,{enabled:false}>['reason']};
 }else{
  const expected=projection(input,metadata,current,context);
  if(value.proposal.enabled!==true||expected.enabled!==true||!same(value.proposal,expected))throw Error('Keep the original customer inputs and financial effects in the reviewed proposal.');
  proposal=expected;
 }
 return {...metadata,current,proposal};
}
export function prepareCustomerReviewView(metadata:CustomerReviewMetadata,current:CustomerReviewCurrent,input:CustomerReviewRequest):PreparedCustomerReview{
 const context=readCustomerReviewContext(current.contextJson,metadata.businessId,metadata.outletId,input.command.customerId);
 return parsePreparedCustomerReview({...metadata,current,proposal:projection(input,metadata,current,context)},input);
}
