import {expect,it} from 'vitest';
import {financialPurchaseCommand,originalPurchaseFacts,parsePurchaseReviewRequest,parsePurchaseReviewSource,parsePreparedPurchaseReview,reviewedPurchaseProposal,parsePurchaseResolutionReceipt,type FinancialPurchaseCommand,type PurchaseReviewRequest} from '../packages/core/purchase-review';
import {purchaseLineValue} from '../packages/core/purchases';
import {purchaseFingerprint} from '../packages/core/purchase-replay';
const id=(n:number)=>String(n).padStart(26,'0'),literal='Invoice · বাংলা\0\ud800';
const record=financialPurchaseCommand({id:id(1),type:'purchase.record',outletId:id(2),purchaseId:id(3),occurredAt:1000,input:{supplierId:null,supplierName:' Original supplier ',reference:literal,lines:[{stockItemId:null,name:' Rice ',unit:' kg ',qty:2.5,unitPrice:12001}],paid:'due',wallet:null,note:literal}});
function row(){if(record.type!=='purchase.record')throw Error();return {id:record.purchaseId,outletId:record.outletId,supplierName:record.input.supplierName.trim(),reference:literal,lines:record.input.lines.map(line=>purchaseLineValue({...line,stockItemId:line.stockItemId??undefined})),total:30003,currency:'BDT',timezone:'Asia/Dhaka',paid:'due',methodName:'Due',note:literal,createdBy:id(4),eventId:record.id,createdAt:1000,updatedAt:1000};}
function packet(c:FinancialPurchaseCommand=record,grouped=false):PurchaseReviewRequest {
 const before=c.type==='purchase.record'||grouped?null:row(),after=c.type==='purchase.undo'?{...row(),voidedAt:c.occurredAt,updatedAt:c.occurredAt}:row();
 return {id:id(10),replacementId:id(11),command:c,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,entryId:id(12),sequence:1,commandIndex:grouped?1:0,at:1000,purchase:{table:'purchases',key:c.purchaseId,before,after},priorCommands:grouped?[record]:[]})};
}
function preview(p=packet(),enabled=false){const {eventId:_eventId,createdBy:_createdBy,...invoice}=originalPurchaseFacts(p);void _eventId;void _createdBy;return {v:1,id:p.id,replacementId:p.replacementId,commandId:p.command.id,commandHash:'b'.repeat(64),sourceHash:p.sourceHash,businessId:id(30),outletId:p.command.outletId,actorId:id(31),token:'x'.repeat(43),at:2000,expiresAt:62000,current:{profileCurrency:enabled?'BDT':'USD',profileTimezone:'Asia/Dhaka',supplier:null,invoice:null},proposal:enabled?{enabled:true,invoice}:{enabled:false,reason:'currency'}};}
it('keeps every original invoice value, literal text, quantity and monetary unit without receiving stock',()=>{
 const p=packet(),source=JSON.stringify(p);expect(parsePurchaseReviewRequest(p,false)).toEqual(p);expect(originalPurchaseFacts(p)).toMatchObject({id:id(3),currency:'BDT',total:30003,paid:'due',methodName:'Due',reference:literal,createdAt:1000,eventId:id(1),lines:[{qty:2.5,unitPrice:12001,lineTotal:30003}]});expect(JSON.stringify(p)).toBe(source);expect(parsePreparedPurchaseReview(preview(p),p).proposal).toEqual({enabled:false,reason:'currency'});
});
it.each(['currency','total','unitPrice','lineTotal','quantity','outlet','purchase','event','supplier','created','method','note','authority'])('rejects a changed original %s fact before review',kind=>{
 const p=packet(),s=JSON.parse(p.sourceJson),a=s.purchase.after;
 if(kind==='currency')a.currency='bad';else if(kind==='total')a.total++;else if(kind==='unitPrice')a.lines[0].unitPrice++;else if(kind==='lineTotal')a.lines[0].lineTotal++;else if(kind==='quantity')a.lines[0].qty=3;else if(kind==='outlet')a.outletId=id(90);else if(kind==='purchase')a.id=id(90);else if(kind==='event')a.eventId=id(90);else if(kind==='supplier')a.supplierId=id(90);else if(kind==='created')a.createdAt=999;else if(kind==='method')a.methodName='Cash';else if(kind==='note')a.note='Replaced';else a.auth_user_id='authority';
 expect(()=>parsePurchaseReviewRequest({...p,sourceJson:JSON.stringify(s)},false)).toThrow();
});
it('only enables the exact original-unit invoice with the current supplier and profile date context',()=>{
 const p=packet(),valid=preview(p,true);expect(parsePreparedPurchaseReview(valid,p).proposal.enabled).toBe(true);
 for(const patch of [{currency:'USD'},{total:30004},{paid:'cash',methodName:'Cash'},{createdAt:2000},{timezone:'UTC'},{supplierName:'Changed'},{voided:true},{id:id(90)}])expect(()=>parsePreparedPurchaseReview({...valid,proposal:{enabled:true,invoice:{...valid.proposal.invoice,...patch}}},p)).toThrow();
 expect(()=>parsePreparedPurchaseReview({...valid,current:{...valid.current,profileCurrency:'USD'}},p)).toThrow();
});
it('an existing supplier name is reviewed explicitly but cannot retarget the saved invoice',()=>{
 const p=packet();if(p.command.type!=='purchase.record')throw Error();p.command={...p.command,input:{...p.command.input,supplierId:id(50)}};const source=JSON.parse(p.sourceJson);source.purchase.after.supplierId=id(50);p.sourceJson=JSON.stringify(source);
 const v=preview(p,true),current={...v.current,supplier:{id:id(50),name:'Current supplier name',archived:false}},proposal={enabled:true,invoice:{...v.proposal.invoice,supplierName:'Current supplier name'}};
 expect(parsePreparedPurchaseReview({...v,current,proposal},p).proposal.enabled).toBe(true);expect(()=>parsePreparedPurchaseReview({...v,current:{...current,supplier:{...current.supplier,archived:true}},proposal},p)).toThrow();expect(()=>parsePreparedPurchaseReview({...v,current:{...current,supplier:{...current.supplier,id:id(51)}},proposal},p)).toThrow();
});
it('historical-currency undo keeps the actual invoice and original ten-minute clock',()=>{
 const undo=financialPurchaseCommand({id:id(5),type:'purchase.undo',outletId:id(2),purchaseId:id(3),occurredAt:2000}),p=packet(undo),v=preview(p,true),facts=originalPurchaseFacts(p),{eventId:_eventId,createdBy:_createdBy,...after}=facts,current={...v.current,profileCurrency:'USD',invoice:{...after,voided:false}};
 void _eventId;void _createdBy;expect(parsePreparedPurchaseReview({...v,current,proposal:{enabled:true,invoice:after}},p).proposal.enabled).toBe(true);expect(reviewedPurchaseProposal(undo,id(11))).toEqual({...undo,id:id(11)});
 for(const change of [{at:601001,expiresAt:661001},{current:{...current,invoice:{...current.invoice,voided:true}}},{current:{...current,invoice:{...current.invoice,total:30004}}}])expect(()=>parsePreparedPurchaseReview({...v,current,proposal:{enabled:true,invoice:after},...change},p)).toThrow();
});
it('a grouped undo needs its actual earlier creation with matching complete financial values',()=>{
 const c=financialPurchaseCommand({id:id(5),type:'purchase.undo',outletId:id(2),purchaseId:id(3),occurredAt:2000}),p=packet(c,true);expect(parsePurchaseReviewSource(p).priorCommands).toEqual([record]);
 for(const changed of ['missing','id','price','supplier','note']){const s=JSON.parse(p.sourceJson);if(changed==='missing')s.priorCommands=[];else if(changed==='id')s.priorCommands[0].id=id(90);else if(changed==='price')s.priorCommands[0].input.lines[0].unitPrice++;else if(changed==='supplier')s.priorCommands[0].input.supplierName='Other';else s.priorCommands[0].input.note='Other';expect(()=>parsePurchaseReviewSource({...p,sourceJson:JSON.stringify(s)})).toThrow();}
});
it('undo cannot change the invoice payment, literal note or original creation data',()=>{
 const c=financialPurchaseCommand({id:id(5),type:'purchase.undo',outletId:id(2),purchaseId:id(3),occurredAt:2000}),p=packet(c);
 for(const patch of [{currency:'USD'},{note:'Changed'},{eventId:id(90)},{paid:'cash',methodName:'Cash'},{createdAt:999},{voidedAt:2001}]){const s=JSON.parse(p.sourceJson);Object.assign(s.purchase.after,patch);expect(()=>parsePurchaseReviewSource({...p,sourceJson:JSON.stringify(s)})).toThrow();}
});
it('a distinct replacement and its actual receipt preserve the invoice ID and physical time',async()=>{
 const p=packet(),before=JSON.stringify(record),replacement=reviewedPurchaseProposal(record,p.replacementId),receipt={id:replacement.id,type:replacement.type,outletId:replacement.outletId,occurredAt:1000,at:2000,supplierId:null,purchaseId:id(3),revision:null,total:30003,updatedAt:2000,voidedAt:null,undoOf:null},proof={id:p.id,type:'command.resolved',commandId:record.id,commandType:record.type,outletId:record.outletId,occurredAt:1000,commandHash:await purchaseFingerprint(record),sourceHash:p.sourceHash,at:2000,outcome:'replaced',replacement:{id:replacement.id,commandHash:await purchaseFingerprint(replacement),receipt}};
 expect(parsePurchaseResolutionReceipt(proof,record)).toEqual(proof);expect(replacement).toEqual({...record,id:p.replacementId});expect(JSON.stringify(record)).toBe(before);
 for(const patch of [{id:record.id},{receipt:{...receipt,purchaseId:id(90)}},{receipt:{...receipt,occurredAt:2000}},{receipt:{...receipt,total:30004}},{revision:0}])expect(()=>parsePurchaseResolutionReceipt({...proof,replacement:{...proof.replacement,...patch}},record)).toThrow();
 expect(parsePurchaseResolutionReceipt({...proof,outcome:'withdrawn',replacement:null},record).replacement).toBeNull();expect(()=>parsePurchaseResolutionReceipt({...proof,outcome:'withdrawn'},record)).toThrow();
});
it('supplier edits and review/financial ID aliases cannot become invoice resolutions',()=>{
 const p=packet();for(const patch of [{id:record.id},{replacementId:id(3)},{id:id(2)},{replacementId:id(10)},{sourceHash:''},{command:{...record,type:'supplier.create'}}])expect(()=>parsePurchaseReviewRequest({...p,...patch},false)).toThrow();
 expect(()=>parsePurchaseReviewRequest({...p,token:'x'.repeat(43),outcome:'replaced',confirmCredit:false},true)).toThrow();expect(parsePurchaseReviewRequest({...p,token:'x'.repeat(43),outcome:'withdrawn'},true).outcome).toBe('withdrawn');
});
