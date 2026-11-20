import {expect,it} from 'vitest';
import {parseMoneyCommand} from '../packages/core/money-commands';
import {moneyFingerprint} from '../packages/core/money-replay';
import {parseShopCommandReceipt} from '../packages/core/shop-commands';
import {financialMoneyCommand,parseMoneyReviewRequest,originalMoneyFacts,reviewedMoneyProposal,parseMoneyResolutionReceipt,parsePreparedMoneyReview,type MoneyReviewRequest,type FinancialMoneyCommand} from '../packages/core/money-review';

const id=(n:number)=>String(n).padStart(26,'0');
const original=financialMoneyCommand({id:id(1),occurredAt:1000,type:'sale.record',outletId:id(2),saleId:id(3),input:{expression:'37',method:'cash',wallet:null,given:null,who:'',items:[]}});
function packet(c:FinancialMoneyCommand=original):MoneyReviewRequest {
 const money=c.type==='khata.undo'?[{table:'creditEntries',key:c.reversalId,before:null,after:{id:c.reversalId,outletId:c.outletId,accountId:id(20),customerId:id(21),currency:'BDT',amount:3700,reversalOf:c.entryId}}]:
  [{table:'sales',key:'saleId'in c?c.saleId:id(3),before:null,after:{id:'saleId'in c?c.saleId:id(3),outletId:c.outletId,currency:'BDT',amount:3700,methodName:c.type==='sale.credit'?'Credit':'Cash',...(c.type==='sale.credit'?{creditAccountId:c.accountId,customerId:id(21)}:{})}},
   ...(c.type==='sale.credit'?[{table:'creditEntries',key:c.entryId,before:null,after:{id:c.entryId,outletId:c.outletId,accountId:c.accountId,customerId:id(21),saleId:c.saleId,currency:'BDT',amount:3700,methodName:'Credit'}}]:[])];
 return {id:id(10),replacementId:id(11),command:c,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,entryId:id(12),sequence:1,commandIndex:0,at:1000,money,priorCommands:[]})};
}
function preview(p=packet()){
 return {v:1,id:p.id,replacementId:p.replacementId,commandId:p.command.id,commandHash:'b'.repeat(64),sourceHash:p.sourceHash,businessId:id(30),outletId:p.command.outletId,actorId:id(31),token:'x'.repeat(43),at:2000,expiresAt:62000,
  current:{profileCurrency:'USD',sale:null,entry:null,accountId:null,balance:null,limit:null,creditCurrency:null,creditCustomer:null},
  proposal:{enabled:false,reason:'currency'}};
}
it('recognizes a distinct actual withdrawal of original counter cash without inventing a cash receipt',async()=>{
 const receipt={id:id(10),type:'command.resolved',commandId:original.id,commandType:original.type,outletId:original.outletId,occurredAt:original.occurredAt,commandHash:await moneyFingerprint(original),sourceHash:'a'.repeat(64),at:2000,outcome:'withdrawn',replacement:null};
 expect(parseShopCommandReceipt(receipt,original)).toEqual(receipt);
});
it('keeps original units and source companions while permitting a current unavailable comparison',()=>{
 const p=packet();expect(parseMoneyReviewRequest(p,false)).toEqual(p);expect(originalMoneyFacts(p)).toEqual({currency:'BDT',amount:3700,accountId:null,customerId:null,methodName:'Cash'});
 expect(parsePreparedMoneyReview(preview(p),p).proposal).toEqual({enabled:false,reason:'currency'});
 const source=JSON.parse(p.sourceJson);source.money[0].after.currency='USD';
 expect(()=>parsePreparedMoneyReview({...preview(p),proposal:{enabled:true,currency:'USD',amount:3700,balance:null,confirmation:null,requiresCreditConfirmation:false}},p)).toThrow();
 expect(()=>parsePreparedMoneyReview({...preview(p),proposal:{enabled:true,currency:'BDT',amount:3700,balance:null,confirmation:null,requiresCreditConfirmation:false}},p)).toThrow();
 source.money[0].after.outletId=id(90);expect(()=>parseMoneyReviewRequest({...p,sourceJson:JSON.stringify(source)},false)).toThrow();
});
it('a replacement counter receipt retains original financial IDs and has no invented order revision',async()=>{
 const p=packet(),proposed=reviewedMoneyProposal(original,p.replacementId),receipt={id:proposed.id,occurredAt:proposed.occurredAt,type:proposed.type,outletId:proposed.outletId,saleId:id(3),accountId:null,entryId:null,amount:3700,at:2000,saleUpdatedAt:2000,entrySequence:null,undoOf:null},
  resolved={id:p.id,type:'command.resolved',commandId:original.id,commandType:original.type,outletId:original.outletId,occurredAt:original.occurredAt,commandHash:await moneyFingerprint(original),sourceHash:p.sourceHash,at:2000,outcome:'replaced',replacement:{id:proposed.id,commandHash:await moneyFingerprint(proposed),confirmation:null,receipt}};
 expect(parseShopCommandReceipt(resolved,original)).toEqual(resolved);
 for(const replacement of [{...resolved.replacement,revision:0},{...resolved.replacement,receipt:{...receipt,saleId:id(90)}},{...resolved.replacement,id:original.id},{...resolved.replacement,confirmation:{balance:0,limit:0}}])expect(()=>parseMoneyResolutionReceipt({...resolved,replacement},original)).toThrow();
 expect(proposed).toEqual({...original,id:p.replacementId});
});
it('fresh credit consent changes only a distinct replacement and requires the exact reviewed balance and limit',()=>{
 const credit=financialMoneyCommand({id:id(1),occurredAt:1000,type:'sale.credit',outletId:id(2),saleId:id(3),entryId:id(4),creditEventId:id(5),accountId:id(20),input:{expression:'37',items:[],confirmation:null}}),p=packet(credit),before=JSON.stringify(credit),consent={balance:9000,limit:10000},
  quote={...preview(p),current:{profileCurrency:'BDT',sale:null,entry:null,accountId:id(20),balance:9000,limit:10000,creditCurrency:'BDT',creditCustomer:{id:id(21),name:'Rina',phone:null}},proposal:{enabled:true,currency:'BDT',amount:3700,balance:12700,confirmation:consent,requiresCreditConfirmation:true}};
 expect(parsePreparedMoneyReview(quote,p).proposal).toEqual(quote.proposal);
 expect(parseMoneyReviewRequest({...p,token:quote.token,outcome:'replaced',confirmCredit:true},true).confirmCredit).toBe(true);
 expect(reviewedMoneyProposal(credit,p.replacementId,consent)).toEqual({...credit,id:p.replacementId,input:{...('input'in credit?credit.input:{}),confirmation:consent}});expect(JSON.stringify(credit)).toBe(before);
 for(const proposal of [{...quote.proposal,requiresCreditConfirmation:false},{...quote.proposal,confirmation:{balance:0,limit:10000}},{...quote.proposal,balance:10000},{...quote.proposal,confirmation:null,requiresCreditConfirmation:false}])expect(()=>parsePreparedMoneyReview({...quote,proposal},p)).toThrow();
 expect(()=>parseMoneyReviewRequest({...p,token:quote.token,outcome:'withdrawn',confirmCredit:true},true)).toThrow();
});
it('an original khata undo preserves its account, customer and clock even without a payment method',()=>{
 const command=financialMoneyCommand({id:id(1),occurredAt:1000,type:'khata.undo',outletId:id(2),entryId:id(3),reversalId:id(4)}),p=packet(command);
 expect(originalMoneyFacts(p)).toEqual({currency:'BDT',amount:3700,accountId:id(20),customerId:id(21),methodName:null});
 expect(reviewedMoneyProposal(command,p.replacementId)).toEqual({...command,id:p.replacementId});
 const q=preview(p),valid={...q,current:{...q.current,entry:{id:id(3),currency:'BDT',amount:3700,type:'payment'},accountId:id(20),balance:1000,limit:5000,creditCurrency:'BDT',creditCustomer:{id:id(21),name:'Rina',phone:null}},proposal:{enabled:true,currency:'BDT',amount:3700,balance:4700,confirmation:null,requiresCreditConfirmation:false}};
 expect(parsePreparedMoneyReview(valid,p).proposal.enabled).toBe(true);
 expect(()=>parsePreparedMoneyReview({...valid,current:{...valid.current,accountId:id(22)}},p)).toThrow();
 expect(()=>parsePreparedMoneyReview({...valid,current:{...valid.current,creditCustomer:{...valid.current.creditCustomer,id:id(22)}}},p)).toThrow();
});
it('nonfinancial communications and mismatched review identities cannot become money resolutions',()=>{
 const p=packet();for(const patch of [{id:original.id},{replacementId:id(3)},{sourceHash:''},{command:{...original,type:'khata.communication'}}])expect(()=>parseMoneyReviewRequest({...p,...patch},false)).toThrow();
 const communication=parseMoneyCommand({id:id(1),occurredAt:1000,type:'khata.communication',outletId:id(2),accountId:id(20),entryId:id(3),input:{purpose:'receipt',text:'Original literal text',channel:'manual'}});
 expect(()=>parseShopCommandReceipt({type:'command.resolved'},communication)).toThrow();
});
