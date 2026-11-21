import {expect,it} from 'vitest';
import {parseLocalStockReview,parseStockReviewQuote,stockReviewQuote,stockReviewQuoteHash,type LocalStockReview} from '../packages/core/stock-review-journal';
import {parseStockReviewSource} from '../packages/core/stock-review-source';
import {parseStockCommandReceipt,stockWritePlan,type StockCommand,type StockCommandReceipt} from '../packages/core/stock-commands';
import {stockFingerprint} from '../packages/core/stock-replay';
import {reviewedStockProposal,type StockResolutionReceipt} from '../packages/core/stock-review';
import {adjusted,id,literal,view} from './stock-review-fixture';
async function record():Promise<LocalStockReview>{
 const {f,p}=adjusted(),v=view(f,p);v.commandHash=await stockFingerprint(p.command);const quote=stockReviewQuote(v),source=parseStockReviewSource(p);
 return {id:'d'.repeat(64),version:1,revision:0,uploadId:id(90003),entryId:source.entryId,commandIndex:source.commandIndex,identityHash:'e'.repeat(64),commandHash:v.commandHash,packet:p,phase:'review',quote,quoteHash:await stockReviewQuoteHash(quote),choice:null,attempts:[],receipt:null};
}
function ordinary(c:StockCommand,onHand=22.125):StockCommandReceipt {const plan=stockWritePlan(c);return parseStockCommandReceipt({id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:c.occurredAt+10000,batchId:plan.batchId,undoOf:plan.undoMoveId,results:plan.rows.map(row=>({stockItemId:row.itemId,eventId:row.eventId,moveId:row.moveId,revision:row.revision+1,onHand,updatedAt:c.occurredAt+10000}))},c);}
async function resolved(row:LocalStockReview,replaced=false):Promise<StockResolutionReceipt>{
 const c=row.packet.command,proposal=row.quote!.proposal;if(!proposal.enabled)throw Error();const replacement=reviewedStockProposal(c,row.packet.replacementId,proposal.revisions),receipt=ordinary(replacement,proposal.items[0].onHand);
 return {id:row.packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:row.commandHash,sourceHash:row.packet.sourceHash,at:receipt.at+1,outcome:replaced?'replaced':'withdrawn',replacement:replaced?{id:replacement.id,commandHash:await stockFingerprint(replacement),revisions:proposal.revisions,receipt}:null};
}
it('retains the original command, source, code units and displayed stock without a server token',async()=>{
 const row=await record(),parsed=parseLocalStockReview(row);expect(parsed).toEqual(row);expect(parsed.packet.command.type==='stock.adjust'&&parsed.packet.command.change.note).toBe(literal);expect('token'in parsed.quote!).toBe(false);expect(JSON.stringify(parsed)).not.toContain('"token"');parsed.quote!.current.items[0].item!.onHand=4;expect(row.quote!.current.items[0].item!.onHand).toBe(20);
});
it('keeps unchanged comparison consent stable across fresh tokens and admission timestamps',async()=>{
 const row=await record(),v={...structuredClone(row.quote!),at:row.quote!.at+1000,expiresAt:row.quote!.expiresAt+1000,token:'z'.repeat(43)},next=stockReviewQuote(v);expect(await stockReviewQuoteHash(next)).toBe(row.quoteHash);expect(parseStockReviewQuote(next,row.packet,row.commandHash)).toEqual(next);
});
it.each(['quantity','revision','state','unit','timezone','presence'] as const)('changes the integrity token when current %s facts change',async kind=>{
 const row=await record(),quote=structuredClone(row.quote!);if(kind==='quantity')quote.current.items[0].item!.onHand++;if(kind==='revision')quote.current.items[0].item!.revision++;if(kind==='state')quote.current.stateHash='f'.repeat(64);if(kind==='unit')quote.current.items[0].item!.unit='g';if(kind==='timezone')quote.current.timezone='Asia/Kolkata';if(kind==='presence')quote.current.items[0].item=null;expect(await stockReviewQuoteHash(quote)).not.toBe(row.quoteHash);
});
it('retains an unconfirmed decision and its complete sequence of original attempts',async()=>{
 const row=await record();row.phase='unconfirmed';row.revision=3;row.choice={outcome:'withdrawn'};row.attempts=[{outcome:'replaced',quoteHash:row.quoteHash!,at:row.quote!.at},{outcome:'withdrawn',quoteHash:row.quoteHash!,at:row.quote!.at+1}];expect(parseLocalStockReview(row)).toEqual(row);expect(row.receipt).toBeNull();
});
it('accepts only a real-shaped source-bound resolved result as confirmation of a saved choice',async()=>{
 const row=await record();row.phase='confirmed';row.choice={outcome:'withdrawn'};row.receipt=await resolved(row);expect(parseLocalStockReview(row).receipt).toEqual(row.receipt);for(const patch of [{sourceHash:'f'.repeat(64)},{commandHash:'f'.repeat(64)},{commandId:id(80000)},{outletId:id(80000)},{occurredAt:1}])expect(()=>parseLocalStockReview({...row,receipt:{...row.receipt,...patch}})).toThrow();
});
it('preserves an actual reviewed replacement even when it differs from the last local choice or nonce',async()=>{
 const row=await record();row.phase='confirmed';row.choice={outcome:'withdrawn'};row.receipt=await resolved(row,true);row.receipt.id=id(80000);expect(parseLocalStockReview(row).receipt).toMatchObject({outcome:'replaced',id:id(80000),replacement:{receipt:{results:[{onHand:22.125}]}}});
});
it('retains a genuine original receipt discovered before any comparison was prepared',async()=>{
 const row=await record();row.phase='confirmed';row.quote=null;row.quoteHash=null;row.receipt=ordinary(row.packet.command);expect(parseLocalStockReview(row).receipt).toEqual(row.receipt);
});
it('requires the original native entry and selected action position even before a receipt exists',async()=>{
 const row=await record();expect(()=>parseLocalStockReview({...row,entryId:id(80000)})).toThrow();expect(()=>parseLocalStockReview({...row,commandIndex:1})).toThrow();expect(()=>parseLocalStockReview({...row,identityHash:'bad'})).toThrow();expect(()=>parseLocalStockReview({...row,uploadId:'bad'})).toThrow();
});
it('does not turn a deliberate choice or attempted send into an acknowledged stock outcome',async()=>{
 const row=await record();for(const phase of ['deciding','unconfirmed'] as const){expect(()=>parseLocalStockReview({...row,phase})).toThrow();expect(()=>parseLocalStockReview({...row,phase,quote:null,quoteHash:null,choice:{outcome:'withdrawn'}})).toThrow();}expect(()=>parseLocalStockReview({...row,phase:'confirmed'})).toThrow();expect(()=>parseLocalStockReview({...row,phase:'review',receipt:ordinary(row.packet.command)})).toThrow();
});
it('rejects runtime credentials, server tokens and authority properties instead of persisting them',async()=>{
 const row=await record();for(const extra of [{token:'x'.repeat(43)},{session:'private'},{connection:{apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'}}])expect(()=>parseLocalStockReview({...row,...extra})).toThrow();expect(()=>parseLocalStockReview({...row,quote:{...row.quote,token:'x'.repeat(43)}})).toThrow();expect(()=>parseLocalStockReview({...row,choice:{outcome:'withdrawn',authority:true}})).toThrow();expect(()=>parseLocalStockReview({...row,attempts:[{outcome:'withdrawn',quoteHash:row.quoteHash,at:row.quote!.at,token:'x'.repeat(43)}]})).toThrow();
});
it('rejects missing comparison hashes, invalid attempt clocks and changed quote command bindings',async()=>{
 const row=await record();expect(()=>parseLocalStockReview({...row,quoteHash:null})).toThrow();expect(()=>parseLocalStockReview({...row,quote:null})).toThrow();for(const at of [-1,1.25,8640000000000001])expect(()=>parseLocalStockReview({...row,attempts:[{outcome:'withdrawn',quoteHash:row.quoteHash,at}]})).toThrow();expect(()=>parseLocalStockReview({...row,quote:{...row.quote,commandHash:'f'.repeat(64)}})).toThrow();
});
