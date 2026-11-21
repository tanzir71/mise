import {expect,it} from 'vitest';
import {closingReviewQuote,closingReviewQuoteHash,parseLocalClosingReview,type LocalClosingReview} from '../packages/core/closing-review-journal';
import {fixture,view,modes,id} from './closing-review-fixture';
import {ordinaryClosingReceipt,closingResolution} from './closing-review-client-fixture';

async function record(mode:typeof modes[number]='surplus'){
 const f=fixture(mode),review=await view(f),quote=closingReviewQuote(review);
 const saved:LocalClosingReview={id:'1'.repeat(64),version:1,revision:0,uploadId:f.row.uploadId,entryId:f.row.id,commandIndex:0,identityHash:'2'.repeat(64),commandHash:review.commandHash,packet:f.packet,phase:'review',quote,quoteHash:await closingReviewQuoteHash(quote),choice:null,attempts:[],receipt:null};
 return {f,review,saved};
}
it.each(modes)('retains every literal %s source without making tokens durable',async mode=>{
 const {f,review,saved}=await record(mode),before=JSON.stringify(saved),parsed=parseLocalClosingReview(saved);
 expect(JSON.stringify(parsed)).toBe(before);expect(parsed.packet.sourceJson).toBe(f.packet.sourceJson);expect(JSON.stringify(parsed)).not.toContain(review.token);expect(parsed.quote).not.toHaveProperty('token');
});
it.each(['token','packet-token','position','phase','choice','attempt','receipt-before-confirmation','confirmation-without-receipt','source-hash'] as const)('rejects damaged %s journal evidence',async kind=>{
 const {f,saved}=await record(),raw=structuredClone(saved) as unknown as Record<string,unknown>;
 if(kind==='token')(raw.quote as Record<string,unknown>).token='x'.repeat(43);
 if(kind==='packet-token')(raw.packet as Record<string,unknown>).token='x'.repeat(43);
 if(kind==='position')raw.commandIndex=1;if(kind==='phase')raw.phase='discarded';
 if(kind==='choice'){raw.phase='deciding';raw.choice={outcome:'guess'};}
 if(kind==='attempt')raw.attempts=[{outcome:'replaced',quoteHash:'bad',at:1}];
 if(kind==='receipt-before-confirmation')raw.receipt=ordinaryClosingReceipt(f.packet);
 if(kind==='confirmation-without-receipt')raw.phase='confirmed';
 if(kind==='source-hash'){raw.phase='confirmed';raw.receipt={...await closingResolution(f.packet,'withdrawn'),sourceHash:'f'.repeat(64)};}
 expect(()=>parseLocalClosingReview(raw)).toThrow();
});
it.each(['withdrawn','replaced'] as const)('confirms only a genuine source-bound %s outcome',async outcome=>{
 const {f,saved}=await record('undo-surplus'),receipt=await closingResolution(f.packet,outcome);
 expect(parseLocalClosingReview({...saved,phase:'confirmed',choice:{outcome},receipt}).receipt).toEqual(receipt);
});
it.each(['day','difference','addedWalkIn','late-admission'] as const)('rejects an ordinary undo receipt with changed %s',async kind=>{
 const {f,saved}=await record('undo-surplus'),receipt=ordinaryClosingReceipt(f.packet);
 if(kind==='day')receipt.day='2000-01-01';if(kind==='difference')receipt.difference++;if(kind==='addedWalkIn')receipt.addedWalkIn++;
 if(kind==='late-admission'){receipt.at+=86400000;receipt.closingUpdatedAt=receipt.at;receipt.saleUpdatedAt=receipt.at;}
 expect(()=>parseLocalClosingReview({...saved,phase:'confirmed',receipt})).toThrow();
});
it('binds the comparison to current financial values and original day eligibility while ignoring ticket renewal',async()=>{
 const {saved}=await record('undo-surplus'),quote=saved.quote!,renewed={...quote,at:quote.at+1000,expiresAt:quote.expiresAt+1000};
 expect(await closingReviewQuoteHash(renewed)).toBe(saved.quoteHash);
 expect(await closingReviewQuoteHash({...quote,current:{...quote.current,stateHash:'f'.repeat(64)}})).not.toBe(saved.quoteHash);
 expect(await closingReviewQuoteHash({...quote,proposal:{enabled:false,reason:'deadline'}})).not.toBe(saved.quoteHash);
 expect(()=>parseLocalClosingReview({...saved,entryId:id(9988)})).toThrow();
});
