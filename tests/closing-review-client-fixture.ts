import {parseClosingCommandReceipt,parseClosingReview,type ClosingCommand,type ClosingCommandReceipt} from '../packages/core/closing-commands';
import {parseClosingReviewSource,type ClosingReviewRequest} from '../packages/core/closing-review-source';
import {closingFingerprint} from '../packages/core/closing-replay';
import {reviewedClosingProposal,type ClosingResolutionReceipt} from '../packages/core/closing-review';
import {prepareClosingReviewView} from '../packages/core/closing-review-view';
import type {TodayContext} from '../packages/core/today';
import {syncHash} from '../packages/core/sync-read';
import {syncDownloadToken} from '../packages/core/sync-download';
import {currentContext} from './closing-review-fixture';

/** Synthetic receipt metadata; the SQL/HTTP suites separately verify real writes. */
export function ordinaryClosingReceipt(packet:ClosingReviewRequest,command:ClosingCommand=packet.command,at=command.occurredAt+1000):ClosingCommandReceipt{
 const original=parseClosingReviewSource(packet).events[0].after,review=command.type==='closing.record'?parseClosingReview(command.input.fingerprint):null;
 const difference=command.type==='closing.record'?command.input.countedCash-review!.expectedCash:original.difference,addedWalkIn=command.type==='closing.record'?command.input.addDifference?difference:0:original.addedWalkIn;
 return parseClosingCommandReceipt({id:command.id,type:command.type,outletId:command.outletId,closingId:command.closingId,occurredAt:command.occurredAt,at,day:review?.day??original.day,difference,addedWalkIn,closingUpdatedAt:at,saleId:command.saleId,saleUpdatedAt:command.saleId?at:null,undoOf:command.type==='closing.undo'?command.closingId:null},command);
}
export async function closingResolution(packet:ClosingReviewRequest,outcome:'withdrawn'|'replaced',reviewJson:string|null=packet.command.type==='closing.record'?packet.command.input.fingerprint:null,at=packet.command.occurredAt+1000):Promise<ClosingResolutionReceipt>{
 const command=reviewedClosingProposal(packet.command,packet.replacementId,reviewJson),receipt=outcome==='replaced'?ordinaryClosingReceipt(packet,command,at):null;
 return {id:packet.id,type:'command.resolved',commandId:packet.command.id,commandType:packet.command.type,closingId:packet.command.closingId,outletId:packet.command.outletId,occurredAt:packet.command.occurredAt,commandHash:await closingFingerprint(packet.command),sourceHash:packet.sourceHash,at:at+1,outcome,replacement:receipt?{id:command.id,commandHash:await closingFingerprint(command),reviewJson,receipt}:null};
}
export async function closingComparison(packet:ClosingReviewRequest,today:TodayContext,at=Math.max(Date.now(),packet.command.occurredAt+1)){
 const source=parseClosingReviewSource(packet),cash=source.events.find(e=>e.kind==='sale'),created={closing:source.events[0].before??source.events[0].after,sale:cash?.before??cash?.after??undefined};
 return prepareClosingReviewView({v:1,id:packet.id,replacementId:packet.replacementId,commandId:packet.command.id,commandHash:await closingFingerprint(packet.command),sourceHash:packet.sourceHash,businessId:source.businessId,outletId:packet.command.outletId,actorId:source.events[0].actorId,token:'t'.repeat(43),at,expiresAt:at+120000},{stateHash:await syncHash(new TextEncoder().encode(syncDownloadToken(today))),available:true,contextJson:currentContext({command:packet.command,row:{businessId:source.businessId},context:today,created})},packet);
}
