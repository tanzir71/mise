import {expect,it} from 'vitest';
import {parseClosingResolutionReceipt,reviewedClosingProposal,closingReviewReservedIds} from '../packages/core/closing-review';
import {parseClosingReview} from '../packages/core/closing-commands';
import {fixture,id,modes} from './closing-review-fixture';

it.each(modes)('keeps physical count, money, parents and time in a reviewed %s intent',mode=>{
 const f=fixture(mode),c=f.command,review=c.type==='closing.record'?c.input.fingerprint:null,p=reviewedClosingProposal(c,f.packet.replacementId,review);
 expect(p).toEqual({...c,id:f.packet.replacementId});expect(p).not.toBe(c);
 for(const key of closingReviewReservedIds(c))expect(()=>reviewedClosingProposal(c,key,review)).toThrow();
});
it('can explicitly compare a different cash total without changing the counted amount or surplus choice',()=>{
 const f=fixture(),c=f.command;if(c.type!=='closing.record')throw Error();
 const summary=parseClosingReview(c.input.fingerprint),selected=JSON.stringify({...summary,expectedCash:summary.expectedCash+1000,waitingOrders:2}),p=reviewedClosingProposal(c,f.packet.replacementId,selected);
 expect(p.type==='closing.record'&&p.input).toEqual({...c.input,fingerprint:selected});expect(p.occurredAt).toBe(c.occurredAt);expect(c.input.fingerprint).toBe(JSON.stringify(summary));
});
it.each(['currency','day','timezone'])('refuses to reinterpret the original %s in a replacement',field=>{
 const f=fixture(),c=f.command;if(c.type!=='closing.record')throw Error();const summary=parseClosingReview(c.input.fingerprint);
 expect(()=>reviewedClosingProposal(c,f.packet.replacementId,JSON.stringify({...summary,[field]:field==='currency'?'USD':field==='timezone'?'UTC':'2026-11-16'}))).toThrow();
});
it('blocks an incompatible surplus or unexplained new difference rather than inventing a new choice',()=>{
 const f=fixture(),c=f.command;if(c.type!=='closing.record')throw Error();const summary=parseClosingReview(c.input.fingerprint);
 expect(()=>reviewedClosingProposal(c,f.packet.replacementId,JSON.stringify({...summary,expectedCash:c.input.countedCash}))).toThrow();
 const exact=fixture('exact').command;if(exact.type!=='closing.record')throw Error();const empty={...exact,input:{...exact.input,note:''}},s=parseClosingReview(empty.input.fingerprint);
 expect(()=>reviewedClosingProposal(empty,f.packet.replacementId,JSON.stringify({...s,expectedCash:s.expectedCash+1}))).toThrow();
 expect(()=>reviewedClosingProposal(fixture('undo').command,id(80000),JSON.stringify(summary))).toThrow();
});
it.each(modes)('checks genuine withdrawal and reviewed receipt structure for %s',mode=>{
 const f=fixture(mode),c=f.command,reviewJson=c.type==='closing.record'?c.input.fingerprint:null,proposal=reviewedClosingProposal(c,f.packet.replacementId,reviewJson),record=f.change.closing,at=c.occurredAt+60000;
 const receipt={id:proposal.id,type:proposal.type,outletId:c.outletId,closingId:c.closingId,occurredAt:c.occurredAt,at,day:record.day,difference:record.difference,addedWalkIn:record.addedWalkIn,closingUpdatedAt:at,saleId:c.saleId,saleUpdatedAt:c.saleId?at:null,undoOf:c.type==='closing.undo'?c.closingId:null};
 const base={id:f.packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,closingId:c.closingId,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:'b'.repeat(64),sourceHash:f.packet.sourceHash,at,outcome:'replaced',replacement:{id:proposal.id,commandHash:'c'.repeat(64),reviewJson,receipt}};
 expect(parseClosingResolutionReceipt(base,f.packet).replacement?.receipt.id).toBe(proposal.id);expect(parseClosingResolutionReceipt({...base,outcome:'withdrawn',replacement:null},f.packet).replacement).toBeNull();
 expect(()=>parseClosingResolutionReceipt({...base,outcome:'withdrawn'},f.packet)).toThrow();expect(()=>parseClosingResolutionReceipt({...base,at:at-1},f.packet)).toThrow();expect(()=>parseClosingResolutionReceipt({...base,id:c.closingId},f.packet)).toThrow();expect(()=>parseClosingResolutionReceipt({...base,occurredAt:c.occurredAt+1},f.packet)).toThrow();
 expect(()=>parseClosingResolutionReceipt({...base,replacement:{...base.replacement,receipt:{...receipt,difference:record.difference+1}}},f.packet)).toThrow();
 if(c.type==='closing.undo')expect(()=>parseClosingResolutionReceipt({...base,at:base.at+86400000},f.packet)).toThrow();
});
