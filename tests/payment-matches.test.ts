import {expect,it} from 'vitest';
import fc from 'fast-check';
import {setupCommand} from '../packages/core/setup';
import {saveOrderCommand} from '../packages/core/orders';
import {settleOrderCommand,undoOrderPaymentCommand} from '../packages/core/order-payments';
import {recordSaleCommand,undoSaleCommand} from '../packages/core/sales';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,openingBalanceCommand,recordCreditPaymentCommand,saveCreditTermsCommand,undoCreditEntryCommand} from '../packages/core/khata';
import type {Order,Sale,Customer,CreditAccount,CreditEntry,OrderRefund} from '../packages/core/models';
import {parsePaymentText,type ParsedPaymentText} from '../packages/core/payments';
import {findPaymentTextMatches,paymentMatchWindowMs} from '../packages/core/payment-matches';

const at=Date.UTC(2026,10,25,8,30),minute=60000;
const source=()=>parsePaymentText('You have received Tk 910 from 01712345482. TrxID TESTMATCH1 at 25/11/2026 14:30',{receivedAt:at+minute,timeZone:'Asia/Dhaka',currency:'BDT',market:'BD',sender:'bKash'});
function fixture(){const seed=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Payment matching',phone:'01712345482'},null,at);return {setup:seed.snapshot,items:seed.items,orders:[] as Order[],sales:[] as Sale[],customers:[] as Customer[],accounts:[] as CreditAccount[],entries:[] as CreditEntry[],refunds:[] as OrderRefund[]};}
type Records=ReturnType<typeof fixture>;
function order(r:Records,time=at-minute,phone='01712345482'){
 const result=saveOrderCommand({source:'phone',sourceText:'',name:'Customer',phone,type:'pickup',address:'',table:'',lines:[{name:'Rice',unit:'pc',qty:1,unitPrice:91000}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup:r.setup,items:r.items,sequence:r.orders.length+1},null,0,time).order;r.orders.push(result);return result;
}
function sale(r:Records,time=at-minute,method:'cash'|'wallet'|'card'='wallet',wallet='bKash'){
 const result=recordSaleCommand({expression:'910',method,...(method==='wallet'?{wallet}:{})},{setup:r.setup,items:r.items,wallets:['bKash','Nagad','Bank transfer','Configured bank']},time).sale;r.sales.push(result);return result;
}
function credit(r:Records,time=at-minute){
 const customer=saveCustomerCommand({name:'Full customer',nickname:'Customer nickname',phone:'01712345482',address:'',notes:'',tags:[]},r.setup,[],null,at-10*minute).customer;
 const account=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:300000},customer,r.setup,null,at-10*minute).account;
 const context={setup:r.setup,customer,account,entries:[] as CreditEntry[]},opening=openingBalanceCommand(200000,at-10*minute,context,at-10*minute).entry;
 context.entries.push(opening);const entry=recordCreditPaymentCommand(91000,'wallet','bKash',context,['bKash','Nagad'],'Checked transfer',time).entry;
 r.customers.push(customer);r.accounts.push(account);r.entries.push(opening,entry);return {entry,context};
}
it('selects one exact open order by amount/time without changing its pending payment or making a receipt',()=>{
 const r=fixture(),o=order(r),before=structuredClone(r),result=findPaymentTextMatches(source(),r);
 expect(result).toMatchObject({selection:'automatic',eligibleCount:1,windowMs:paymentMatchWindowMs,candidates:[{kind:'order',id:o.id,state:'open',amount:91000,distanceMs:minute}]});expect(r).toEqual(before);expect(r.sales).toEqual([]);expect(r.orders[0].payment.status).toBe('pending');
});
it('returns exactly the top three and counts every exact candidate instead of silently discarding ambiguity',()=>{
 const r=fixture();for(const distance of [5,2,4,1,3])sale(r,at-distance*minute);
 const result=findPaymentTextMatches(source(),r);expect(result.selection).toBe('choose');expect(result.eligibleCount).toBe(5);expect(result.candidates.map(c=>c.distanceMs)).toEqual([minute,2*minute,3*minute]);
});
it('ranks stable ties independently of input order and retains exact complete current data',()=>{
 const r=fixture();for(let n=0;n<5;n++)sale(r,at-minute);const forward=findPaymentTextMatches(source(),r),reverse=findPaymentTextMatches(source(),{...r,sales:[...r.sales].reverse()});expect(reverse).toEqual(forward);
 const first=r.sales.find(s=>s.id===forward.candidates[0].id)!;first.who='Full\0\ud800'+('名'.repeat(50000));const after=findPaymentTextMatches(source(),r);expect(after.candidates[0].customerName).toBe(first.who);expect(after.candidates[0].fingerprint).not.toBe(forward.candidates[0].fingerprint);expect(JSON.parse(after.candidates[0].fingerprint).sale.who).toBe(first.who);
});
it('does not suggest another outlet, currency, amount or a record outside the exact time window',()=>{
 const r=fixture(),other=fixture();sale(other);sale(r,at-paymentMatchWindowMs-1);const s=sale(r);s.currency='USD';const o=order(r);o.total=91001;
 r.sales.push(...other.sales);expect(findPaymentTextMatches(source(),r)).toMatchObject({selection:'none',eligibleCount:0,candidates:[]});
});
it('includes the time boundary and uses the explicit configured window rather than a hard-coded date',()=>{
 const r=fixture();sale(r,at-paymentMatchWindowMs);expect(findPaymentTextMatches(source(),r).selection).toBe('automatic');expect(findPaymentTextMatches(source(),r,{windowMs:paymentMatchWindowMs-1}).selection).toBe('none');
 for(const windowMs of [0,-1,1.5,86400001,NaN,Infinity])expect(()=>findPaymentTextMatches(source(),r,{windowMs})).toThrow('within one day');
});
it('keeps manual or capture-time-only parses as choices until the received time is explicitly checked',()=>{
 const r=fixture();order(r);const p=source();p.timeSource='capture';expect(findPaymentTextMatches(p,r).selection).toBe('choose');expect(findPaymentTextMatches(p,r,{receivedTimeConfirmed:true}).selection).toBe('automatic');p.status='manual';expect(findPaymentTextMatches(p,r,{receivedTimeConfirmed:true}).selection).toBe('choose');
});
it('does not interpret outgoing money, a balance-only source or an unsafe minor-unit amount as a receipt',()=>{
 const r=fixture();order(r);for(const p of [{...source(),direction:'outgoing' as const},{...source(),amount:null},{...source(),amount:9.1},{...source(),amount:-1}])expect(findPaymentTextMatches(p,r).selection).toBe('none');
});
it('uses a full known phone to exclude another customer, leaving masked/unknown senders ambiguous',()=>{
 const r=fixture(),good=order(r);order(r,at-minute,'01812345482');expect(findPaymentTextMatches(source(),r).candidates.map(c=>c.id)).toEqual([good.id]);
 expect(findPaymentTextMatches({...source(),fromPhone:null},r)).toMatchObject({selection:'choose',eligibleCount:2});
});
it('excludes finished, cancelled, unpriced, credited and already-paid orders from open-order matching',()=>{
 const r=fixture();for(const status of ['done','cancelled','delivered','collected','returned'] as const)order(r).status=status;
 order(r).total=null;order(r).payment.status='credited';order(r).payment.status='paid';expect(findPaymentTextMatches(source(),r).selection).toBe('none');
});
it('matches only the actual recorded method, including installation-selected bank labels',()=>{
 const r=fixture();sale(r,at-minute,'cash');sale(r,at-minute,'card');sale(r,at-minute,'wallet','Nagad');const inconsistent=sale(r,at-minute,'cash');inconsistent.methodName='bKash';const bk=sale(r),bank=sale(r,at-minute,'wallet','Configured bank');
 expect(findPaymentTextMatches(source(),r).candidates.map(c=>c.id)).toEqual([bk.id]);const p={...source(),channel:'bank' as const};expect(findPaymentTextMatches(p,r).selection).toBe('none');expect(findPaymentTextMatches(p,r,{methodNames:{bank:['Configured bank']}}).candidates.map(c=>c.id)).toEqual([bank.id]);
});
it('does not offer voided counter receipts or money already associated with another confirmed source',()=>{
 const r=fixture(),s=sale(r);r.sales[0]=undoSaleCommand(s,r.setup.owner.id,at).sale;expect(findPaymentTextMatches(source(),r).selection).toBe('none');
 const next=sale(r);expect(findPaymentTextMatches(source(),r,{usedReceipts:[{kind:'sale',id:next.id}]}).selection).toBe('none');
});
it('represents a paid order by its current real receipt once and never revives an older payment',()=>{
 const r=fixture(),o=order(r),paid=settleOrderCommand(o,{method:'wallet',wallet:'bKash'},{setup:r.setup},o.revision,at-minute);r.orders[0]=paid.order;r.sales.push(...paid.sales);
 let result=findPaymentTextMatches(source(),r);expect(result).toMatchObject({selection:'automatic',eligibleCount:1,candidates:[{kind:'sale',id:paid.sales[0].id,orderId:o.id,state:'recorded'}]});
 const undone=undoOrderPaymentCommand(paid.order,paid.sales[0],{setup:r.setup},paid.order.revision,at);r.sales[0]=undone.sales[0];r.orders[0]=undone.order;result=findPaymentTextMatches(source(),r);expect(result).toMatchObject({selection:'automatic',eligibleCount:1,candidates:[{kind:'order',id:o.id,state:'open'}]});expect(result.candidates[0].id).not.toBe(paid.sales[0].id);
});
it('offers actual khata collections rather than debt, reminder, adjustment or reversed payment entries',()=>{
 const r=fixture(),f=credit(r);expect(findPaymentTextMatches(source(),r)).toMatchObject({selection:'automatic',eligibleCount:1,candidates:[{kind:'credit',id:f.entry.id,state:'recorded',customerName:'Customer nickname'}]});
 const undone=undoCreditEntryCommand(f.entry,{...f.context,entries:r.entries},at);r.entries.push(undone.entry);expect(findPaymentTextMatches(source(),r).selection).toBe('none');
});
it('checks actual khata account/customer/currency scope and honors used financial identities',()=>{
 const r=fixture(),f=credit(r);expect(findPaymentTextMatches(source(),r,{usedReceipts:[{kind:'credit',id:f.entry.id}]}).selection).toBe('none');
 r.accounts[0].customerId=fixture().setup.owner.id;expect(findPaymentTextMatches(source(),r).selection).toBe('none');
});
it('keeps archived customer receipt history eligible without granting permission to collect new debt',()=>{
 const r=fixture();credit(r);r.customers[0].archivedAt=at;r.accounts[0].allowed=false;expect(findPaymentTextMatches(source(),r)).toMatchObject({selection:'automatic',candidates:[{kind:'credit',state:'recorded'}]});
});
it('cannot turn conflicting copies of one native identity into an automatic association',()=>{
 const r=fixture(),s=sale(r);r.sales.push({...s,who:'Different source'});expect(findPaymentTextMatches(source(),r)).toMatchObject({selection:'choose',eligibleCount:1});
});
it('preserves complete literal snapshots for comparison and changes them after an actual order edit',()=>{
 const r=fixture(),o=order(r),first=findPaymentTextMatches(source(),r).candidates[0];o.customer.name='Literal\0\ud800';o.revision++;const second=findPaymentTextMatches(source(),r).candidates[0];expect(second.fingerprint).not.toBe(first.fingerprint);expect(JSON.parse(second.fingerprint).order.customer.name).toBe(o.customer.name);
});
it('keeps exact amount/time/window invariants across arbitrary incoming source proposals',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:-86400000,max:86400000}),(minor,delta)=>{
  const r=fixture(),s=sale(r,at+delta);s.amount=minor;const p:ParsedPaymentText={...source(),amount:minor};const result=findPaymentTextMatches(p,r);expect(result.eligibleCount).toBe(Math.abs(delta)<=paymentMatchWindowMs?1:0);expect(result.candidates.every(c=>c.amount===minor&&c.currency===p.currency&&c.distanceMs<=paymentMatchWindowMs)).toBe(true);
 }),{numRuns:100});
});
