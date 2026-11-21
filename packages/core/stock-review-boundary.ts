import {isStockCommandType,parseStockCommand,stockWritePlan,type StockCommand} from './stock-commands';
import {parseStockResolutionReceipt,stockReviewCreatedIds} from './stock-review';
import {parseStockReviewSource} from './stock-review-source';
import {stockFingerprint} from './stock-replay';
import type {AuditEvent} from './models';
export class StockReviewBoundaryError extends Error {constructor(readonly kind:'conflict'|'integrity'){super(kind==='conflict'?'Review the retained stock action after its original movement was withdrawn.':'Keep the complete canonical stock resolution proof.');}}
export interface StockReviewBoundary {assert(command:StockCommand):void}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/** Build once per checked canonical snapshot, not once per pending action.
 * This is tentative projection protection, never server admission authority. */
export async function stockReviewBoundary(events:readonly AuditEvent[],outletId:string):Promise<StockReviewBoundary>{
 const reserved=new Set<string>(),positions=new Set<string>(),latest=new Map<string,{position:bigint;outcome:'withdrawn'|'replaced'}>();
 for(const event of events){
  const before=event.before,after=event.after;
  if(event.command!=='sync.resolve'||event.outletId!==outletId)continue;
  const stockKind=(value:unknown)=>typeof value==='string'&&value.startsWith('stock.'),stock=object(before)&&stockKind(before.commandType)||object(after)&&('stockResolutionPosition'in after||object(after.receipt)&&stockKind(after.receipt.commandType));
  if(!stock)continue;
  try{
   if(!object(before)||!isStockCommandType(before.commandType)||typeof before.originalCommandJson!=='string'||typeof before.sourceJson!=='string'||!object(after)||typeof after.stockResolutionPosition!=='string'||!/^[1-9][0-9]{0,18}$/.test(after.stockResolutionPosition)||BigInt(after.stockResolutionPosition)>9223372036854775807n||positions.has(after.stockResolutionPosition))throw Error();
   const command=parseStockCommand(JSON.parse(before.originalCommandJson)),receipt=parseStockResolutionReceipt(after.receipt,command),source=parseStockReviewSource({command,sourceJson:before.sourceJson});
   if(command.outletId!==outletId||event.id!==command.id||event.actor.type!=='member'||source.events.some(e=>e.actorId!==event.actor.id)||event.at!==receipt.at||before.commandId!==command.id||before.commandType!==command.type||before.resolutionId!==receipt.id||before.commandHash!==receipt.commandHash||before.sourceHash!==receipt.sourceHash||receipt.commandHash!==await stockFingerprint(command)||after.resolutionId!==receipt.id||after.outcome!==receipt.outcome||after.replacementId!==(receipt.replacement?.id??null))throw Error();
   positions.add(after.stockResolutionPosition);for(const id of stockReviewCreatedIds(command))reserved.add(id);
   const position=BigInt(after.stockResolutionPosition);
   for(const row of stockWritePlan(command).rows){if(!row.moveId)continue;const previous=latest.get(row.itemId);if(!previous||previous.position<position)latest.set(row.itemId,{position,outcome:receipt.outcome});}
  }catch{throw new StockReviewBoundaryError('integrity');}
 }
 return {assert(value){const command=parseStockCommand(value);if(command.outletId!==outletId)throw new StockReviewBoundaryError('integrity');if([...stockReviewCreatedIds(command)].some(id=>reserved.has(id))||stockWritePlan(command).rows.some(row=>row.moveId&&latest.get(row.itemId)?.outcome==='withdrawn'))throw new StockReviewBoundaryError('conflict');}};
}
