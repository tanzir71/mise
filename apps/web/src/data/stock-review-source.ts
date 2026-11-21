import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isStockCommand,parseShopCommand,parseShopCommandReceipt} from '@mise/core/shop-commands';
import {stockWritePlan} from '@mise/core/stock-commands';
import {parseStockReviewRequest,stockReviewSourceAudits,type StockReviewRequest} from '@mise/core/stock-review-source';
import {nativeRowHash} from './canonical-writes';

/** Audit snapshots retain the immediate source even when several actions share
 * one entry and its final stock item row has advanced further. */
export async function prepareStockReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<StockReviewRequest>{
 if(row.version!==1||row.status!=='pending'||index!==row.receipts.length||!row.commands[index])throw Error('Review the first unconfirmed original stock action.');
 const commands=row.commands.map(parseShopCommand),command=commands[index];
 if(!isStockCommand(command)||command.outletId!==row.outletId)throw Error('Choose the original saved stock action.');
 for(let i=0;i<index;i++)parseShopCommandReceipt(row.receipts[i],commands[i]);
 const plan=stockWritePlan(command),wanted=new Set(plan.rows.map(r=>r.eventId)),selected=row.changes.filter(change=>change.table==='events'&&wanted.has(change.key));
 if(selected.length!==wanted.size||new Set(selected.map(c=>c.key)).size!==selected.length||selected.some(c=>c.before!==null))throw Error('Keep every original append-only stock audit.');
 const byId=new Map(selected.map(c=>[c.key,c.after])),events=stockReviewSourceAudits(command,plan.rows.map(r=>byId.get(r.eventId)));
 return parseStockReviewRequest({id,replacementId,command,sourceHash:await nativeRowHash({...row,commands,status:'pending',receipts:[]}),sourceJson:JSON.stringify({v:1,entryId:row.id,sequence:row.sequence,commandIndex:index,at:row.at,events})},false);
}
