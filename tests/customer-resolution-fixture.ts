import type {AuditEvent} from '../packages/core/models';
import {customerFingerprint} from '../packages/core/customer-commands';
import {parseCustomerReviewSource} from '../packages/core/customer-review-source';
import {reviewedCustomerProposal,type CustomerResolutionReceipt} from '../packages/core/customer-review';
import {fixture,ordinaryCustomerReceipt} from './customer-review-fixture';

export async function customerResolutionEvent(f:ReturnType<typeof fixture>,outcome:'withdrawn'|'replaced'='withdrawn',position='1'):Promise<AuditEvent>{
 const c=f.command,p=f.packet,source=parseCustomerReviewSource(p),next=reviewedCustomerProposal(c,p.replacementId),applied=ordinaryCustomerReceipt(f,next),receipt:CustomerResolutionReceipt={id:p.id,type:'command.resolved',commandId:c.id,commandType:c.type,customerId:c.customerId,outletId:c.outletId,commandHash:await customerFingerprint(c),sourceHash:p.sourceHash,at:applied.at+1,outcome,replacement:outcome==='replaced'?{id:next.id,commandHash:await customerFingerprint(next),receipt:applied}:null};
 return {id:c.id,outletId:c.outletId,actor:{type:'member',id:source.events[0].actorId},command:'sync.resolve',before:{resolutionId:p.id,commandId:c.id,commandType:c.type,commandHash:receipt.commandHash,sourceHash:p.sourceHash,originalCommandJson:JSON.stringify(c),sourceJson:p.sourceJson,customerBeforeJson:'{}'},after:{resolutionId:p.id,outcome,receipt,replacementId:receipt.replacement?.id??null,customerAfterJson:'{}',customerResolutionPosition:position},at:receipt.at};
}
