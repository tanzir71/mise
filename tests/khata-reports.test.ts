import { expect, test } from 'vitest';
import { chargeCreditCommand, recordCreditPaymentCommand, undoCreditEntryCommand, recordCommunicationCommand } from '../packages/core/khata';
import { creditOverview, khataTotals, filterCreditOverviews, marketWeekStart, civilDay } from '../packages/core/khata-reports';
import { at, creditFixture } from './credit-fixture';

test('FIFO ageing and the over-30 total include only the remaining older debt', () => {
  const {context} = creditFixture('BD',Date.UTC(2026,8,1));
  const old = Date.UTC(2026,9,1,6), recent = Date.UTC(2026,10,10,6);
  context.entries.push(chargeCreditCommand(10000,context,{},old).entry);
  context.entries.push(chargeCreditCommand(20000,context,{},recent).entry);
  context.entries.push(recordCreditPaymentCommand(5000,'cash',undefined,context,[],'',at-3600000).entry);
  const row = creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at);
  expect(row).toMatchObject({balance:25000,since:old,ageDays:45,over30Amount:5000,collectedThisWeek:5000,dueThisWeek:true,dueOn:'2026-11-02'});
  expect(khataTotals([row])).toEqual([{currency:'BDT',due:25000,people:1,collected:5000,over30:5000}]);
  expect(filterCreditOverviews([row],'over-30')).toHaveLength(1); expect(filterCreditOverviews([row],'paid-up')).toHaveLength(0);
});
test('undoing a payment restores ageing and removes the collection from weekly totals', () => {
  const {context} = creditFixture('BD',Date.UTC(2026,8,1)); const old = Date.UTC(2026,9,1,6);
  context.entries.push(chargeCreditCommand(10000,context,{},old).entry);
  const payment = recordCreditPaymentCommand(10000,'cash',undefined,context,[],'',at); context.entries.push(payment.entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at).collectedThisWeek).toBe(10000);
  context.entries.push(undoCreditEntryCommand(payment.entry,context,at+1).entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at+1)).toMatchObject({balance:10000,collectedThisWeek:0,ageDays:45});
});
test('receipt sharing does not complete a monthly reminder; an explicitly sent reminder does', () => {
  const {context} = creditFixture('BD',Date.UTC(2026,8,1)); context.entries.push(chargeCreditCommand(10000,context,{},Date.UTC(2026,9,1)).entry);
  context.entries.push(recordCommunicationCommand(context,'receipt','Receipt','whatsapp',at).entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at).dueThisWeek).toBe(true);
  context.entries.push(recordCommunicationCommand(context,'reminder','Reminder','manual',at+1).entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at+1).dueThisWeek).toBe(false);
});
test('new debt after the reminder day moves to next month and month-end dates clamp correctly', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(10000,context,{},at).entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at)).toMatchObject({dueThisWeek:false,dueOn:'2026-12-02'});
  context.account.reminder.dayOfMonth = 31;
  const feb = Date.UTC(2027,1,28,6); expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',feb)).toMatchObject({dueThisWeek:true,dueOn:'2027-02-28'});
});
test('civil days survive daylight saving and collection weeks follow market weekends', () => {
  expect(civilDay(Date.UTC(2026,2,9,4,15),'America/New_York')-civilDay(Date.UTC(2026,2,8,5,30),'America/New_York')).toBe(1);
  expect(marketWeekStart('BD')).toBe(0); expect(marketWeekStart('OTHER')).toBe(1);
  const {context} = creditFixture('BD',Date.UTC(2026,8,1)); context.entries.push(chargeCreditCommand(10000,context,{},Date.UTC(2026,9,1)).entry);
  context.entries.push(recordCreditPaymentCommand(5000,'cash',undefined,context,[],'',Date.UTC(2026,10,14,23)).entry);
  expect(creditOverview(context.account,context.entries,'Asia/Dhaka','BD',at).collectedThisWeek).toBe(5000);
});
test('totals keep currencies separate and filters order customers by remaining debt age', () => {
  const bd = creditFixture('BD',Date.UTC(2026,8,1)).context, intl = creditFixture('OTHER',Date.UTC(2026,8,1)).context;
  bd.entries.push(chargeCreditCommand(10000,bd,{},Date.UTC(2026,9,1)).entry); intl.entries.push(chargeCreditCommand(5000,intl,{},Date.UTC(2026,10,10)).entry);
  intl.account.limit = 1000;
  const rows = [creditOverview(intl.account,intl.entries,'UTC','OTHER',at),creditOverview(bd.account,bd.entries,'Asia/Dhaka','BD',at)];
  expect(filterCreditOverviews(rows,'all')[0].account.id).toBe(bd.account.id);
  expect(filterCreditOverviews(rows,'over-limit')[0].account.id).toBe(intl.account.id);
  expect(khataTotals(rows).map(row => [row.currency,row.due])).toEqual([['USD',5000],['BDT',10000]]);
});
