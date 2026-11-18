import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { stockInput } from './stock-fixture';
import { orderFixture } from './order-fixture';
import { defaultCreditTerms, creditBalance } from '../packages/core/khata';
import { newSupplierMessageId, supplierDrafts } from '../packages/core/supplier-drafts';
import { quickUpdate } from '../packages/core/quickUpdate';

const databases:MiseDatabase[] = [], shop = {businessType:'restaurant',marketCode:'BD',name:'Stock test',phone:'01712345482'} as const;
async function boot() {const db = new MiseDatabase(`mise-stock-${randomUUID()}`);databases.push(db);await db.saveSetup(shop);return db;}
afterEach(async () => {await Promise.all(databases.splice(0).map(db => db.delete()));});

test('opening counts, supplier assignment and audited movements persist after reopening',async () => {
  const db = await boot(), supplier = await db.saveSupplier({name:'Fresh',phone:'01712345482',note:'Before noon'}), item = await db.saveStockItem({...stockInput,supplierId:supplier.id});
  db.close();await db.open();expect(await db.stockItems.get(item.id)).toEqual(item);expect(await db.suppliers.get(supplier.id)).toEqual(supplier);
  const moves = await db.stockMoves.toArray();expect(moves).toHaveLength(1);expect(moves[0]).toMatchObject({stockItemId:item.id,reason:'count',after:20,createdBy:(await db.setup())!.owner.id});
  expect(await db.events.get(item.eventId)).toMatchObject({command:'stock.item-create',stockItemId:item.id,stockRevision:1,after:{item,move:moves[0]}});
});
test('concurrent stock creates and stale preview saves cannot overwrite or duplicate a movement',async () => {
  const db = await boot(), created = await Promise.allSettled([db.saveStockItem(stockInput),db.saveStockItem({...stockInput,name:' chicken '})]);expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const item = (await db.stockItems.toArray())[0], preview = quickUpdate('used 2 kg chicken',[item],item.outletId);
  const results = await Promise.allSettled([db.applyStockBatch(preview.changes),db.adjustStock({id:item.id,revision:1,reason:'received',quantity:5})]);expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);expect(await db.stockMoves.count()).toBe(2);expect((await db.stockItems.get(item.id))?.revision).toBe(2);
  await expect(db.applyStockBatch(preview.changes)).rejects.toThrow(/changed/);expect(await db.stockMoves.count()).toBe(2);
});
test('night counts are atomic, preserve skipped items and record zero as an actual physical count',async () => {
  const db = await boot(), first = await db.saveStockItem(stockInput), second = await db.saveStockItem({...stockInput,name:'Oil',unit:'L'}), skipped = await db.saveStockItem({...stockInput,name:'Eggs',unit:'pcs'}), before = await db.events.count();
  const inputs = [{id:first.id,revision:1,reason:'count' as const,quantity:18},{id:second.id,revision:1,reason:'count' as const,quantity:0}];
  await expect(db.applyStockBatch([inputs[0],{...inputs[1],revision:0}],true)).rejects.toThrow(/changed/);expect((await db.stockItems.get(first.id))?.onHand).toBe(20);expect(await db.events.count()).toBe(before);
  const saved = await db.applyStockBatch(inputs,true);expect(saved.map(item => item.onHand)).toEqual([18,0]);expect(await db.stockItems.get(skipped.id)).toEqual(skipped);
  const moves = (await db.stockMoves.toArray()).filter(move => move.source === 'count');expect(moves.map(move => move.delta).sort((a,b) => a-b)).toEqual([-20,-2]);expect(new Set(moves.map(move => move.countBatchId)).size).toBe(1);
  await db.applyStockBatch(saved.map(item => ({id:item.id,revision:item.revision,reason:'count',quantity:item.onHand})),true);expect((await db.stockMoves.toArray()).filter(move => move.source === 'count' && move.delta === 0)).toHaveLength(2);
});
test('audit-write failure rolls back items, multi-item counts, suppliers and sent records',async () => {
  const db = await boot();let fail = 'stock.item-create';db.events.hook('creating',(_key,event) => {if (event.command === fail) throw new Error('Audit blocked');});
  await expect(db.saveStockItem(stockInput)).rejects.toThrow('Audit blocked');expect(await db.stockItems.count()).toBe(0);expect(await db.stockMoves.count()).toBe(0);
  fail = '';const first = await db.saveStockItem(stockInput), second = await db.saveStockItem({...stockInput,name:'Oil'}), count = await db.events.count();fail = 'stock.count';
  await expect(db.applyStockBatch([first,second].map(item => ({id:item.id,revision:1,reason:'count',quantity:1})),true)).rejects.toThrow('Audit blocked');expect((await db.stockItems.toArray()).every(item => item.onHand === 20 && item.revision === 1)).toBe(true);expect(await db.stockMoves.count()).toBe(2);expect(await db.events.count()).toBe(count);
  fail = 'supplier.create';await expect(db.saveSupplier({name:'Fresh',phone:'',note:''})).rejects.toThrow('Audit blocked');expect(await db.suppliers.count()).toBe(0);
  fail = 'supplier.sent';await expect(db.recordSupplierMessage({id:newSupplierMessageId(),supplierName:'Manual',text:'Chicken 10kg',stockItemIds:[first.id],channel:'manual',part:1,parts:1})).rejects.toThrow('Audit blocked');expect(await db.supplierMessages.count()).toBe(0);
});
test('undo applies once under concurrency and a later physical count must be corrected first',async () => {
  const db = await boot(), item = await db.saveStockItem(stockInput);await db.adjustStock({id:item.id,revision:1,reason:'used',quantity:2});const used = (await db.stockMoves.toArray()).find(move => move.reason === 'used')!;
  await db.adjustStock({id:item.id,revision:2,reason:'count',quantity:17});await expect(db.undoStockMove(used.id,3)).rejects.toThrow(/physical count/);
  const count = (await db.stockMoves.toArray()).find(move => move.reason === 'count' && move.revision === 3)!;await db.undoStockMove(count.id,3);
  const results = await Promise.allSettled([db.undoStockMove(used.id,4),db.undoStockMove(used.id,4)]);expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);expect((await db.stockItems.get(item.id))?.onHand).toBe(20);expect(await db.stockMoves.where('undoOf').equals(used.id).count()).toBe(1);
});
test('archive/restore retains history, frees the active name and rejects stale supplier edits',async () => {
  const db = await boot(), item = await db.saveStockItem(stockInput);await db.archiveStockItem(item.id,true,1);expect(await db.stockMoves.count()).toBe(1);
  const replacement = await db.saveStockItem(stockInput);await expect(db.archiveStockItem(item.id,false,2)).rejects.toThrow(/already/);await db.archiveStockItem(replacement.id,true,1);await db.archiveStockItem(item.id,false,2);expect((await db.stockItems.get(item.id))?.onHand).toBe(20);
  const supplier = await db.saveSupplier({name:'Fresh',phone:'',note:''}), input = {name:'New name',phone:'',note:''};const results = await Promise.allSettled([db.saveSupplier(input,{id:supplier.id,revision:1}),db.archiveSupplier(supplier.id,true,1)]);expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);expect((await db.suppliers.get(supplier.id))?.revision).toBe(2);
});
test('repeated Sent is idempotent, records real completion only, and does not receive inventory or create debt',async () => {
  const db = await boot(), item = await db.saveStockItem(stockInput), setup = (await db.setup())!, draft = supplierDrafts({setup,items:[item],suppliers:[],moves:[]})[0], input = {id:newSupplierMessageId(),supplierName:draft.supplierName,text:draft.parts[0],stockItemIds:draft.stockItemIds,channel:'manual' as const,part:1,parts:1}, before = await db.events.count();
  const records = await Promise.all([db.recordSupplierMessage(input),db.recordSupplierMessage(input)]);expect(records[0]).toEqual(records[1]);expect(await db.supplierMessages.count()).toBe(1);expect(await db.events.count()).toBe(before+1);expect(await db.stockItems.get(item.id)).toEqual(item);expect(await db.stockMoves.count()).toBe(1);expect(await db.creditEntries.count()).toBe(0);
  await expect(db.recordSupplierMessage({...input,text:'Different text'})).rejects.toThrow(/changed/);await db.undoSupplierMessage(input.id);expect((await db.supplierMessages.get(input.id))?.voidedAt).toBeDefined();await expect(db.recordSupplierMessage(input)).rejects.toThrow(/changed/);
});
test('version 5 orders, receipts, customer credit and audit records survive the additive stock migration',async () => {
  const source = await boot(), customer = await source.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'Road 12',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:10000}}), account = (await source.creditAccounts.toArray())[0];
  const order = await source.saveOrder({...orderFixture('restaurant').input,customerId:customer.id,phone:customer.phone!},{settlement:{method:'credit',accountId:account.id}});await source.addOrderNote(order.id,'Preserve this',2);await source.recordSale({expression:'50',method:'cash'});await source.recordCreditPayment(account.id,500,'cash');
  const schema = {businesses:'id',outlets:'id,businessId',members:'id,businessId',categories:'id,outletId',items:'id,outletId,categoryId',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision]',sales:'id,outletId,createdAt,orderId',customers:'id,businessId,phone,&[businessId+phone]',creditAccounts:'id,outletId,customerId,&[outletId+customerId+currency]',creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,orderId,refundId,&reversalOf,&[accountId+sequence]',orders:'id,outletId,status,customer.id,createdAt,&[outletId+sequence],&[outletId+number]',orderNotes:'id,orderId,outletId,&[orderId+revision]',orderCommunications:'id,orderId,outletId,&[orderId+revision]',orderRefunds:'id,outletId,orderId,saleId,createdAt'};
  const name = `mise-stock-v5-${randomUUID()}`, legacy = new Dexie(name);legacy.version(5).stores(schema);const records:Record<string,unknown[]> = {};
  for (const table of Object.keys(schema)) {records[table] = await source.table(table).toArray();await legacy.table(table).bulkPut(records[table]);}legacy.close();
  const db = new MiseDatabase(name);databases.push(db);await db.open();expect(db.verno).toBe(13);
  for (const table of Object.keys(schema)) expect(await db.table(table).toArray(),table).toEqual(records[table]);
  const ledger = await db.readCreditLedger(account.id);expect(creditBalance(ledger.account,ledger.entries)).toBe(2000);expect(await db.stockItems.count()).toBe(0);expect(await db.stockMoves.count()).toBe(0);expect(await db.suppliers.count()).toBe(0);expect(await db.supplierMessages.count()).toBe(0);await db.saveStockItem(stockInput);expect(await db.orders.get(order.id)).toEqual(records.orders[0]);
});
