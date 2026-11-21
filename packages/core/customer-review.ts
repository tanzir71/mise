import {parseCustomerCommand,parseCustomerCommandReceipt,type CustomerCommand,type CustomerCommandReceipt} from './customer-commands';

/** Customer metadata uses the admitted server clock. Only an opening balance
 * carries its own occurrence time, inside the unchanged original command. */
export interface CustomerResolutionReceipt {
 id:string;type:'command.resolved';commandId:string;commandType:CustomerCommand['type'];customerId:string;outletId:string;
 commandHash:string;sourceHash:string;at:number;outcome:'withdrawn'|'replaced';
 replacement:{id:string;commandHash:string;receipt:CustomerCommandReceipt}|null;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;

/** Includes existing parents for collision checks, not as newly created rows. */
export function customerReviewReservedIds(original:CustomerCommand):ReadonlySet<string>{
 const c=parseCustomerCommand(original);
 return new Set([c.id,c.customerId,c.outletId,...('ids'in c?Object.values(c.ids):[]),...('accountId'in c&&c.accountId?[c.accountId]:[])]);
}
/** Constructs only a distinct intent. It cannot authorize a write, change an
 * account parent, reinterpret money or decide whether the proposal is usable. */
export function reviewedCustomerProposal(original:CustomerCommand,replacementId:string):CustomerCommand{
 const c=parseCustomerCommand(original);
 if(!id(replacementId)||customerReviewReservedIds(c).has(replacementId))throw Error('Keep distinct original and reviewed customer identities.');
 // Detach arrays and nested terms from the immutable source. Valid normalized
 // customer commands contain only JSON values, including escaped code units.
 return parseCustomerCommand(JSON.parse(JSON.stringify({...c,id:replacementId})));
}
/** Structural receipt validation. Callers must also verify the exact original
 * command/source hashes and the proposed command hash before acknowledging. */
export function parseCustomerResolutionReceipt(value:unknown,original:CustomerCommand):CustomerResolutionReceipt{
 const c=parseCustomerCommand(original),reserved=customerReviewReservedIds(c);
 if(!object(value)||!exact(value,'id,type,commandId,commandType,customerId,outletId,commandHash,sourceHash,at,outcome,replacement')||
  !id(value.id)||reserved.has(value.id)||value.type!=='command.resolved'||value.commandId!==c.id||value.commandType!==c.type||value.customerId!==c.customerId||value.outletId!==c.outletId||!hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the genuine original customer resolution.');
 let replacement:CustomerResolutionReceipt['replacement']=null;
 if(value.outcome==='withdrawn'){
  if(value.replacement!==null)throw Error('A withdrawal has no substitute customer or khata action.');
 }else{
  const r=value.replacement;
  if(!object(r)||!exact(r,'id,commandHash,receipt')||!id(r.id)||r.id===value.id||!hash(r.commandHash))throw Error('Keep the reviewed customer action and actual receipt.');
  const proposal=reviewedCustomerProposal(c,r.id),receipt=parseCustomerCommandReceipt(r.receipt,proposal);
  if(receipt.at>value.at)throw Error('Keep the genuine customer admission and resolution clocks.');
  replacement={id:proposal.id,commandHash:r.commandHash,receipt};
 }
 return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,customerId:c.customerId,outletId:c.outletId,commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as 'withdrawn'|'replaced',replacement};
}
