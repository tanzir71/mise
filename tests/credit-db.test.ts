import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { defaultCreditTerms, creditBalance } from '../packages/core/khata';
import { defaultCreditMessaging } from '../packages/core/khata-messages';
import { setupCommand } from '../packages/core/setup';
import { recordSaleCommand } from '../packages/core/sales';
import { profile } from './credit-fixture';

const databases: MiseDatabase[] = [], shop = {businessType:'corner_shop',marketCode:'BD',name:'Credit test',phone:'01712345482'} as const;
const terms = {...defaultCreditTerms,allowed:true,limit:15000};
async function boot() { const db = new MiseDatabase(`mise-credit-test-${randomUUID()}`); databases.push(db); await db.saveSetup(shop); return db; }
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });
async function person(db: MiseDatabase) { const customer = await db.saveCustomer(profile,{credit:terms}); const account = (await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0]; return {customer,account}; }

test('customer/profile updates, terms, opening balances and messaging persist with audit history', async () => {
  const db = await boot(), customer = await db.saveCustomer(profile,{credit:terms,opening:{amount:10000,occurredAt:Date.now()-40*86400000}});
  const account = (await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0];
  await db.saveCustomer({...profile,notes:'Pays after market day',tags:['regular']},{id:customer.id});
  const wording = structuredClone(defaultCreditMessaging); wording.paymentNote = 'Pay at the shop'; await db.saveCreditMessaging(wording);
  await db.saveSetup({...shop,name:'Renamed shop'}); db.close(); await db.open();
  expect(await db.customers.get(customer.id)).toMatchObject({notes:'Pays after market day',tags:['regular'],phone:'+8801712345482'});
  const ledger = await db.readCreditLedger(account.id); expect(creditBalance(account,ledger.entries)).toBe(10000);
  expect(ledger.entries[0]).toMatchObject({type:'adjustment',note:'Opening balance',sequence:1});
  expect((await db.setup())?.outlet.creditMessaging?.paymentNote).toBe('Pay at the shop');
  expect(await db.events.where('customerId').equals(customer.id).count()).toBe(4);
  await expect(db.archiveCustomer(customer.id)).rejects.toThrow(/Settle/);
});
test('concurrent charges and payments recheck the current limit/balance inside their transactions', async () => {
  const db = await boot(), {customer,account} = await person(db);
  const input = {expression:'100',customerId:customer.id,accountId:account.id};
  const charges = await Promise.allSettled([db.recordCreditSale(input),db.recordCreditSale(input)]);
  expect(charges.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await db.sales.count()).toBe(1); expect(await db.creditEntries.count()).toBe(1);
  const payments = await Promise.allSettled([db.recordCreditPayment(account.id,8000,'cash'),db.recordCreditPayment(account.id,8000,'cash')]);
  expect(payments.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const ledger = await db.readCreditLedger(account.id); expect(creditBalance(account,ledger.entries)).toBe(2000);
  expect(ledger.entries.map(entry => entry.sequence).sort()).toEqual([1,2]);
  expect(await db.events.where('command').equals('khata.payment').count()).toBe(1);
});
test('a stale Give anyway confirmation fails after another write changes the balance', async () => {
  const db = await boot(), {customer,account} = await person(db), input = {expression:'100',customerId:customer.id,accountId:account.id};
  await db.recordCreditSale(input);
  await db.recordCreditPayment(account.id,100,'cash');
  await expect(db.recordCreditSale({...input,confirmation:{balance:10000,limit:15000}})).rejects.toMatchObject({name:'CreditLimitError',balance:9900,limit:15000});
  expect(await db.sales.count()).toBe(1);
  await db.recordCreditSale({...input,confirmation:{balance:9900,limit:15000}});
  expect(creditBalance(account,(await db.readCreditLedger(account.id)).entries)).toBe(19900);
});
test('audit failure rolls back the sale, credit entry and every event in the compound command', async () => {
  const db = await boot(), {customer,account} = await person(db), before = await db.events.count();
  db.events.hook('creating',(_key,event) => { if (event.command === 'khata.charge') throw new Error('Credit audit failed'); });
  await expect(db.recordCreditSale({expression:'100',customerId:customer.id,accountId:account.id})).rejects.toThrow('Credit audit failed');
  expect(await db.sales.count()).toBe(0); expect(await db.creditEntries.count()).toBe(0); expect(await db.events.count()).toBe(before);
});
test('invalid opening balances roll back new customers, accounts and their events', async () => {
  const db = await boot(), count = await db.events.count();
  await expect(db.saveCustomer(profile,{opening:{amount:100,occurredAt:Date.now()+86400000}})).rejects.toThrow(/date/);
  expect(await db.customers.count()).toBe(0); expect(await db.creditAccounts.count()).toBe(0); expect(await db.events.count()).toBe(count);
  await db.saveCustomer({...profile,phone:''}); await db.saveCustomer({...profile,name:'Someone else',phone:''});
  expect(await db.customers.count()).toBe(2);
});
test('credit sale undo reverses the debt once and refuses to erase a partly repaid charge', async () => {
  const db = await boot(), {customer,account} = await person(db);
  const sale = await db.recordCreditSale({expression:'100',customerId:customer.id,accountId:account.id});
  const paid = await db.recordCreditPayment(account.id,4000,'cash');
  await expect(db.undoSale(sale.id)).rejects.toThrow(/partly paid/); expect((await db.sales.get(sale.id))?.voidedAt).toBeUndefined();
  await db.undoCreditEntry(paid.id);
  const reversed = await Promise.allSettled([db.undoSale(sale.id),db.undoSale(sale.id)]);
  expect(reversed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const ledger = await db.readCreditLedger(account.id); expect(creditBalance(account,ledger.entries)).toBe(0); expect(ledger.entries).toHaveLength(4);
  expect((await db.sales.get(sale.id))?.voidedAt).toBeDefined(); expect(await db.events.where('command').equals('sale.undo').count()).toBe(1);
  expect(await db.events.where('command').equals('khata.undo').count()).toBe(2);
});
test('paid-up removal archives a customer; restoring retains the same ledger and phone identity', async () => {
  const db = await boot(), {customer,account} = await person(db);
  await db.recordCreditSale({expression:'100',customerId:customer.id,accountId:account.id}); await db.recordCreditPayment(account.id,10000,'cash');
  await db.archiveCustomer(customer.id); expect((await db.customers.get(customer.id))?.archivedAt).toBeDefined();
  await expect(db.saveCustomer(profile)).rejects.toThrow(/already/);
  await expect(db.recordCreditSale({expression:'1',customerId:customer.id,accountId:account.id})).rejects.toThrow(/Restore/);
  await db.archiveCustomer(customer.id,false); expect((await db.customers.get(customer.id))?.archivedAt).toBeUndefined();
  expect(await db.creditEntries.where('accountId').equals(account.id).count()).toBe(2);
});
test('currency changes create separate accounts and never reinterpret existing debt', async () => {
  const db = await boot(), {customer,account} = await person(db);
  await db.recordCreditSale({expression:'100',customerId:customer.id,accountId:account.id});
  await db.saveSetup({...shop,currency:'USD'});
  await expect(db.recordCreditSale({expression:'1',customerId:customer.id,accountId:account.id})).rejects.toThrow(/currency/);
  const usd = await db.saveCreditTerms(customer.id,terms);
  await db.recordCreditSale({expression:'5',customerId:customer.id,accountId:usd.id});
  expect(creditBalance(account,(await db.readCreditLedger(account.id)).entries)).toBe(10000);
  expect(creditBalance(usd,(await db.readCreditLedger(usd.id)).entries)).toBe(500);
  expect(usd.currency).toBe('USD'); expect(await db.creditAccounts.count()).toBe(2);
});
test('completed communications write zero-value, attributable history and keep the balance', async () => {
  const db = await boot(), {customer,account} = await person(db);
  await db.recordCreditSale({expression:'100',customerId:customer.id,accountId:account.id});
  await db.recordCommunication(account.id,'reminder','Please pay at the shop.','manual');
  const ledger = await db.readCreditLedger(account.id), actor = (await db.setup())!.owner.id;
  expect(creditBalance(account,ledger.entries)).toBe(10000);
  expect(ledger.entries.find(entry => entry.type === 'reminder')).toMatchObject({amount:0,purpose:'reminder',createdBy:actor});
  expect(await db.events.where('customerId').equals(customer.id).filter(event => event.command === 'khata.reminder-sent' && event.actor.id === actor).count()).toBe(1);
});
test('upgrading version 2 preserves existing cash sales, profiles, catalogue and audit records', async () => {
  const name = `mise-credit-upgrade-${randomUUID()}`, legacy = new Dexie(name);
  legacy.version(1).stores({businesses:'id',outlets:'id,businessId',members:'id,businessId',categories:'id,outletId',items:'id,outletId,categoryId',events:'id,outletId,at,command'});
  legacy.version(2).stores({sales:'id,outletId,createdAt'});
  const setup = setupCommand(shop), sale = recordSaleCommand({expression:'75',method:'cash'},{setup:setup.snapshot,items:setup.items,wallets:['Cash']});
  await legacy.table('businesses').put(setup.snapshot.business); await legacy.table('outlets').put(setup.snapshot.outlet); await legacy.table('members').put(setup.snapshot.owner);
  await legacy.table('items').bulkPut(setup.items); await legacy.table('categories').bulkPut(setup.categories); await legacy.table('sales').put(sale.sale); await legacy.table('events').bulkAdd([setup.event,sale.event]); legacy.close();
  const upgraded = new MiseDatabase(name); databases.push(upgraded);
  expect((await upgraded.setup())?.business.name).toBe(shop.name); expect(await upgraded.items.count()).toBe(3);
  expect(await upgraded.sales.get(sale.sale.id)).toMatchObject({amount:7500,method:'cash'}); expect(await upgraded.events.count()).toBe(2);
  expect(await upgraded.customers.count()).toBe(0); expect(await upgraded.creditAccounts.count()).toBe(0); expect(await upgraded.creditEntries.count()).toBe(0);
});
