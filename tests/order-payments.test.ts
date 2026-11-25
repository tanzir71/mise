import { expect, test } from 'vitest';
import fc from 'fast-check';
import { cancelOrderCommand, refundCashOut, refundOrderCommand, saleCashIn, settleOrderCommand, undoOrderCancellationCommand, undoOrderPaymentCommand, undoOrderRefundCommand, type OrderMoneyChange } from '../packages/core/order-payments';
import { chargeCreditCommand, creditBalance, defaultCreditTerms, openingBalanceCommand, outstandingLots, recordCreditPaymentCommand, type LedgerContext } from '../packages/core/khata';
import { creditOverview } from '../packages/core/khata-reports';
import { dailySales, receiptText, saleTotals } from '../packages/core/sales';
import { saveOrderCommand } from '../packages/core/orders';
import { creditFixture } from './credit-fixture';
import { orderFixture, ORDER_AT as at } from './order-fixture';

function fixture() {
  const {context:ledger,saleContext}=creditFixture('BD',at), input={...orderFixture().input,customerId:ledger.customer.id,phone:ledger.customer.phone!};
  const context={setup:ledger.setup,ledger}, order=saveOrderCommand(input,{...saleContext,customer:ledger.customer,sequence:1},null,0,at).order;
  return {context,order,input};
}
function append(ledger: LedgerContext, change: OrderMoneyChange): LedgerContext { return {...ledger,entries:[...ledger.entries,...change.entries]}; }
function credit() { const f=fixture(), change=settleOrderCommand(f.order,{method:'credit',accountId:f.context.ledger.account.id},f.context,1,at+1); return {...f,change,context:{...f.context,ledger:append(f.context.ledger,change)}}; }

test('cash settlement snapshots order lines, fee, discount, customer and exact change in one command',()=>{
  const {context,input}=fixture();
  const order=saveOrderCommand({...input,type:'delivery',address:'House 12',lines:[{name:'Half kilo',unit:'kg',qty:0.5,unitPrice:245}],deliveryFee:100,discount:23},{setup:context.setup,items:[],customer:context.ledger.customer,sequence:1},null,0,at).order;
  const paid=settleOrderCommand(order,{method:'cash',given:500},context,1,at+1), sale=paid.sales[0];
  expect(paid.order.payment).toMatchObject({method:'cash',status:'paid',saleId:sale.id}); expect(sale).toMatchObject({orderId:order.id,customerId:order.customer.id,amount:200,currency:'BDT',given:500,change:300,items:[{name:'Half kilo',qty:0.5,lineTotal:123}]});
  expect(paid.events.map(event=>event.command)).toEqual(['order.payment','sale.record']); expect(paid.events[0].after).toBe(paid.order);
  expect(order.payment.status).toBe('pending'); expect(order.revision).toBe(1); expect(saleTotals(paid.sales)[0].amount).toBe(200);
  expect(receiptText(sale)).toContain(`Order ${order.number}`); expect(receiptText(sale)).toContain('Delivery: ৳1'); expect(receiptText(sale)).toContain('Discount: −৳0.23');
});

test('unpriced/proposed/finished-cancelled and duplicate or stale payment requests cannot record money',()=>{
  const {context,order}=fixture();
  for(const changed of [{...order,total:null,lines:order.lines.map(line=>({...line,unitPrice:null,lineTotal:null}))},{...order,status:'cancelled' as const},{...order,lines:order.lines.map(line=>({...line,substitution:{from:'Coffee',accepted:false}}))}]) expect(()=>settleOrderCommand(changed,{method:'cash'},context,1,at)).toThrow();
  expect(()=>settleOrderCommand(order,{method:'cash',given:1},context,1,at)).toThrow(/Given/);
  expect(()=>settleOrderCommand(order,{method:'wallet',wallet:'invented'},context,1,at)).toThrow(/wallet/);
  expect(()=>settleOrderCommand(order,{method:'cash'},context,0,at)).toThrow(/changed/);
  const paid=settleOrderCommand(order,{method:'cash'},context,1,at).order; expect(()=>settleOrderCommand(paid,{method:'cash'},context,2,at)).toThrow(/already/);
});

test('zero-total orders settle without inventing a sale or a credit charge',()=>{
  const {context,order}=fixture(), free={...order,subtotal:0,total:0,lines:order.lines.map(line=>({...line,unitPrice:0,lineTotal:0}))};
  const paid=settleOrderCommand(free,{method:'credit'},context,1,at+1); expect(paid.sales).toEqual([]); expect(paid.entries).toEqual([]); expect(paid.order.payment).toMatchObject({method:'cash',status:'paid'});
  const undone=undoOrderPaymentCommand(paid.order,undefined,context,2,at+2); expect(undone.order.payment.status).toBe('pending');
  const cancelled=cancelOrderCommand(paid.order,undefined,context,2,at+2); expect(cancelled.order.payment.cancellation?.refundDue).toBe(0);
});

test('an explicitly supplied bank label can settle an order while ordinary market wallet restrictions remain intact',()=>{
  const {context,order}=fixture(),bank={method:'wallet' as const,wallet:'Bank transfer'};
  expect(()=>settleOrderCommand(order,bank,context,order.revision,at)).toThrow('wallet');
  const paid=settleOrderCommand(order,bank,{...context,wallets:['Bank transfer']},order.revision,at);
  expect(paid.sales[0]).toMatchObject({method:'wallet',methodName:'Bank transfer',amount:order.total,currency:order.currency});
  expect(()=>settleOrderCommand(order,{method:'wallet',wallet:'bKash'},{...context,wallets:['Bank transfer']},order.revision,at)).toThrow('wallet');
  const undone=undoOrderPaymentCommand(paid.order,paid.sales[0],context,paid.order.revision,at+1);
  expect(undone.sales[0].voidReason).toBe('undo');expect(undone.order.payment.status).toBe('pending');
});

test('khata settlement checks current identity, allowed state, currency and exact over-limit consent',()=>{
  const {context,order}=fixture(), limited={...context,ledger:{...context.ledger,account:{...context.ledger.account,limit:1000}}};
  expect(()=>settleOrderCommand(order,{method:'credit',accountId:limited.ledger.account.id},limited,1,at)).toThrow(/limit/);
  expect(()=>settleOrderCommand(order,{method:'credit',accountId:limited.ledger.account.id,confirmation:{balance:1,limit:1000}},limited,1,at)).toThrow();
  const paid=settleOrderCommand(order,{method:'credit',accountId:limited.ledger.account.id,confirmation:{balance:0,limit:1000}},limited,1,at);
  expect(paid.entries[0]).toMatchObject({type:'charge',amount:2500,saleId:paid.sales[0].id,orderId:order.id,overLimit:{balance:0,limit:1000}}); expect(paid.sales[0].given).toBeUndefined();
  expect(()=>settleOrderCommand(order,{method:'credit',accountId:'someone-else'},context,1,at)).toThrow();
  expect(()=>settleOrderCommand(order,{method:'credit',accountId:context.ledger.account.id},{...context,ledger:{...context.ledger,account:{...context.ledger.account,allowed:defaultCreditTerms.allowed}}},1,at)).toThrow(/turned off/);
  const otherCurrency={...context,setup:{...context.setup,outlet:{...context.setup.outlet,currency:'USD'}}};
  expect(()=>settleOrderCommand(order,{method:'credit',accountId:context.ledger.account.id},otherCurrency,1,at)).toThrow(/current-currency/);
  expect(settleOrderCommand(order,{method:'cash'},otherCurrency,1,at).sales[0].currency).toBe('BDT');
});

test('linked payment undo restores pending state and refuses to erase partly collected debt',()=>{
  const {context,change}=credit(), payment=recordCreditPaymentCommand(1000,'cash',undefined,context.ledger,[], '',at+2);
  expect(()=>undoOrderPaymentCommand(change.order,change.sales[0],{...context,ledger:{...context.ledger,entries:[...context.ledger.entries,payment.entry]}},2,at+3)).toThrow(/partly paid/);
  const undone=undoOrderPaymentCommand(change.order,change.sales[0],context,2,at+3); expect(undone.order.payment.status).toBe('pending'); expect(undone.sales[0].voidReason).toBe('undo'); expect(creditBalance(context.ledger.account,[...context.ledger.entries,...undone.entries])).toBe(0);
  expect(()=>undoOrderPaymentCommand(change.order,change.sales[0],context,2,at+600002)).toThrow(/10 minutes/);
});

test('cash cancellation removes the sale from revenue while retaining cash until actual partial refunds',()=>{
  const {context,order}=fixture(), paid=settleOrderCommand(order,{method:'cash'},context,1,at+1), cancelled=cancelOrderCommand(paid.order,paid.sales[0],context,2,at+2);
  expect(cancelled.order.payment.cancellation).toMatchObject({refundDue:2500,refundTotal:2500}); expect(dailySales(cancelled.sales,order.timezone,at+3)).toEqual([]); expect(saleCashIn(cancelled.sales[0])).toBe(2500);
  const first=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:1000,method:'cash'},context,3,at+3);
  const second=refundOrderCommand(first.order,cancelled.sales[0],{amount:1500,method:'wallet',wallet:'Nagad'},context,4,at+4);
  expect(second.order.payment.cancellation?.refundDue).toBe(0); expect(refundCashOut(first.refunds[0])).toBe(1000); expect(refundCashOut(second.refunds[0])).toBe(0); expect(saleCashIn(cancelled.sales[0])-refundCashOut(first.refunds[0])).toBe(1500);
  expect(()=>refundOrderCommand(second.order,cancelled.sales[0],{amount:1,method:'cash'},context,5,at+5)).toThrow(/remaining/);
});

test('refund correction restores the amount owed; cancellation undo waits until recorded refunds are corrected',()=>{
  const {context,order}=fixture(), paid=settleOrderCommand(order,{method:'card'},context,1,at+1), cancelled=cancelOrderCommand(paid.order,paid.sales[0],context,2,at+2);
  const refunded=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:2500,method:'card'},context,3,at+3);
  expect(()=>undoOrderCancellationCommand(refunded.order,cancelled.events[0],cancelled.sales[0],context,4,at+4)).toThrow(/refund has been recorded/);
  const correction=undoOrderRefundCommand(refunded.order,refunded.refunds[0],context,4,at+4); expect(correction.order.payment.cancellation?.refundDue).toBe(2500); expect(correction.refunds[0].voidedAt).toBe(at+4);
  const restored=undoOrderCancellationCommand(correction.order,cancelled.events[0],cancelled.sales[0],context,5,at+3600000); expect(restored.order.status).toBe('requested'); expect(restored.order.payment.cancellation).toBeUndefined(); expect(restored.sales[0].voidedAt).toBeUndefined();
  expect(()=>undoOrderRefundCommand(correction.order,correction.refunds[0],context,5,at+5)).toThrow();
});

test('credit cancellation clears remaining debt and a collected portion becomes a separately recorded refund',()=>{
  const {context,change}=credit(), payment=recordCreditPaymentCommand(1000,'cash',undefined,context.ledger,[], '',at+2);
  let ledger={...context.ledger,entries:[...context.ledger.entries,payment.entry]};
  const cancelled=cancelOrderCommand(change.order,change.sales[0],{...context,ledger},2,at+3); ledger=append(ledger,cancelled);
  expect(creditBalance(ledger.account,ledger.entries)).toBe(0); expect(cancelled.order.payment.cancellation).toMatchObject({refundDue:1000}); expect(outstandingLots(ledger.account,ledger.entries)).toEqual([]);
  const refunded=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:1000,method:'cash'},{...context,ledger},3,at+4); ledger=append(ledger,refunded);
  expect(creditBalance(ledger.account,ledger.entries)).toBe(0); expect(creditOverview(ledger.account,ledger.entries,'Asia/Dhaka','BD',at+5).collectedThisWeek).toBe(0); expect(refunded.entries[0]).toMatchObject({type:'refund',amount:1000,refundId:refunded.refunds[0].id});
  const correction=undoOrderRefundCommand(refunded.order,refunded.refunds[0],{...context,ledger},4,at+5); ledger=append(ledger,correction);
  expect(creditOverview(ledger.account,ledger.entries,'Asia/Dhaka','BD',at+6).collectedThisWeek).toBe(1000);
  const restored=undoOrderCancellationCommand(correction.order,cancelled.events[0],cancelled.sales[0],{...context,ledger},5,at+6); ledger=append(ledger,restored); expect(creditBalance(ledger.account,ledger.entries)).toBe(1500);
});

test('cancelling newer credit preserves the older unpaid lot and its date',()=>{
  const {context,order}=fixture(), opening=openingBalanceCommand(10000,at-40*86400000,context.ledger,at);
  let ledger={...context.ledger,entries:[opening.entry]};
  const paid=settleOrderCommand(order,{method:'credit',accountId:ledger.account.id},{...context,ledger},1,at+1); ledger=append(ledger,paid);
  const cancelled=cancelOrderCommand(paid.order,paid.sales[0],{...context,ledger},2,at+2); ledger=append(ledger,cancelled);
  expect(outstandingLots(ledger.account,ledger.entries)).toEqual([{amount:10000,at:at-40*86400000}]); expect(creditOverview(ledger.account,ledger.entries,'Asia/Dhaka','BD',at+3).over30Amount).toBe(10000);
});

test('credit return and refunds match an independent net-debt and retained-payment model',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:0,max:200000}),(older,amount,seed)=>{
    const {context,input}=fixture(); let ledger={...context.ledger,account:{...context.ledger.account,limit:1000000}};
    if(older) ledger={...ledger,entries:[openingBalanceCommand(older,at-40*86400000,ledger,at).entry]};
    const order=saveOrderCommand({...input,lines:[{name:'Order item',unit:'pc',qty:1,unitPrice:amount}]},{setup:context.setup,items:[],customer:ledger.customer,sequence:1},null,0,at).order;
    const paid=settleOrderCommand(order,{method:'credit',accountId:ledger.account.id},{...context,ledger},1,at+1); ledger=append(ledger,paid);
    const collected=seed%(older+amount+1); if(collected) ledger={...ledger,entries:[...ledger.entries,recordCreditPaymentCommand(collected,'cash',undefined,ledger,[], '',at+2).entry]};
    const cancelled=cancelOrderCommand(paid.order,paid.sales[0],{...context,ledger},2,at+3); ledger=append(ledger,cancelled);
    expect(creditBalance(ledger.account,ledger.entries)).toBe(Math.max(0,older-collected)); expect(cancelled.order.payment.cancellation?.refundDue).toBe(Math.max(0,collected-older));
    expect(outstandingLots(ledger.account,ledger.entries).reduce((sum,lot)=>sum+lot.amount,0)).toBe(Math.max(0,older-collected));
    const due=cancelled.order.payment.cancellation!.refundDue;
    if(due) { const refund=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:due,method:'cash'},{...context,ledger},3,at+4); ledger=append(ledger,refund); }
    expect(creditOverview(ledger.account,ledger.entries,'Asia/Dhaka','BD',at+5).collectedThisWeek).toBe(Math.min(collected,older));
  }),{numRuns:500});
},15000);

test('refunds may cross week boundaries without converting currency or changing balances',()=>{
  const {context,change}=credit(), payment=recordCreditPaymentCommand(2500,'wallet','bKash',context.ledger,['bKash'], '',at+2);
  let ledger={...context.ledger,entries:[...context.ledger.entries,payment.entry]}; const when=at+7*86400000;
  const cancelled=cancelOrderCommand(change.order,change.sales[0],{...context,ledger},2,when); ledger=append(ledger,cancelled);
  const refunded=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:2500,method:'cash'},{...context,ledger},3,when+1); ledger=append(ledger,refunded);
  expect(creditOverview(ledger.account,ledger.entries,'Asia/Dhaka','BD',when+2).collectedThisWeek).toBe(-2500); expect(creditBalance(ledger.account,ledger.entries)).toBe(0);
  expect(()=>refundOrderCommand(cancelled.order,{...cancelled.sales[0],currency:'USD'},{amount:100,method:'cash'},{...context,ledger},3,when+2)).toThrow(/match/);
  expect(()=>undoOrderRefundCommand(refunded.order,refunded.refunds[0],{...context,ledger},4,when+600002)).toThrow(/10 minutes/);
});

test('historical wallet choices remain recordable after market settings change',()=>{
  const {context,order}=fixture(),older={...order,payment:{...order.payment,method:'wallet' as const,wallet:'bKash'}};
  const changed={...context,setup:{...context.setup,business:{...context.setup.business,marketCode:'OTHER' as const},outlet:{...context.setup.outlet,currency:'USD'}}};
  const paid=settleOrderCommand(older,{method:'wallet',wallet:'bKash'},changed,1,at+1); expect(paid.sales[0]).toMatchObject({methodName:'bKash',currency:'BDT',amount:2500});
});

test('reinstating cancelled credit cannot overflow the balance after later purchases',()=>{
  const {context,change}=credit(),cancelled=cancelOrderCommand(change.order,change.sales[0],context,2,at+2);
  let ledger={...append(context.ledger,cancelled),account:{...context.ledger.account,limit:Number.MAX_SAFE_INTEGER}};
  const later=chargeCreditCommand(Number.MAX_SAFE_INTEGER,ledger,{},at+3);ledger={...ledger,entries:[...ledger.entries,later.entry]};
  expect(()=>undoOrderCancellationCommand(cancelled.order,cancelled.events[0],cancelled.sales[0],{...context,ledger},3,at+4)).toThrow(/supported amount/);
});
