import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { closingPreview, todayOverview } from '../packages/core/today';
import { newClosingId } from '../packages/core/closing';
import { defaultCreditTerms } from '../packages/core/khata';
import { orderFixture } from './order-fixture';
import { stockInput } from './stock-fixture';

const at = Date.UTC(2026,10,16,6), databases:MiseDatabase[] = [];
const shop = {businessType:'corner_shop',marketCode:'BD',name:'Closing test',phone:'01712345482'} as const;
beforeEach(() => {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async () => {await Promise.all(databases.splice(0).map(db => db.delete()));vi.useRealTimers();});
async function boot() {const db = new MiseDatabase(`mise-closing-${randomUUID()}`);databases.push(db);await db.saveSetup(shop);return db;}
async function review(db:MiseDatabase,countedCash:number,addDifference = false,note = '') {
  const preview = closingPreview(await db.readToday());return {id:newClosingId(),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash,addDifference,note};
}
test('double Save is idempotent, a competing review closes once, and history survives reopening',async () => {
  const db = await boot();await db.recordSale({expression:'100',method:'cash'});const input = await review(db,12500,true);
  const result = await Promise.all([db.closeDay(input),db.closeDay(input)]);expect(result[0]).toEqual(result[1]);expect(await db.dayClosings.count()).toBe(1);expect(await db.sales.count()).toBe(2);
  expect(await db.events.where('command').equals('closing.record').count()).toBe(1);expect((await db.readToday()).closings[0].summary.sales).toBe(12500);
  await expect(db.closeDay({...input,note:'Changed after save'})).rejects.toThrow(/changed/);
  await expect(db.closeDay(await review(db,12500))).rejects.toThrow(/already closed/);
  db.close();await db.open();expect(await db.dayClosings.get(result[0].id)).toEqual(result[0]);expect(todayOverview(await db.readToday()).summary.expectedCash).toBe(12500);
});
test('concurrent independent reviews cannot create two closings or two overage receipts',async () => {
  const db = await boot(), first = await review(db,1000,true), second = {...first,id:newClosingId()};
  const results = await Promise.allSettled([db.closeDay(first),db.closeDay(second)]);expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);expect(await db.dayClosings.count()).toBe(1);expect(await db.sales.count()).toBe(1);
});
test('a new sale invalidates a frozen review without leaving an extra receipt or closing',async () => {
  const db = await boot(), input = await review(db,5000,true);await db.recordSale({expression:'10',method:'cash'});const events = await db.events.count();
  await expect(db.closeDay(input)).rejects.toThrow(/changed/);expect(await db.sales.count()).toBe(1);expect(await db.dayClosings.count()).toBe(0);expect(await db.events.count()).toBe(events);
});
test('audit failure rolls back the closing, linked sale and both undo records atomically',async () => {
  const db = await boot(), input = await review(db,5000,true);let fail = 'closing.record';
  db.events.hook('creating',(_key,event) => {if (event.command === fail) throw new Error('Audit denied');});
  await expect(db.closeDay(input)).rejects.toThrow('Audit denied');expect(await db.sales.count()).toBe(0);expect(await db.dayClosings.count()).toBe(0);expect(await db.events.count()).toBe(1);
  fail = '';const closing = await db.closeDay(input), events = await db.events.count();fail = 'closing.undo';
  await expect(db.undoDayClosing(closing.id)).rejects.toThrow('Audit denied');expect((await db.dayClosings.get(closing.id))?.voidedAt).toBeUndefined();expect((await db.sales.get(closing.addedSaleId!))?.voidedAt).toBeUndefined();expect(await db.events.count()).toBe(events);
});
test('same-day undo owns its receipt, retains later sales, frees the closing slot and cannot repeat',async () => {
  const db = await boot();await db.recordSale({expression:'100',method:'cash'});const input = await review(db,12500,true), closing = await db.closeDay(input);
  await expect(db.undoSale(closing.addedSaleId!)).rejects.toThrow(/closing/);vi.setSystemTime(at+3600000);const later = await db.recordSale({expression:'50',method:'cash'});
  expect((await db.dayClosings.get(closing.id))?.summary.sales).toBe(12500);
  await db.undoDayClosing(closing.id);expect((await db.sales.get(later.id))?.voidedAt).toBeUndefined();expect(todayOverview(await db.readToday()).summary.expectedCash).toBe(15000);
  await expect(db.undoDayClosing(closing.id)).rejects.toThrow(/once/);await expect(db.closeDay(input)).rejects.toThrow(/changed/);
  const next = await db.closeDay(await review(db,14000,false,'Short by ten.'));expect(next.difference).toBe(-1000);expect(await db.dayClosings.count()).toBe(2);
  vi.setSystemTime(at+86400000);await expect(db.undoDayClosing(next.id)).rejects.toThrow(/same shop day/);
});
test('Today reconciles real cash cancellations and credit payments/refunds without subtracting refunds twice',async () => {
  const db = await boot(), customer = await db.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'Road 12',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}}), account = (await db.creditAccounts.toArray())[0], input = {...orderFixture().input,customerId:customer.id,phone:customer.phone!};
  const cash = await db.saveOrder(input,{settlement:{method:'cash'}});await db.changeOrderStatus(cash.id,'cancelled',cash.revision);await db.refundOrder(cash.id,{amount:1000,method:'cash'},cash.revision+1);
  const credit = await db.saveOrder(input,{settlement:{method:'credit',accountId:account.id}});await db.recordCreditPayment(account.id,2500,'cash');await db.changeOrderStatus(credit.id,'cancelled',credit.revision);await db.refundOrder(credit.id,{amount:500,method:'cash'},credit.revision+1);
  // 25 retained cash + 25 cash collected - 10 cash refund - 5 credit refund = 35 in the drawer.
  expect(todayOverview(await db.readToday()).summary).toMatchObject({sales:0,saleCount:0,orderCount:0,creditGiven:0,creditCollected:2000,cashSales:2500,cashCollections:2500,cashRefunds:1500,expectedCash:3500});
  const closing = await db.closeDay(await review(db,3500));expect(closing.summary.expectedCash).toBe(3500);expect(await db.sales.count()).toBe(2);
});
test('schema 6 financial, stock, supplier and audit records survive the additive closing migration unchanged',async () => {
  const source = await boot();await source.recordSale({expression:'50',method:'cash'});
  const supplier = await source.saveSupplier({name:'Fresh',phone:'01712345482',note:'Before noon'});await source.saveStockItem({...stockInput,supplierId:supplier.id});
  const customer = await source.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}}), account = (await source.creditAccounts.toArray())[0];
  const order = await source.saveOrder({...orderFixture().input,customerId:customer.id,phone:customer.phone!},{settlement:{method:'credit',accountId:account.id}});await source.addOrderNote(order.id,'Keep the full note',order.revision);await source.recordCreditPayment(account.id,500,'cash');
  const records:Record<string,unknown[]> = {}, stores:Record<string,string> = {};
  for (const table of source.tables.filter(table => table.name !== 'dayClosings' && table.name !== 'purchases')) {stores[table.name] = [table.schema.primKey.src,...table.schema.indexes.filter(index => index.name !== 'closingId').map(index => index.src)].join(',');records[table.name] = await table.toArray();}
  const name = `mise-closing-v6-${randomUUID()}`, legacy = new Dexie(name);legacy.version(6).stores(stores);
  for (const table of Object.keys(stores)) await legacy.table(table).bulkPut(records[table]);legacy.close();
  const db = new MiseDatabase(name);databases.push(db);await db.open();expect(db.verno).toBe(13);expect(await db.dayClosings.count()).toBe(0);
  for (const table of Object.keys(stores)) expect(await db.table(table).toArray(),table).toEqual(records[table]);
  expect(todayOverview(await db.readToday()).summary).toMatchObject({sales:7500,creditGiven:2500,creditCollected:500,expectedCash:5500});
  await db.closeDay(await review(db,5500));expect(await db.stockItems.toArray()).toEqual(records.stockItems);expect(await db.creditEntries.toArray()).toEqual(records.creditEntries);expect(await db.orders.toArray()).toEqual(records.orders);
});
