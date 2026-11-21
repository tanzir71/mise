import {parseClosingCommand,parseClosingCommandReceipt,parseClosingReview,type ClosingCommand,type ClosingCommandReceipt} from './closing-commands';
import {closingReviewCommandLimit,parseClosingReviewSource,type ClosingReviewRequest} from './closing-review-source';
import {closingReviewReservedIds} from './closing-review-identities';
import {canUndoClosing} from './closing';
export {closingReviewReservedIds} from './closing-review-identities';

export interface ClosingResolutionReceipt {
 id:string;type:'command.resolved';commandId:string;commandType:ClosingCommand['type'];closingId:string;outletId:string;occurredAt:number;
 commandHash:string;sourceHash:string;at:number;outcome:'withdrawn'|'replaced';
 replacement:{id:string;commandHash:string;reviewJson:string|null;receipt:ClosingCommandReceipt}|null;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');

/** A reviewed count retains its physical time, amount, explanation and explicit
 * surplus choice. The complete comparison can change, but its unit/day cannot.
 * This is an intent constructor, not evidence of current state or permission. */
export function reviewedClosingProposal(original:ClosingCommand,replacementId:string,reviewJson:string|null):ClosingCommand{
 const c=parseClosingCommand(original);
 if(!id(replacementId)||closingReviewReservedIds(c).has(replacementId))throw Error('Keep distinct original and reviewed closing identities.');
 if(c.type==='closing.undo'){
  if(reviewJson!==null)throw Error('Undo retains its original closing snapshot.');
  return parseClosingCommand({...c,id:replacementId});
 }
 const before=parseClosingReview(c.input.fingerprint),selected=parseClosingReview(reviewJson);
 if(selected.day!==before.day||selected.currency!==before.currency||selected.timezone!==before.timezone)throw Error('Keep the counted day, original currency and timezone.');
 const proposal=parseClosingCommand({...c,id:replacementId,input:{...c.input,fingerprint:reviewJson}});
 if(new TextEncoder().encode(JSON.stringify(proposal)).length>closingReviewCommandLimit)throw Error('Keep a complete closing within the ordinary command limit.');
 return proposal;
}
/** Generic transport validation; original source facts and exact hashes must be
 * checked independently before acknowledging an action on the device. */
export function parseClosingResolutionMetadata(value:unknown,command:ClosingCommand):ClosingResolutionReceipt{
 const c=parseClosingCommand(command);
 if(!object(value)||!exact(value,'id,type,commandId,commandType,closingId,outletId,occurredAt,commandHash,sourceHash,at,outcome,replacement')||
  !id(value.id)||closingReviewReservedIds(c).has(value.id)||value.type!=='command.resolved'||value.commandId!==c.id||value.commandType!==c.type||value.closingId!==c.closingId||value.outletId!==c.outletId||value.occurredAt!==c.occurredAt||!hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the genuine original closing resolution.');
 let replacement:ClosingResolutionReceipt['replacement']=null;
 if(value.outcome==='withdrawn'){
  if(value.replacement!==null)throw Error('A withdrawal has no new closing or cash receipt.');
 }else{
  const r=value.replacement;
  if(!object(r)||!exact(r,'id,commandHash,reviewJson,receipt')||!id(r.id)||r.id===value.id||!hash(r.commandHash)||!(r.reviewJson===null||typeof r.reviewJson==='string'))throw Error('Keep the reviewed closing and actual receipt.');
  const proposal=reviewedClosingProposal(c,r.id,r.reviewJson),receipt=parseClosingCommandReceipt(r.receipt,proposal);
  if(receipt.at>value.at)throw Error('Keep the actual admission and resolution clocks.');
  replacement={id:proposal.id,commandHash:r.commandHash,reviewJson:r.reviewJson,receipt};
 }
 return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,closingId:c.closingId,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as 'withdrawn'|'replaced',replacement};
}
/** Review/native validation also binds the complete original financial parent. */
export function parseClosingResolutionReceipt(value:unknown,input:Pick<ClosingReviewRequest,'command'|'sourceJson'>):ClosingResolutionReceipt{
 const result=parseClosingResolutionMetadata(value,input.command),original=parseClosingReviewSource(input).events[0],receipt=result.replacement?.receipt;
 if(input.command.type==='closing.undo'&&receipt&&(!original.before||!canUndoClosing(original.before,receipt.at)||!canUndoClosing(original.before,result.at)||receipt.day!==original.after.day||receipt.difference!==original.after.difference||receipt.addedWalkIn!==original.after.addedWalkIn))throw Error('Keep the original closing totals and actual same-day undo deadline.');
 return result;
}
/** A recovered ordinary undo must still describe the original physical count. */
export function parseSavedClosingReceipt(value:unknown,input:Pick<ClosingReviewRequest,'command'|'sourceJson'>):ClosingCommandReceipt{
 const receipt=parseClosingCommandReceipt(value,input.command),original=parseClosingReviewSource(input).events[0];
 if(input.command.type==='closing.undo'&&(!original.before||!canUndoClosing(original.before,receipt.at)||receipt.day!==original.before.day||receipt.difference!==original.before.difference||receipt.addedWalkIn!==original.before.addedWalkIn))throw Error('Keep the original closing totals and actual same-day undo admission.');
 return receipt;
}
