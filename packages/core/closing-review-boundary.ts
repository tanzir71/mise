import {parseClosingCommand,isClosingCommandType} from './closing-commands';
import {closingFingerprint,replayClosingRecords} from './closing-replay';
import {parseClosingResolutionReceipt,reviewedClosingProposal} from './closing-review';
import {parseClosingReviewSource,closingReviewCreatedIds} from './closing-review-source';
import {closingReviewProposal,readClosingReviewContext} from './closing-review-view';
import {cloudRecordMaps,type CloudRecord} from './cloud-records';
import {syncDownloadToken} from './sync-download';
import type {AuditEvent} from './models';
import type {MiseBackup} from './backup-tables';

export class ClosingReviewBoundaryError extends Error {
 constructor(readonly kind:'conflict'|'integrity'){super(kind==='conflict'?'Keep the original closing and cash identities after reviewing the saved action.':'Keep the complete canonical closing resolution proof.');}
}
export interface ClosingReviewBoundary {assert(records:readonly CloudRecord[],current:MiseBackup):void}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const protectedTables={day_closings:'dayClosings',sales:'sales',events:'events'} as const;
const closingType=(value:unknown)=>typeof value==='string'&&value.startsWith('closing.');
/** Validate the full source and before/after transaction, without any ticket or
 * write authority. Only emitted creations are fenced; undo parents stay usable. */
export async function closingReviewBoundary(events:readonly AuditEvent[],outletId:string):Promise<ClosingReviewBoundary>{
 const reserved=new Set<string>(),positions=new Set<string>();
 for(const event of events){
  if(event.command!=='sync.resolve'||event.outletId!==outletId)continue;
  const before=event.before,after=event.after;
  if(!(object(before)&&closingType(before.commandType)||object(after)&&('closingResolutionPosition'in after||object(after.receipt)&&closingType(after.receipt.commandType))))continue;
  try{
   if(!object(before)||!exact(before,'resolutionId,commandId,commandType,commandHash,sourceHash,originalCommandJson,sourceJson,closingBeforeJson')||!isClosingCommandType(before.commandType)||typeof before.originalCommandJson!=='string'||typeof before.sourceJson!=='string'||typeof before.closingBeforeJson!=='string'||!object(after)||!exact(after,'resolutionId,outcome,receipt,replacementId,closingAfterJson,closingResolutionPosition')||typeof after.closingAfterJson!=='string'||typeof after.closingResolutionPosition!=='string'||!/^[1-9][0-9]{0,18}$/.test(after.closingResolutionPosition)||BigInt(after.closingResolutionPosition)>9223372036854775807n||positions.has(after.closingResolutionPosition))throw Error();
   const command=parseClosingCommand(JSON.parse(before.originalCommandJson)),input={command,sourceJson:before.sourceJson},source=parseClosingReviewSource(input),receipt=parseClosingResolutionReceipt(after.receipt,input);
   if(command.outletId!==outletId||event.id!==command.id||event.actor.type!=='member'||source.events.some(e=>e.actorId!==event.actor.id)||event.at!==receipt.at||before.commandId!==command.id||before.commandType!==command.type||before.resolutionId!==receipt.id||before.commandHash!==receipt.commandHash||before.sourceHash!==receipt.sourceHash||receipt.commandHash!==await closingFingerprint(command)||after.resolutionId!==receipt.id||after.outcome!==receipt.outcome||after.replacementId!==(receipt.replacement?.id??null))throw Error();
   const context=readClosingReviewContext(before.closingBeforeJson,source.businessId,outletId,event.actor.id,command.closingId),result=readClosingReviewContext(after.closingAfterJson,source.businessId,outletId,event.actor.id,command.closingId);
   if(event.closingId!==(result.closing?.id??undefined))throw Error();
   const expected=JSON.parse(before.closingBeforeJson) as Record<string,unknown>;
   if(receipt.replacement){
    const replacement=receipt.replacement,selected=reviewedClosingProposal(command,replacement.id,replacement.reviewJson),metadata={businessId:source.businessId,outletId,actorId:event.actor.id,at:replacement.receipt.at};
    if(replacement.commandHash!==await closingFingerprint(selected))throw Error();
    const proposal=closingReviewProposal({...input,replacementId:replacement.id},metadata,{available:true,contextJson:before.closingBeforeJson},context);
    if(!proposal.enabled||proposal.reviewJson!==replacement.reviewJson)throw Error();
    const records=replayClosingRecords({...metadata,contextJson:before.closingBeforeJson},selected);
    for(const record of records){
     const table=record.table==='day_closings'?'dayClosings':record.table==='sales'?'sales':null;if(!table)continue;
     const fields=cloudRecordMaps[table].fields as Record<string,string>,row=Object.fromEntries(Object.entries(record.values).map(([key,value])=>[key,value!==null&&fields[key]?.startsWith('j:')?JSON.parse(value as string):value]));
     // Ordinary undo contexts contain only their two parents; record contexts
     // contain the complete Today lists and no separate cash parent.
     if(command.type==='closing.record'){
      const key=table==='dayClosings'?'closings':'sales',rows=expected[key] as Record<string,unknown>[],index=rows.findIndex(value=>value.id===row.id);
      if(index<0)rows.push(row);else rows[index]=row;rows.sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
     }
     if(table==='dayClosings'||command.type==='closing.undo')expected[table==='dayClosings'?'closing':'sale']=row;
     if(row.updated_at!==(table==='dayClosings'?replacement.receipt.closingUpdatedAt:replacement.receipt.saleUpdatedAt))throw Error();
    }
   }
   if(!same(expected,JSON.parse(after.closingAfterJson)))throw Error();
   positions.add(after.closingResolutionPosition);for(const id of closingReviewCreatedIds(source))reserved.add(id);
  }catch{throw new ClosingReviewBoundaryError('integrity');}
 }
 return {assert(records,current){
  for(const record of records){
   const table=protectedTables[record.table as keyof typeof protectedTables];if(!table)continue;
   const id=record.values.id;if(typeof id!=='string')throw new ClosingReviewBoundaryError('integrity');
   if(reserved.has(id)&&!current.tables[table].some(row=>row.id===id))throw new ClosingReviewBoundaryError('conflict');
  }
 }};
}
