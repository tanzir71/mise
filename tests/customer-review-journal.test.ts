import {expect,it} from 'vitest';
import {parseLocalCustomerReview,customerReviewQuote,customerReviewQuoteHash,type LocalCustomerReview} from '../packages/core/customer-review-journal';
import {reviewedCustomerProposal,type CustomerResolutionReceipt} from '../packages/core/customer-review';
import {customerFingerprint} from '../packages/core/customer-commands';
import {parseCustomerReviewSource} from '../packages/core/customer-review-source';
import {fixture,modes,id,literal,reviewView,ordinaryCustomerReceipt} from './customer-review-fixture';

async function record(mode:typeof modes[number]='create-opening'):Promise<LocalCustomerReview>{
 const f=fixture(mode),view=await reviewView(f),quote=customerReviewQuote(view),source=parseCustomerReviewSource(f.packet);
 return {id:'d'.repeat(64),version:1,revision:0,uploadId:f.row.uploadId,entryId:source.entryId,commandIndex:source.commandIndex,identityHash:'e'.repeat(64),commandHash:view.commandHash,packet:f.packet,phase:'review',quote,quoteHash:await customerReviewQuoteHash(quote),choice:null,attempts:[],receipt:null};
}
async function resolved(row:LocalCustomerReview,replaced=false):Promise<CustomerResolutionReceipt>{
 const f=fixture(row.packet.command.type==='khata.settings'?'khata-settings':'create-opening'),command=row.packet.command,next=reviewedCustomerProposal(command,row.packet.replacementId),receipt=ordinaryCustomerReceipt(f,next);
 return {id:row.packet.id,type:'command.resolved',commandId:command.id,commandType:command.type,customerId:command.customerId,outletId:command.outletId,commandHash:row.commandHash,sourceHash:row.packet.sourceHash,at:receipt.at+1,outcome:replaced?'replaced':'withdrawn',replacement:replaced?{id:next.id,commandHash:await customerFingerprint(next),receipt}:null};
}
it.each(modes)('retains the complete %s source and current comparison without runtime credentials',async mode=>{
 const row=await record(mode),parsed=parseLocalCustomerReview(row);expect(parsed).toEqual(row);expect(JSON.stringify(parsed)).not.toMatch(/"token"|Authorization|publishableKey|auth_user_id/);expect('occurredAt'in parsed.packet.command).toBe(false);
 if('input'in parsed.packet.command&&'name'in parsed.packet.command.input)expect(parsed.packet.command.input.notes).toBe(literal);
 parsed.packet.sourceJson='changed';expect(row.packet.sourceJson).not.toBe('changed');
});
it('preserves consent across new admission clocks and ephemeral tokens only',async()=>{
 const row=await record(),quote=customerReviewQuote({...row.quote!,token:'x'.repeat(43),at:row.quote!.at+1000,expiresAt:row.quote!.expiresAt+1000});expect(await customerReviewQuoteHash(quote)).toBe(row.quoteHash);
 for(const changed of [{...quote,current:{...quote.current,stateHash:'f'.repeat(64)}},{...quote,current:{...quote.current,phoneTaken:true}},{...quote,sourceHash:'f'.repeat(64)}])expect(await customerReviewQuoteHash(changed)).not.toBe(row.quoteHash);
});
it('keeps an interrupted choice and every original attempt without manufacturing completion',async()=>{
 const row=await record();row.phase='unconfirmed';row.choice={outcome:'withdrawn'};row.attempts=[{outcome:'replaced',quoteHash:row.quoteHash!,at:row.quote!.at},{outcome:'withdrawn',quoteHash:row.quoteHash!,at:row.quote!.at+1}];expect(parseLocalCustomerReview(row)).toEqual(row);expect(row.receipt).toBeNull();expect(()=>parseLocalCustomerReview({...row,phase:'confirmed'})).toThrow();
});
it('retains an actual outcome from a competing review regardless of the last saved choice',async()=>{
 const row=await record();row.phase='confirmed';row.choice={outcome:'withdrawn'};row.receipt={...await resolved(row,true),id:id(840000)};expect(parseLocalCustomerReview(row).receipt).toEqual(row.receipt);
 for(const patch of [{sourceHash:'f'.repeat(64)},{commandHash:'f'.repeat(64)},{customerId:id(840001)},{occurredAt:1}])expect(()=>parseLocalCustomerReview({...row,receipt:{...row.receipt,...patch}})).toThrow();
});
it('can record the genuine original outcome before any comparison exists',async()=>{
 const row=await record();row.phase='confirmed';row.quote=null;row.quoteHash=null;row.receipt=ordinaryCustomerReceipt(fixture('create-opening'),row.packet.command);expect(parseLocalCustomerReview(row)).toEqual(row);
});
it.each(['credentials','token','position','choice','attempt','receipt'] as const)('rejects damaged or privileged %s in durable state',async kind=>{
 const row=await record();let value:unknown;
 if(kind==='credentials')value={...row,connection:{apiUrl:'https://private.test'}};
 if(kind==='token')value={...row,quote:{...row.quote,token:'x'.repeat(43)}};
 if(kind==='position')value={...row,commandIndex:1};
 if(kind==='choice')value={...row,phase:'deciding',choice:{outcome:'withdrawn',authority:true}};
 if(kind==='attempt')value={...row,attempts:[{outcome:'withdrawn',quoteHash:row.quoteHash,at:-1}]};
 if(kind==='receipt')value={...row,receipt:await resolved(row)};
 expect(()=>parseLocalCustomerReview(value)).toThrow();
});
