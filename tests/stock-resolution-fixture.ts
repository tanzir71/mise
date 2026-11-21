import {stockFingerprint} from '../packages/core/stock-replay';
import {parseStockCommandReceipt,stockWritePlan} from '../packages/core/stock-commands';
import {reviewedStockProposal,type StockResolutionReceipt} from '../packages/core/stock-review';
import {parseStockReviewSource,type StockReviewRequest} from '../packages/core/stock-review-source';
import type {StockContext} from '../packages/core/stock';
import type {AuditEvent} from '../packages/core/models';
import {view} from './stock-review-fixture';
/** Synthetic canonical transport audit, built from actual source/replay rules. */
export async function stockResolutionEvent(f:StockContext,p:StockReviewRequest,outcome:'withdrawn'|'replaced'='withdrawn',position='1'):Promise<AuditEvent>{
 parseStockReviewSource(p);const c=p.command,at=Math.max(Date.now(),c.occurredAt),quote=view(f,p,at);if(!quote.proposal.enabled)throw Error('Expected applicable synthetic stock proposal');const revisions=quote.proposal.revisions,proposal=reviewedStockProposal(c,p.replacementId,revisions),plan=stockWritePlan(proposal),commandHash=await stockFingerprint(c),receipt=parseStockCommandReceipt({id:proposal.id,type:proposal.type,outletId:c.outletId,occurredAt:c.occurredAt,at,batchId:plan.batchId,undoOf:plan.undoMoveId,results:plan.rows.map((row,i)=>({stockItemId:row.itemId,eventId:row.eventId,moveId:row.moveId,revision:revisions[i].revision+1,onHand:quote.proposal.enabled?quote.proposal.items[i].onHand:0,updatedAt:at}))},proposal),resolved:StockResolutionReceipt={id:p.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash,sourceHash:p.sourceHash,at,outcome,replacement:outcome==='withdrawn'?null:{id:proposal.id,commandHash:await stockFingerprint(proposal),revisions,receipt}};
 return {id:c.id,outletId:c.outletId,actor:{type:'member',id:f.setup.owner.id},command:'sync.resolve',at,before:{resolutionId:p.id,commandId:c.id,commandType:c.type,commandHash,sourceHash:p.sourceHash,originalCommandJson:JSON.stringify(c),sourceJson:p.sourceJson},after:{resolutionId:p.id,outcome,receipt:resolved,replacementId:resolved.replacement?.id??null,stockResolutionPosition:position}};
}
