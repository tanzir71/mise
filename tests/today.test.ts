import { expect, test } from 'vitest';
import fc from 'fast-check';
import { closingPreview, dayKey, denominationTotal, todayOverview, type TodayContext } from '../packages/core/today';
import { closeDayCommand, canUndoClosing, daySummaryText, newClosingId, undoClosingCommand } from '../packages/core/closing';
import { recordSaleCommand, canUndoSale, undoSaleCommand } from '../packages/core/sales';
import { recordCreditSaleCommand } from '../packages/core/credit-sales';
import { recordCreditPaymentCommand, undoCreditEntryCommand } from '../packages/core/khata';
import { saveOrderCommand } from '../packages/core/orders';
import type { OrderRefund } from '../packages/core/models';
import { creditFixture, at } from './credit-fixture';
import { orderFixture } from './order-fixture';
import { stockFixture } from './stock-fixture';

function fixture() {
  const {context:ledger,saleContext} = creditFixture(), context:TodayContext = {setup:ledger.setup,sales:[],orders:[],refunds:[],accounts:[ledger.account],entries:[],customers:[ledger.customer],stock:[],closings:[]};
  const sale = (expression:string, method:'cash'|'wallet'|'card' = 'cash', when = at) => recordSaleCommand({expression,method,...(method === 'wallet' ? {wallet:'bKash'} : {})},saleContext,when).sale;
  const input = (countedCash:number,addDifference = false,note = '') => {const preview = closingPreview(context,at+1000);return {id:newClosingId(at),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash,addDifference,note};};
  return {context,ledger,saleContext,sale,input};
}
test('Today separates active sales, retained cancelled cash, gross collections and actual refunds',() => {
  const {context,ledger,saleContext,sale} = fixture();
  const credit = recordCreditSaleCommand({expression:'40',customerId:ledger.customer.id,accountId:ledger.account.id},ledger,saleContext,at);
  context.sales = [sale('100'),sale('60','wallet'),sale('30','card'),credit.sale,{...sale('25'),voidedAt:at+1,voidReason:'order-cancel'}, {...sale('50'),voidedAt:at+1,voidReason:'undo'},sale('70','cash',at-86400000),sale('10','cash',at+60000),{...sale('90'),outletId:'other'},{...sale('90'),currency:'USD'}];
  const payment = recordCreditPaymentCommand(1000,'cash',undefined,{...ledger,entries:[credit.entry]},[], '',at+1).entry;
  context.entries = [credit.entry,payment,{...payment,id:'credit-refund',type:'refund',amount:200,sequence:3}];
  context.refunds = [{id:'refund',outletId:context.setup.outlet.id,orderId:'order',saleId:'sale',amount:500,currency:'BDT',method:'cash',methodName:'Cash',note:'',createdBy:ledger.setup.owner.id,eventId:'refund-event',createdAt:at,updatedAt:at}];
  expect(todayOverview(context,at+1000).summary).toMatchObject({sales:23000,saleCount:4,creditGiven:4000,creditCollected:800,cashSales:12500,cashCollections:1000,cashRefunds:500,expectedCash:13000,averageTimeMs:null,split:[{method:'cash',amount:10000,count:1},{method:'wallet',amount:6000,count:1},{method:'card',amount:3000,count:1},{method:'credit',amount:4000,count:1}]});
});
test('corrections remove payment pairs and cancelled credit from credit given without losing retained cash',() => {
  const {context,ledger,saleContext,sale} = fixture(), credit = recordCreditSaleCommand({expression:'40',customerId:ledger.customer.id,accountId:ledger.account.id},ledger,saleContext,at);
  const payment = recordCreditPaymentCommand(1000,'cash',undefined,{...ledger,entries:[credit.entry]},[],'',at+1).entry;
  const reversal = undoCreditEntryCommand(payment,{...ledger,entries:[credit.entry,payment]},at+2).entry;
  context.sales = [{...credit.sale,voidedAt:at+3,voidReason:'order-cancel'},sale('20')];context.entries = [credit.entry,payment,reversal];
  expect(todayOverview(context,at+1000).summary).toMatchObject({sales:2000,creditGiven:0,creditCollected:0,cashCollections:0,expectedCash:2000});
});
test('operational tiles use actual waiting orders, completed durations, active low stock and due customers',() => {
  const {context,ledger} = fixture(), order = saveOrderCommand(orderFixture().input,{setup:context.setup,items:[],sequence:1},null,0,at-300000).order;
  context.orders = [order,{...order,id:'complete',status:'done',statusChangedAt:at-1000},{...order,id:'old-waiting',createdAt:at-86400000},{...order,id:'cancelled',status:'cancelled'},{...order,id:'foreign',outletId:'other'}];
  const stock = {...stockFixture().items[0],outletId:context.setup.outlet.id,onHand:0};context.stock = [stock,{...stock,id:'archived',archivedAt:at},{...stock,id:'foreign',outletId:'other'}];
  context.accounts = [{...ledger.account,reminder:{...ledger.account.reminder,dayOfMonth:15}}];
  context.entries = [{id:'charge',accountId:ledger.account.id,customerId:ledger.customer.id,outletId:context.setup.outlet.id,currency:'BDT',sequence:1,type:'charge',amount:100,note:'',createdBy:ledger.setup.owner.id,eventId:'charge-event',createdAt:at,updatedAt:at}];
  expect(todayOverview(context,at+1000).summary).toMatchObject({waitingOrders:2,orderCount:2,completedOrders:1,averageTimeMs:299000,lowStock:1,dueReminders:1});
  context.customers = [{...ledger.customer,archivedAt:at}];expect(todayOverview(context,at+1000).summary.dueReminders).toBe(0);
});
test('local midnight and both occurrences of a DST hour use the outlet civil day',() => {
  expect(dayKey(Date.parse('2026-11-15T17:59:59Z'),'Asia/Dhaka')).toBe('2026-11-15');expect(dayKey(Date.parse('2026-11-15T18:00:00Z'),'Asia/Dhaka')).toBe('2026-11-16');
  expect(dayKey(Date.parse('2026-11-01T05:30:00Z'),'America/New_York')).toBe('2026-11-01');expect(dayKey(Date.parse('2026-11-01T06:30:00Z'),'America/New_York')).toBe('2026-11-01');
  expect(() => dayKey(NaN,'UTC')).toThrow();
});
test('cash totals match the retained receipt sum for arbitrary mixtures and corrections',() => {
  fc.assert(fc.property(fc.array(fc.record({amount:fc.integer({min:1,max:1000000}),state:fc.constantFrom('active','cancelled','undone')}),{maxLength:80}),records => {
    const {context,sale} = fixture(), template = sale('1');
    context.sales = records.map((row,index) => ({...template,id:String(index),amount:row.amount,...(row.state === 'active' ? {} : {voidedAt:at,voidReason:row.state === 'cancelled' ? 'order-cancel' as const : 'undo' as const})}));
    const summary = todayOverview(context,at+1000).summary;
    expect(summary.sales).toBe(records.filter(row => row.state === 'active').reduce((sum,row) => sum+row.amount,0));
    expect(summary.expectedCash).toBe(records.filter(row => row.state !== 'undone').reduce((sum,row) => sum+row.amount,0));
  }),{numRuns:80});
});
test('integer limits fail explicitly instead of rounding a drawer total',() => {
  const {context,sale} = fixture();context.sales = [{...sale('1'),amount:Number.MAX_SAFE_INTEGER},sale('1')];expect(() => todayOverview(context,at+1000)).toThrow(/supported/);
  expect(denominationTotal([{value:10000,count:3},{value:50,count:2}])).toBe(30100);
  for (const lines of [[{value:1,count:0.5}],[{value:1,count:-1}],[{value:0,count:1}],[{value:100,count:1},{value:100,count:2}],[{value:Number.MAX_SAFE_INTEGER,count:2}]]) expect(() => denominationTotal(lines)).toThrow();
});
test('a higher count records a real linked cash sale and undo reverses it beyond the counter window',() => {
  const {context,sale,input} = fixture();context.sales = [sale('100')];const change = closeDayCommand(input(12500,true),context,at+1000);
  expect(change.closing).toMatchObject({expectedCash:10000,countedCash:12500,difference:2500,addedWalkIn:2500,summary:{sales:12500,saleCount:2,expectedCash:12500}});
  expect(change.sale).toMatchObject({amount:2500,method:'cash',who:'Walk-in',closingId:change.closing.id});expect(canUndoSale(change.sale!,at+1001)).toBe(false);expect(() => undoSaleCommand(change.sale!,context.setup.owner.id,at+1001)).toThrow(/closing/);
  const undo = undoClosingCommand(change.closing,context.setup,change.sale,at+3600000);expect(undo.sale?.voidReason).toBe('undo');expect(undo.closing.activeKey).toBeUndefined();expect(undo.events.map(event => event.command)).toEqual(['sale.closing-undo','closing.undo']);
  expect(undo.events[1].undoOf).toBe(change.closing.eventId);expect(change.events.every(event => event.actor.id === context.setup.owner.id && event.closingId === change.closing.id)).toBe(true);
  expect(daySummaryText(change.closing)).toContain('Added as walk-in sales: ৳25');expect(daySummaryText(undo.closing)).toContain('Closing undone');
});
test('closing overages preserve minor units in every configured currency, including Indonesian decimal input',() => {
  for (const currency of ['BDT','INR','IDR','KES','USD','JPY','KWD']) {
    const {context,input} = fixture();context.setup = {...context.setup,outlet:{...context.setup.outlet,currency}};
    const change = closeDayCommand(input(12525,true),context,at+1000);expect(change.sale?.amount,currency).toBe(12525);expect(change.closing.summary.sales,currency).toBe(12525);
  }
});
test('a shortfall or unexplained surplus needs a note and never silently creates a sale',() => {
  const {context,sale,input} = fixture();context.sales = [sale('100')];
  expect(() => closeDayCommand(input(9000),context,at+1000)).toThrow(/note/);expect(() => closeDayCommand(input(11000),context,at+1000)).toThrow(/note/);
  const short = closeDayCommand(input(9000,false,'Till short; checking receipts.'),context,at+1000);expect(short.sale).toBeUndefined();expect(short.closing.difference).toBe(-1000);
  expect(() => closeDayCommand(input(9000,true,'Test'),context,at+1000)).toThrow(/extra cash/);expect(() => closeDayCommand(input(-1),context,at+1000)).toThrow(/non-negative/);
  expect(closeDayCommand(input(10000),context,at+1000).closing.difference).toBe(0);
});
test('reviewed totals, day changes, already closed days and altered linked receipts are rejected',() => {
  const {context,sale,input} = fixture(), stale = input(0);context.sales.push(sale('1'));expect(() => closeDayCommand(stale,context,at+1000)).toThrow(/changed/);
  const ready = input(100), change = closeDayCommand(ready,context,at+1000);context.closings.push(change.closing);expect(() => closeDayCommand({...ready,id:newClosingId(at)},context,at+1000)).toThrow(/already closed/);
  expect(canUndoClosing(change.closing,Date.UTC(2026,10,15,17,59,59))).toBe(true);expect(canUndoClosing(change.closing,Date.UTC(2026,10,15,18))).toBe(false);
  expect(canUndoClosing(change.closing,at+86400000)).toBe(false);expect(() => undoClosingCommand(change.closing,context.setup,undefined,at+86400000)).toThrow(/same shop day/);
  expect(() => closeDayCommand(ready,{...context,closings:[]},at+86400000)).toThrow(/changed/);
  const over = closeDayCommand(input(200,true),{...context,closings:[]},at+1000);expect(() => undoClosingCommand(over.closing,context.setup,{...over.sale!,amount:101},at+2000)).toThrow(/changed/);
});
test('a previous-day refund affects cash movement without reducing today’s sales a second time',() => {
  const {context,sale} = fixture();context.sales = [{...sale('50','cash',at-86400000),voidedAt:at,voidReason:'order-cancel'},sale('10')];
  const refund:OrderRefund = {id:'old-order-refund',outletId:context.setup.outlet.id,orderId:'old',saleId:context.sales[0].id,amount:2500,currency:'BDT',method:'cash',methodName:'Cash',note:'',createdBy:context.setup.owner.id,eventId:'refund-event',createdAt:at,updatedAt:at};
  context.refunds = [refund,{...refund,id:'undone',voidedAt:at},{...refund,id:'foreign',outletId:'other'},{...refund,id:'wallet',method:'wallet',methodName:'bKash'}];
  expect(todayOverview(context,at+1000).summary).toMatchObject({sales:1000,cashSales:1000,cashRefunds:2500,expectedCash:-1500});
});
