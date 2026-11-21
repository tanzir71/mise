import {parseCustomerCommand,customerFingerprint} from './customer-commands';
import {parseCustomerResolutionReceipt,reviewedCustomerProposal} from './customer-review';
import {parseCustomerReviewSource,customerReviewCreatedIds} from './customer-review-source';
import type {AuditEvent} from './models';
import type {MiseBackup} from './backup-tables';
import type {CloudRecord} from './cloud-records';

export class CustomerReviewBoundaryError extends Error {
 constructor(readonly kind:'conflict'|'integrity'){super(kind==='conflict'?'Keep the original customer and khata identities after reviewing the saved action.':'Keep the complete canonical customer resolution proof.');}
}
export interface CustomerReviewBoundary {assert(records:readonly CloudRecord[],current:MiseBackup):void}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const customerType=(v:unknown)=>typeof v==='string'&&(v.startsWith('customer.')||v==='khata.settings');
const protectedTables={customers:'customers',credit_accounts:'creditAccounts',credit_entries:'creditEntries',events:'events'} as const;
/** Build once from the checked canonical snapshot. This blocks tentative
 * resurrection of actual created identities; it supplies no write authority. */
export async function customerReviewBoundary(events:readonly AuditEvent[],outletId:string):Promise<CustomerReviewBoundary>{
 const reserved=new Set<string>(),positions=new Set<string>();
 for(const event of events){
  if(event.command!=='sync.resolve'||event.outletId!==outletId)continue;
  const before=event.before,after=event.after;
  if(!(object(before)&&customerType(before.commandType)||object(after)&&('customerResolutionPosition'in after||object(after.receipt)&&customerType(after.receipt.commandType))))continue;
  try{
   if(!object(before)||!customerType(before.commandType)||typeof before.originalCommandJson!=='string'||typeof before.sourceJson!=='string'||!object(after)||typeof after.customerResolutionPosition!=='string'||!/^[1-9][0-9]{0,18}$/.test(after.customerResolutionPosition)||BigInt(after.customerResolutionPosition)>9223372036854775807n||positions.has(after.customerResolutionPosition))throw Error();
   const command=parseCustomerCommand(JSON.parse(before.originalCommandJson)),receipt=parseCustomerResolutionReceipt(after.receipt,command),source=parseCustomerReviewSource({command,sourceJson:before.sourceJson});
   if(command.outletId!==outletId||event.id!==command.id||event.actor.type!=='member'||source.events.some(e=>e.actorId!==event.actor.id)||event.customerId!==undefined&&event.customerId!==command.customerId||event.at!==receipt.at||before.commandId!==command.id||before.commandType!==command.type||before.resolutionId!==receipt.id||before.commandHash!==receipt.commandHash||before.sourceHash!==receipt.sourceHash||receipt.commandHash!==await customerFingerprint(command)||after.resolutionId!==receipt.id||after.outcome!==receipt.outcome||after.replacementId!==(receipt.replacement?.id??null)||receipt.replacement&&receipt.replacement.commandHash!==await customerFingerprint(reviewedCustomerProposal(command,receipt.replacement.id)))throw Error();
   positions.add(after.customerResolutionPosition);for(const id of customerReviewCreatedIds(source))reserved.add(id);
  }catch{throw new CustomerReviewBoundaryError('integrity');}
 }
 return {assert(records,current){
  for(const record of records){
   const table=protectedTables[record.table as keyof typeof protectedTables];if(!table)continue;
   const id=record.values.id;if(typeof id!=='string')throw new CustomerReviewBoundaryError('integrity');
   if(reserved.has(id)&&!current.tables[table].some(row=>row.id===id))throw new CustomerReviewBoundaryError('conflict');
  }
 }};
}
