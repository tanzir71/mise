import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isClosingCommand,parseShopCommand,parseShopCommandReceipt} from '@mise/core/shop-commands';
import {closingReviewSourceAudits,parseClosingReviewSource,parseClosingReviewRequest,type ClosingReviewRequest} from '@mise/core/closing-review-source';
import {nativeRowHash} from './canonical-writes';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/** Read-only selection of the next unconfirmed physical count/undo. Original
 * row/image bytes are independently bound; grouped final rows are not audits. */
export function readClosingReviewSource(row:LocalOutboxEntry,index:number):Pick<ClosingReviewRequest,'command'|'sourceJson'>{
 if(row.version!==1||row.status!=='pending'||!Number.isSafeInteger(index)||index<0||index!==row.receipts.length||!row.commands[index])throw Error('Review the first unconfirmed original closing action.');
 const commands=row.commands.map(parseShopCommand),command=commands[index];
 if(!isClosingCommand(command)||command.outletId!==row.outletId)throw Error('Choose the original saved closing action.');
 for(let i=0;i<index;i++)parseShopCommandReceipt(row.receipts[i],commands[i]);
 const wanted=[command.id,...(command.saleEventId?[command.saleEventId]:[])],selected=row.changes.filter(change=>change.table==='events'&&wanted.includes(change.key));
 if(selected.length!==wanted.length||new Set(selected.map(c=>c.key)).size!==selected.length||selected.some(c=>c.before!==null||!object(c.after)||c.after.id!==c.key))throw Error('Keep every original append-only closing audit.');
 const events=closingReviewSourceAudits(command,selected.map(c=>c.after)),closing=events[0].after;
 for(const e of events){
  const rows=row.changes.filter(c=>c.table===(e.kind==='closing'?'dayClosings':'sales')&&c.key===e.after.id),after=rows[0]?.after;
  if(rows.length!==1||!object(after)||after.id!==e.after.id||after.outletId!==command.outletId||after.currency!==closing.currency||after.createdAt!==e.after.createdAt||
   e.kind==='closing'&&(after.countedCash!==closing.countedCash||after.expectedCash!==closing.expectedCash||after.previewFingerprint!==closing.previewFingerprint)||
   e.kind==='sale'&&(after.closingId!==command.closingId||after.amount!==closing.addedWalkIn))throw Error('Keep every complete original closing and cash row with its audit.');
 }
 const result={command,sourceJson:JSON.stringify({v:1,businessId:row.businessId,entryId:row.id,sequence:row.sequence,commandIndex:index,at:command.occurredAt,events})};parseClosingReviewSource(result);return result;
}
export async function prepareClosingReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<ClosingReviewRequest>{
 const source=readClosingReviewSource(row,index);
 return parseClosingReviewRequest({id,replacementId,...source,sourceHash:await nativeRowHash({...row,commands:row.commands.map(parseShopCommand),status:'pending',receipts:[]})},false);
}
