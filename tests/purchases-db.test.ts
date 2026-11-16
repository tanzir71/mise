import 'fake-indexeddb/auto';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MiseDatabase } from '../apps/web/src/data/db';
import { stockInput } from './stock-fixture';

const at = Date.UTC(2026,10,16,6),databases:MiseDatabase[] = [];
const input = {supplierName:'Fresh supplier',reference:'INV-1',lines:[{name:'Chicken',unit:'kg',qty:2.5,unitPrice:12001}],paid:'due',note:'দাম নিশ্চিত'} as const;
beforeEach(() => {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async () => {await Promise.all(databases.splice(0).map(db => db.delete()));vi.useRealTimers();});
async function boot() {const db = new MiseDatabase(`mise-purchases-${randomUUID()}`);databases.push(db);await db.saveSetup({businessType:'corner_shop',marketCode:'BD',name:'Invoice shop',phone:'01712345482'});return db;}
const invoice = () => ({...input,lines:input.lines.map(line => ({...line}))});
test('priced invoices use exact line rounding and do not fabricate stock receipts or customer debt',async () => {
  const db = await boot(),supplier = await db.saveSupplier({name:'সবুজ',phone:'01712345483',note:''}),item = await db.saveStockItem(stockInput),before = await db.stockItems.get(item.id);
  const saved = await db.recordPurchase({...invoice(),supplierId:supplier.id,lines:[{...input.lines[0],stockItemId:item.id}],paid:'wallet',wallet:'bKash'});
  expect(saved).toMatchObject({total:30003,methodName:'bKash',supplierName:'সবুজ',currency:'BDT'});expect(await db.stockItems.get(item.id)).toEqual(before);expect(await db.stockMoves.count()).toBe(1);expect(await db.creditEntries.count()).toBe(0);
  db.close();await db.open();expect(await db.purchases.get(saved.id)).toEqual(saved);expect(await db.events.where('command').equals('purchase.record').count()).toBe(1);
});
test('purchase creation and undo roll back when their final audit cannot be written',async () => {
  const db = await boot();let fail = 'purchase.record';db.events.hook('creating',(_key,event) => {if (event.command===fail) throw new Error('Audit failed');});
  await expect(db.recordPurchase(invoice())).rejects.toThrow('Audit failed');expect(await db.purchases.count()).toBe(0);
  fail = '';const saved = await db.recordPurchase(invoice());fail = 'purchase.undo';await expect(db.undoPurchase(saved.id)).rejects.toThrow('Audit failed');expect((await db.purchases.get(saved.id))?.voidedAt).toBeUndefined();
});
test('undo applies once within ten minutes and retains the invoice and its original audit',async () => {
  const db = await boot(),saved = await db.recordPurchase(invoice());await db.undoPurchase(saved.id);await expect(db.undoPurchase(saved.id)).rejects.toThrow(/once/);
  expect((await db.purchases.get(saved.id))?.voidedAt).toBe(at);expect(await db.events.where('command').startsWith('purchase.').count()).toBe(2);
  const later = await db.recordPurchase(invoice());vi.setSystemTime(at+600001);await expect(db.undoPurchase(later.id)).rejects.toThrow(/ten minutes/);
});
test('unpriced, negative, overflowing and incompatible stock invoice lines are rejected atomically',async () => {
  const db = await boot(),item = await db.saveStockItem(stockInput);
  for (const value of [{...invoice(),lines:[]},{...invoice(),lines:[{...input.lines[0],unitPrice:-1}]},{...invoice(),lines:[{...input.lines[0],qty:2,unitPrice:Number.MAX_SAFE_INTEGER}]},{...invoice(),lines:[{...input.lines[0],stockItemId:item.id,unit:'L'}]},{...invoice(),paid:'wallet' as const,wallet:'Unknown'}]) await expect(db.recordPurchase(value)).rejects.toThrow();
  expect(await db.purchases.count()).toBe(0);expect(await db.events.where('command').equals('purchase.record').count()).toBe(0);
});
