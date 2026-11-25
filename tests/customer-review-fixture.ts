import {customerSaveIntent,creditTermsIntent} from '../packages/core/customer-intent';
import {archiveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms} from '../packages/core/khata';
import {parseCustomerCommand,parseCustomerCommandReceipt,customerFingerprint,type CustomerCommand} from '../packages/core/customer-commands';
import {prepareCustomerReviewView,type CustomerReviewCurrent} from '../packages/core/customer-review-view';
import {customerReviewSourceAudits,parseCustomerReviewSource,type CustomerReviewRequest} from '../packages/core/customer-review-source';
import {reviewedCustomerProposal} from '../packages/core/customer-review';
import {replayCustomerRecords} from '../packages/core/customer-replay';
import {cloudRecordMap,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {BackupTable} from '../packages/core/backup-tables';
import type {MarketCode} from '../packages/core/packs';
import type {AuditEvent,CreditAccount} from '../packages/core/models';
import type {LocalOutboxEntry,LocalRowChange} from '../packages/core/local-outbox';
import {at,creditFixture} from './credit-fixture';

export const id=(n:number)=>String(n).padStart(26,'0'),literal='Saved · বাংলা\0\ud800';
export const input={name:literal,nickname:'Original',phone:'',address:'Road 12',notes:literal,tags:[' Regular ','regular',literal]};
export const terms={...defaultCreditTerms,allowed:true,limit:45000,reminder:{...defaultCreditTerms.reminder,enabled:true,dayOfMonth:12}};
export const modes=['create-default','create-opening','update-contact','update-terms','update-implicit','update-opening','khata-create','khata-settings','archive','restore'] as const;
type Mode=typeof modes[number];

export function fixture(mode:Mode,draft=input){
 const {context}=creditFixture(),{setup,customer,account}=context;
 let n=10000;const next=()=>id(++n);
 let command:CustomerCommand,events:AuditEvent[],changes:LocalRowChange[]=[];
 if(mode==='khata-create'||mode==='khata-settings'){
  const before=mode==='khata-create'?null:account,result=creditTermsIntent(terms,customer,setup,before,at+1000,next);
  command=result.command;events=[result.mutation.event];changes=[{table:'creditAccounts',key:result.mutation.account.id,before,after:result.mutation.account}];
 }else if(mode==='archive'||mode==='restore'){
  const before=mode==='restore'?{...customer,archivedAt:at+100}:customer,result=archiveCustomerCommand(before,setup,false,mode==='archive',at+1000,next);
  command=parseCustomerCommand({id:result.event.id,type:mode==='archive'?'customer.archive':'customer.restore',customerId:customer.id,outletId:setup.outlet.id});events=[result.event];changes=[{table:'customers',key:customer.id,before,after:result.customer}];
 }else{
  const create=mode.startsWith('create'),hasOpening=mode.endsWith('opening'),before=create?null:customer,existing=create||mode==='update-implicit'||hasOpening?null:account;
  const result=customerSaveIntent(draft,{...(!create?{id:customer.id}:{}),...(mode==='update-terms'?{credit:terms}:{}),...(hasOpening?{opening:{amount:12345,occurredAt:at-86400000}}:{})},{setup,customers:before?[before]:[],accounts:existing?[existing]:[]},at+1000,next);
  command=result.command;events=result.mutation.events;changes=[{table:'customers',key:result.mutation.customer.id,before,after:result.mutation.customer}];
  if(result.mutation.account)changes.push({table:'creditAccounts',key:result.mutation.account.id,before:existing,after:result.mutation.account});
  if(result.mutation.entry)changes.push({table:'creditEntries',key:result.mutation.entry.id,before:null,after:result.mutation.entry});
 }
 changes.push(...events.map(after=>({table:'events' as const,key:after.id,before:null,after})));
 const row:LocalOutboxEntry={id:id(900000),version:1,uploadId:id(900003),businessId:setup.business.id,outletId:setup.outlet.id,sequence:1,at:at+1000,status:'pending',commands:[command],receipts:[],changes};
 const packet:CustomerReviewRequest={id:id(900001),replacementId:id(900002),command,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,businessId:setup.business.id,entryId:row.id,sequence:1,commandIndex:0,at:events[0].at,events:customerReviewSourceAudits(command,events,setup.business.id)})};
 return {setup,customer,account,command,events,row,packet};
}
export function sqlRow(table:BackupTable,value:unknown,businessId:string){
 const fields:Readonly<Record<string,string>>=cloudRecordMap(table).fields;
 return Object.fromEntries(Object.entries(encodeCommandRecord(table,value,businessId).values).map(([key,v])=>[key,typeof v==='string'&&(fields[key]?.startsWith('j:')||fields[key]?.startsWith('e:'))?JSON.parse(v):v]));
}
export function replayContext(f:ReturnType<typeof fixture>,options:{accounts?:CreditAccount[];customer?:unknown;currency?:string;market?:MarketCode;actorId?:string}={}){
 const source=parseCustomerReviewSource(f.packet),profile=source.events.find(e=>e.kind==='customer'),account=source.events.find(e=>e.kind==='account'),
  currentCustomer=Object.hasOwn(options,'customer')?options.customer:profile?profile.before:f.customer,
  accounts=options.accounts??(account?account.before?[account.before]:[]:[f.account]);
 return {businessId:source.businessId,outletId:f.command.outletId,actorId:options.actorId??source.events[0].actorId,at:at+60000,contextJson:JSON.stringify({
  business:sqlRow('businesses',{...f.setup.business,...(options.market?{marketCode:options.market}:{})},source.businessId),
  outlet:sqlRow('outlets',{...f.setup.outlet,...(options.currency?{currency:options.currency}:{})},source.businessId),
  customer:currentCustomer===null?null:sqlRow('customers',currentCustomer,source.businessId),accounts:accounts.map(a=>sqlRow('creditAccounts',a,source.businessId)),hasBalance:false,
 })};
}
export function replay(f:ReturnType<typeof fixture>,options:Parameters<typeof replayContext>[1]={}):CloudRecord[]{return replayCustomerRecords(replayContext(f,options),reviewedCustomerProposal(f.command,f.packet.replacementId));}
export async function reviewView(f=fixture('update-terms'),options:Parameters<typeof replayContext>[1]={},patch:Partial<CustomerReviewCurrent>={}){
 const context=replayContext(f,options),raw=JSON.parse(context.contextJson);
 const current:CustomerReviewCurrent={stateHash:'c'.repeat(64),contextJson:context.contextJson,balances:raw.accounts.map((a:{id:string})=>({accountId:a.id,balance:0})),phoneTaken:false,available:true,...patch};
 return prepareCustomerReviewView({v:1,id:f.packet.id,replacementId:f.packet.replacementId,commandId:f.command.id,commandHash:await customerFingerprint(f.command),sourceHash:f.packet.sourceHash,businessId:context.businessId,outletId:context.outletId,actorId:context.actorId,token:'t'.repeat(43),at:context.at,expiresAt:context.at+120000},current,f.packet);
}
export function ordinaryCustomerReceipt(f:ReturnType<typeof fixture>,c:CustomerCommand=f.command){
 const source=parseCustomerReviewSource(f.packet),account=source.events.find(e=>e.kind==='account'),opening=source.events.find(e=>e.kind==='opening');
 return parseCustomerCommandReceipt({id:c.id,type:c.type,customerId:c.customerId,outletId:c.outletId,accountId:'ids'in c?c.ids.accountId:null,accountEventId:c.type==='khata.settings'?c.id:account?.id??null,entryId:opening?.after.id??null,openingEventId:opening?.id??null,at:source.at+60000,customerUpdatedAt:source.at+60000,accountUpdatedAt:'ids'in c?source.at+60000:null},c);
}
