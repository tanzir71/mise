import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { backupToken, createBackup, parseBackup } from '../packages/core/backup';
import { backupTableNames } from '../packages/core/backup-tables';
import { creditBalance, defaultCreditTerms } from '../packages/core/khata';
import { closingPreview, todayOverview } from '../packages/core/today';
import { newClosingId } from '../packages/core/closing';
import { newSupplierMessageId } from '../packages/core/supplier-drafts';
import { orderFixture } from './order-fixture';
import { stockInput } from './stock-fixture';
import {orderMessage} from '../packages/core/orderMessage';
import {publicOrderFixture} from './public-shop-fixture';

const at = Date.UTC(2026,10,16,6), databases:MiseDatabase[] = [];
const shop = {businessType:'corner_shop',marketCode:'BD',name:'মায়ের দোকান',phone:'01712345482'} as const;
beforeEach(() => {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async () => {await Promise.all(databases.splice(0).map(db => db.delete()));vi.useRealTimers();});
async function boot(setup = true) {const db = new MiseDatabase(`mise-backup-${randomUUID()}`);databases.push(db);if (setup) await db.saveSetup(shop);else await db.open();return db;}

test('complete M20 source messages beyond 4,000 characters save and restore without truncation',async()=>{
  const source=await boot(),sourceText='  \r\n'+orderMessage({...publicOrderFixture(),items:['x'.repeat(3900)]})+'\r\n  ';expect(sourceText.length).toBeGreaterThan(4000);
  const order=await source.saveOrder({...orderFixture().input,source:'paste',sourceText});expect(order.sourceText).toBe(sourceText);
  const backup=await source.readBackup(),target=await boot(false);await target.restoreBackup(backup,await target.previewRestore(backup));expect((await target.orders.get(order.id))?.sourceText).toBe(sourceText);
  const invalid=structuredClone(backup);invalid.tables.orders[0].sourceText='x'.repeat(12001);expect(()=>parseBackup(invalid)).toThrow(/12,000/);
  const before=await source.events.count();for(const invalid of ['x'.repeat(12001),123 as unknown as string])await expect(source.saveOrder({...orderFixture().input,sourceText:invalid})).rejects.toThrow(/field limits/);expect(await source.events.count()).toBe(before);
});
async function fullFixture() {
  const db = await boot();
  const customer = await db.saveCustomer({name:'রিনা',nickname:'Rina',phone:'01712345483',address:'Road 12',notes:'চিনি কম',tags:['regular']},{credit:{...defaultCreditTerms,allowed:true,limit:100000,reminder:{...defaultCreditTerms.reminder,enabled:true,dayOfMonth:31}},opening:{amount:10000,occurredAt:at-86400000}});
  const account = (await db.creditAccounts.toArray())[0];
  const deleted = await db.saveItem({name:'চা',nameLocal:'Tea',price:2500,unit:'cup',category:'Drinks',available:true,oftenBought:false});
  await db.recordSale({expression:'25',method:'cash',given:10000,items:[{itemId:deleted.id,unitPrice:2500,qty:1}]});await db.deleteItem(deleted.id);
  const undone = await db.recordSale({expression:'10',method:'cash'});await db.undoSale(undone.id);
  const creditSale = await db.recordCreditSale({expression:'75',customerId:customer.id,accountId:account.id});await db.undoSale(creditSale.id);
  const payment = await db.recordCreditPayment(account.id,5000,'cash');await db.undoCreditEntry(payment.id);
  await db.recordCommunication(account.id,'reminder','বাকি মনে করিয়ে দিচ্ছি','manual');
  const input = {...orderFixture().input,customerId:customer.id,phone:customer.phone!};
  let cash = await db.saveOrder(input,{settlement:{method:'cash'}});
  await db.addOrderNote(cash.id,'চা কম মিষ্টি',cash.revision);cash = (await db.orders.get(cash.id))!;
  await db.recordOrderCommunication(cash.id,{purpose:'message',channel:'manual',text:'Ready to collect'},cash.revision);cash = (await db.orders.get(cash.id))!;
  await db.changeOrderStatus(cash.id,'cancelled',cash.revision);cash = (await db.orders.get(cash.id))!;
  const cashRefund = await db.refundOrder(cash.id,{amount:1000,method:'cash'},cash.revision);await db.undoOrderRefund(cashRefund.id);
  cash = (await db.orders.get(cash.id))!;await db.refundOrder(cash.id,{amount:500,method:'cash'},cash.revision);
  let credit = await db.saveOrder(input,{settlement:{method:'credit',accountId:account.id}});
  const ledger = await db.readCreditLedger(account.id);await db.recordCreditPayment(account.id,creditBalance(ledger.account,ledger.entries),'cash');
  await db.changeOrderStatus(credit.id,'cancelled',credit.revision);credit = (await db.orders.get(credit.id))!;
  const refund = await db.refundOrder(credit.id,{amount:1000,method:'cash'},credit.revision);await db.undoOrderRefund(refund.id);
  credit = (await db.orders.get(credit.id))!;await db.refundOrder(credit.id,{amount:500,method:'cash'},credit.revision);
  const supplier = await db.saveSupplier({name:'সবুজ',phone:'01712345484',note:'Before noon'});
  let item = await db.saveStockItem({...stockInput,supplierId:supplier.id});
  await db.recordPurchase({supplierId:supplier.id,supplierName:supplier.name,reference:'INV-1',lines:[{stockItemId:item.id,name:item.name,unit:item.unit,qty:2.5,unitPrice:12000}],paid:'due',note:'অপরিশোধিত'});
  item = await db.adjustStock({id:item.id,revision:item.revision,reason:'used',quantity:1.125});
  const move = (await db.stockMoves.where('stockItemId').equals(item.id).toArray()).find(m => m.reason === 'used')!;await db.undoStockMove(move.id,item.revision);
  item = (await db.stockItems.get(item.id))!;await db.applyStockBatch([{id:item.id,revision:item.revision,reason:'count',quantity:18.5}],true);
  await db.recordSupplierMessage({id:newSupplierMessageId(),supplierId:supplier.id,supplierName:supplier.name,phone:supplier.phone,text:'Please send 15 kg',channel:'manual',stockItemIds:[item.id],part:1,parts:1});
  const review = closingPreview(await db.readToday());
  const closing = await db.closeDay({id:newClosingId(),day:review.summary.day,fingerprint:review.fingerprint,countedCash:review.summary.expectedCash+1000,addDifference:true,note:'দোকান বন্ধ'});await db.undoDayClosing(closing.id);
  const next = closingPreview(await db.readToday());await db.closeDay({id:newClosingId(),day:next.summary.day,fingerprint:next.fingerprint,countedCash:next.summary.expectedCash,addDifference:false,note:'গণনা ঠিক'});
  return {db,customer,account,item};
}

test('all twenty tables round-trip into a fresh database with exact records and totals, including Bengali and undo history',async () => {
  const {db:source,account} = await fullFixture(), backup = await source.readBackup();
  expect(backup.schemaVersion).toBe(8);expect(backupTableNames).toHaveLength(20);
  for (const table of backupTableNames) expect(backup.tables[table].length,table).toBeGreaterThan(0);
  expect(JSON.stringify(backup)).toContain('চা কম মিষ্টি');expect(parseBackup(`\uFEFF${JSON.stringify(backup)}`)).toEqual(backup);
  const target = await boot(false), encoded = JSON.stringify(backup), preview = await target.previewRestore(encoded);
  expect(preview).toMatchObject({shopName:shop.name,replacesShopName:null,currency:'BDT',counts:{dayClosings:2,orderNotes:1}});
  const setup = await target.restoreBackup(encoded,preview);expect(setup.business.name).toBe(shop.name);
  target.close();await target.open();const restored = await target.readBackup();
  for (const table of backupTableNames.filter(t => t !== 'events')) expect(restored.tables[table],table).toEqual(backup.tables[table]);
  expect(restored.tables.events.filter(e => e.command !== 'backup.restore')).toEqual(backup.tables.events);
  expect(restored.tables.events.find(e => e.command === 'backup.restore')).toMatchObject({actor:{type:'system',id:'local-backup-restore'},at,after:{sourceExportedAt:at,schemaVersion:8}});
  expect(todayOverview(await target.readToday())).toEqual(todayOverview(await source.readToday()));
  const original = await source.readCreditLedger(account.id), copy = await target.readCreditLedger(account.id);
  expect(creditBalance(copy.account,copy.entries)).toBe(creditBalance(original.account,original.entries));
  expect(await target.stockMoves.toArray()).toEqual(await source.stockMoves.toArray());
  expect(parseBackup(JSON.stringify(restored))).toEqual(restored);
});

test('restore replaces the existing shop, does not merge unrelated records, and records who requested replacement',async () => {
  const source = await boot(), target = await boot();await target.saveSetup({...shop,name:'Old shop'});const old = await target.setup();
  await target.recordSale({expression:'123',method:'cash'});const backup = await source.readBackup(), review = await target.previewRestore(backup);
  expect(review.replacesShopName).toBe('Old shop');await target.restoreBackup(backup,review);
  expect(await target.sales.count()).toBe(0);expect(await target.businesses.count()).toBe(1);expect((await target.setup())?.business.id).toBe(backup.tables.businesses[0].id);
  expect((await target.events.where('command').equals('backup.restore').first())?.before).toMatchObject({shopName:'Old shop',requestedBy:{id:old!.owner.id},counts:{sales:1}});
});

test('backup capture ignores key and row order but detects a change hidden behind identical counts',async () => {
  const db = await boot(), source = await db.readBackup(), current = await db.readBackup();
  const reordered = JSON.parse(JSON.stringify(source));reordered.exportedAt += 1;reordered.tables.items.reverse();
  reordered.tables.businesses[0] = Object.fromEntries(Object.entries(reordered.tables.businesses[0]).reverse());
  expect(backupToken(reordered)).toBe(backupToken(source));
  const review = await db.previewRestore(source), item = current.tables.items[0];await db.items.update(item.id,{price:item.price+100});
  await expect(db.restoreBackup(source,review)).rejects.toThrow(/data changed/);expect((await db.items.get(item.id))?.price).toBe(item.price+100);
  expect(await db.events.where('command').equals('backup.restore').count()).toBe(0);
});

test('a mutated source requires another preview; two simultaneous confirmations restore only once',async () => {
  const source = await boot(), target = await boot(false), backup = await source.readBackup(), review = await target.previewRestore(backup);
  const changed = structuredClone(backup);changed.tables.businesses[0].name = 'Changed file';
  await expect(target.restoreBackup(changed,review)).rejects.toThrow(/selected backup changed/);expect(await target.businesses.count()).toBe(0);
  await expect(target.restoreBackup({...backup,exportedAt:backup.exportedAt+1},review)).rejects.toThrow(/selected backup changed/);
  const results = await Promise.allSettled([target.restoreBackup(backup,review),target.restoreBackup(backup,review)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);expect(await target.events.where('command').equals('backup.restore').count()).toBe(1);
});

test('an audit failure after clearing and writing imported tables rolls back the entire replacement',async () => {
  const {db:source} = await fullFixture(), target = await boot();await target.saveSetup({...shop,name:'Keep this shop'});await target.recordSale({expression:'42',method:'cash'});
  const before = await target.readBackup(), backup = await source.readBackup(), review = await target.previewRestore(backup);
  target.events.hook('creating',(_key,event) => {if (event.command === 'backup.restore') throw new Error('Audit storage failed');});
  await expect(target.restoreBackup(backup,review)).rejects.toThrow('Audit storage failed');
  expect(backupToken(await target.readBackup())).toBe(backupToken(before));
});

test('unsupported tables, schema versions, fractional money, broken links and duplicate IDs fail before any write',async () => {
  const {db:source} = await fullFixture(), target = await boot(), original = await source.readBackup(), before = backupToken(await target.readBackup());
  const mutations:((v:typeof original) => void)[] = [
    b => {b.schemaVersion = 99 as 8;},b => {delete (b.tables as Partial<typeof b.tables>).orderRefunds;},
    b => {Object.assign(b.tables,{futureTable:[]});},b => {b.tables.sales[0].amount = 25.5;},b => {b.tables.sales[0].amount = Number.MAX_SAFE_INTEGER+1;},
    b => {b.tables.stockItems[0].onHand = -1;},b => {b.tables.creditEntries[0].accountId = newClosingId();},
    b => {b.tables.items.push({...b.tables.items[0]});},b => {b.tables.customers[0].phone = '01712345483';},
    b => {b.tables.stockMoves[0].delta += 1;},b => {b.tables.dayClosings[0].difference += 1;},
    b => {b.tables.creditEntries[0].currency = 'USD';},b => {b.tables.businesses[0].id = 'not-an-id';},
    b => {Object.assign(b.tables.orders[0],{unrecognisedField:'discarded data?'});},b => {b.tables.stockItems[0].supplierId = newClosingId();},
  ];
  for (const mutate of mutations) {const bad = structuredClone(original);mutate(bad);await expect(target.previewRestore(JSON.stringify(bad))).rejects.toThrow();expect(backupToken(await target.readBackup())).toBe(before);}
});

test('compound uniqueness and corrupt reversal records are caught by the dry run',async () => {
  const {db} = await fullFixture(), source = await db.readBackup();
  const account = structuredClone(source);account.tables.creditAccounts.push({...account.tables.creditAccounts[0],id:newClosingId()});expect(() => parseBackup(account)).toThrow(/duplicate/);
  const entries = structuredClone(source);entries.tables.creditEntries[1].sequence = entries.tables.creditEntries[0].sequence;expect(() => parseBackup(entries)).toThrow(/duplicate/);
  const reversed = structuredClone(source), undo = reversed.tables.creditEntries.find(e => e.reversalOf)!;undo.amount += 1;expect(() => parseBackup(reversed)).toThrow(/reversal/);
  const event = structuredClone(source);event.tables.events[0].after = JSON.parse('{"__proto__":{"polluted":true}}');expect(() => parseBackup(JSON.stringify(event))).toThrow(/unsafe/);expect(({} as Record<string,unknown>).polluted).toBeUndefined();
});

test('an empty browser can be compared but an empty file cannot replace a configured shop',async () => {
  const empty = await boot(false), backup = await empty.readBackup();expect(Object.values(backup.tables).every(rows => rows.length === 0)).toBe(true);
  expect(createBackup(backup.tables)).toEqual(backup);await expect(empty.previewRestore(backup)).rejects.toThrow(/no shop/);
  expect(() => parseBackup('{bad')).toThrow(/valid JSON/);expect(() => parseBackup({format:'other'})).toThrow(/Mise JSON/);
});

test('market changes, archived contacts/stock and zero-total orders remain valid backup data',async () => {
  const db = await boot();
  const customer = await db.saveCustomer({name:'Old customer',nickname:'',phone:'01712345483',address:'',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:50000}});
  const account = (await db.creditAccounts.toArray())[0];await db.recordCreditSale({expression:'25',customerId:customer.id,accountId:account.id});await db.recordCreditPayment(account.id,2500,'cash');
  const order = await db.saveOrder({...orderFixture().input,lines:[{name:'Free sample',unit:'pc',qty:1,unitPrice:0}]},{settlement:{method:'cash'}});expect(order.payment.saleId).toBeUndefined();
  const supplier = await db.saveSupplier({name:'Old supplier',phone:'',note:''}), stock = await db.saveStockItem({...stockInput,supplierId:supplier.id});
  await db.archiveStockItem(stock.id,true,stock.revision);await db.archiveSupplier(supplier.id,true,supplier.revision);await db.archiveCustomer(customer.id,true);
  await db.saveSetup({...shop,marketCode:'OTHER',currency:'USD',timezone:'America/New_York',phone:'+12125550123'});await db.recordSale({expression:'10',method:'card'});
  const backup = await db.readBackup();expect(backup.tables.sales.map(s => s.currency).sort()).toEqual(['BDT','USD']);
  const target = await boot(false);await target.restoreBackup(backup,await target.previewRestore(backup));
  expect(todayOverview(await target.readToday())).toEqual(todayOverview(await db.readToday()));
  expect(await target.customers.toArray()).toEqual(await db.customers.toArray());expect(await target.stockItems.toArray()).toEqual(await db.stockItems.toArray());
});

test('schema 7 records and backup files upgrade to schema 8 with only an empty purchase table added',async () => {
  const {db:source} = await fullFixture(),records:Record<string,unknown[]> = {},stores:Record<string,string> = {};
  for (const table of source.tables.filter(t => t.name !== 'purchases')) {
    stores[table.name] = [table.schema.primKey.src,...table.schema.indexes.map(i => i.src)].join(',');
    records[table.name] = (await table.toArray()).filter(row => table.name !== 'events' || !row.command.startsWith('purchase.'));
  }
  const name = `mise-purchases-v7-${randomUUID()}`,legacy = new Dexie(name);legacy.version(7).stores(stores);
  for (const table of Object.keys(stores)) await legacy.table(table).bulkPut(records[table]);legacy.close();
  const upgraded = new MiseDatabase(name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(8);expect(await upgraded.purchases.count()).toBe(0);
  for (const table of Object.keys(stores)) expect(await upgraded.table(table).toArray(),table).toEqual(records[table]);
  const oldFile = {format:'mise-backup',formatVersion:1,schemaVersion:7,exportedAt:at,tables:records},target = await boot(false);
  const normalised = parseBackup(JSON.stringify(oldFile));expect(normalised.schemaVersion).toBe(8);expect(normalised.tables.purchases).toEqual([]);
  await target.restoreBackup(JSON.stringify(oldFile),await target.previewRestore(JSON.stringify(oldFile)));
  for (const table of Object.keys(stores).filter(t => t !== 'events')) expect(await target.table(table).toArray(),table).toEqual(JSON.parse(JSON.stringify(records[table])));
  expect(todayOverview(await target.readToday())).toEqual(todayOverview(await upgraded.readToday()));
});
