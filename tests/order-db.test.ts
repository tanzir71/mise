import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { orderFixture } from './order-fixture';
import { setupCommand } from '../packages/core/setup';
import { saveCustomerCommand } from '../packages/core/customers';
import { creditBalance, defaultCreditTerms, openingBalanceCommand, saveCreditTermsCommand } from '../packages/core/khata';
import { profile } from './credit-fixture';

const databases: MiseDatabase[] = [], shop={businessType:'corner_shop',marketCode:'BD',name:'Order test',phone:'01712345482'} as const;
async function boot() { const db=new MiseDatabase(`mise-orders-${randomUUID()}`); databases.push(db); await db.saveSetup(shop); return db; }
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });

test('concurrent creates allocate unique outlet numbers and persist after reopen', async () => {
  const db=await boot(), {input}=orderFixture();
  const orders=await Promise.all(Array.from({length:12},() => db.saveOrder(input)));
  expect(new Set(orders.map(order=>order.number)).size).toBe(12); expect(orders.map(order=>order.sequence).sort((a,b)=>a-b)).toEqual(Array.from({length:12},(_,i)=>i+1));
  db.close(); await db.open(); expect(await db.orders.count()).toBe(12);
  expect(await db.events.where('command').equals('order.create').count()).toBe(12);
  for (const order of orders) expect(await db.events.get(order.eventId)).toMatchObject({orderId:order.id,orderRevision:1,actor:{type:'member'},after:order});
});

test('a stale edit/status cannot overwrite another tab’s saved command', async () => {
  const db=await boot(), {input}=orderFixture(), order=await db.saveOrder(input);
  const writes=await Promise.allSettled([db.changeOrderStatus(order.id,'priced',1),db.saveOrder({...input,name:'Changed'},{id:order.id,revision:1})]);
  expect(writes.filter(result=>result.status==='fulfilled')).toHaveLength(1); expect(writes.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect((await db.orders.get(order.id))?.revision).toBe(2);
  await expect(db.changeOrderStatus(order.id,'accepted',1)).rejects.toThrow(/changed/);
  expect(await db.events.where('orderId').equals(order.id).count()).toBe(2);
});

test('status undo keeps subsequent notes and communication and is available only once', async () => {
  const db=await boot(), {input}=orderFixture(); let order=await db.saveOrder(input);
  order=await db.changeOrderStatus(order.id,'priced',order.revision);
  await db.addOrderNote(order.id,'Use the side door.',order.revision);
  await db.recordOrderCommunication(order.id,{purpose:'quote',channel:'manual',text:'Owner sent the price.'},3);
  order=await db.undoOrderStatus(order.id,4); expect(order).toMatchObject({status:'requested',revision:5});
  expect(await db.orderNotes.where('orderId').equals(order.id).count()).toBe(1); expect(await db.orderCommunications.where('orderId').equals(order.id).count()).toBe(1);
  await expect(db.undoOrderStatus(order.id,5)).rejects.toThrow(/last status/);
  const event=await db.events.get(order.eventId); expect(event?.undoOf).toBeTruthy(); expect(event?.orderRevision).toBe(5);
});

test('audit failures roll back creation, numbering, status, notes and communications', async () => {
  const db=await boot(), {input}=orderFixture(); let fail='order.create';
  db.events.hook('creating',(_key,event)=>{if(event.command===fail) throw new Error('Audit blocked');});
  await expect(db.saveOrder(input)).rejects.toThrow('Audit blocked'); expect(await db.orders.count()).toBe(0);
  fail=''; const order=await db.saveOrder(input); expect(order.number).toBe('A-0001');
  const events=await db.events.count(); fail='order.status'; await expect(db.changeOrderStatus(order.id,'priced',1)).rejects.toThrow('Audit blocked');
  fail='order.note'; await expect(db.addOrderNote(order.id,'Call me',1)).rejects.toThrow('Audit blocked');
  fail='order.quote-sent'; await expect(db.recordOrderCommunication(order.id,{purpose:'quote',channel:'manual',text:'Price'},1)).rejects.toThrow('Audit blocked');
  expect((await db.orders.get(order.id))?.revision).toBe(1); expect(await db.orderNotes.count()).toBe(0); expect(await db.orderCommunications.count()).toBe(0); expect(await db.events.count()).toBe(events);
});

test('warning settings survive a general profile save and rejected actions leave no journal entries', async () => {
  const db=await boot(), {input}=orderFixture(); await db.saveOrderWarning(25); await db.saveSetup({...shop,name:'Renamed'});
  expect((await db.setup())?.outlet.orderWarningMinutes).toBe(25);
  const before=await db.events.count(), order=await db.saveOrder({...input,lines:[{...input.lines[0],unitPrice:null}]});
  await expect(db.changeOrderStatus(order.id,'priced',1)).rejects.toThrow(/Price/); await expect(db.saveOrderWarning(-1)).rejects.toThrow();
  await expect(db.saveOrder(input,{id:'missing',revision:1})).rejects.toThrow(/not found/);
  expect(await db.events.count()).toBe(before+1);
});

test('version 3 credit data upgrades additively to orders without losing its balances or audit records', async () => {
  const name=`mise-v3-${randomUUID()}`, legacy=new Dexie(name);
  legacy.version(3).stores({businesses:'id',outlets:'id,businessId',members:'id,businessId',categories:'id,outletId',items:'id,outletId,categoryId',events:'id,outletId,at,command,customerId',sales:'id,outletId,createdAt',customers:'id,businessId,phone,&[businessId+phone]',creditAccounts:'id,outletId,customerId,&[outletId+customerId+currency]',creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,&reversalOf,&[accountId+sequence]'});
  const seeded=setupCommand(shop), setup=seeded.snapshot;
  const customer=saveCustomerCommand(profile,setup,[]), terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:10000},customer.customer,setup);
  const opening=openingBalanceCommand(1200,Date.now()-86400000,{setup,customer:customer.customer,account:terms.account,entries:[]});
  await legacy.table('businesses').put(setup.business); await legacy.table('outlets').put(setup.outlet); await legacy.table('members').put(setup.owner); await legacy.table('items').bulkPut(seeded.items); await legacy.table('categories').bulkPut(seeded.categories);
  await legacy.table('customers').put(customer.customer); await legacy.table('creditAccounts').put(terms.account); await legacy.table('creditEntries').put(opening.entry); await legacy.table('events').bulkPut([seeded.event,customer.event,terms.event,opening.event]); legacy.close();
  const db=new MiseDatabase(name); databases.push(db); await db.open();
  expect(db.verno).toBe(7); expect(await db.items.count()).toBe(3); expect(await db.events.count()).toBe(4);
  const ledger=await db.readCreditLedger(terms.account.id); expect(creditBalance(ledger.account,ledger.entries)).toBe(1200); expect(ledger.customer.phone).toBe('+8801712345482');
  expect(await db.orders.count()).toBe(0); const order=await db.saveOrder(orderFixture().input); expect(order.number).toBe('A-0001'); expect(await db.events.where('customerId').equals(customer.customer.id).count()).toBe(3);
});
