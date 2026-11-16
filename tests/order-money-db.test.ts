import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { creditBalance, defaultCreditTerms } from '../packages/core/khata';
import { creditOverview } from '../packages/core/khata-reports';
import { saleCashIn, refundCashOut } from '../packages/core/order-payments';
import { saveOrderCommand, addOrderNoteCommand } from '../packages/core/orders';
import { setupCommand } from '../packages/core/setup';
import { recordSaleCommand, receiptText } from '../packages/core/sales';
import { orderFixture } from './order-fixture';
import { profile } from './credit-fixture';

const databases:MiseDatabase[]=[], shop={businessType:'corner_shop',marketCode:'BD',name:'Money test',phone:'01712345482'} as const;
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(limit=10000) {
  const db=new MiseDatabase(`mise-order-money-${randomUUID()}`);databases.push(db);await db.saveSetup(shop);
  const customer=await db.saveCustomer(profile,{credit:{...defaultCreditTerms,allowed:true,limit}}),account=(await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0];
  const input={...orderFixture().input,customerId:customer.id,phone:customer.phone!}; return {db,customer,account,input,order:await db.saveOrder(input)};
}

test('a rapid repeated settlement creates one sale and cash undo also updates its order',async()=>{
  const {db,order}=await boot();const results=await Promise.allSettled([db.settleOrder(order.id,{method:'cash',given:5000},1),db.settleOrder(order.id,{method:'cash'},1)]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await db.sales.count()).toBe(1);
  let saved=(await db.orders.get(order.id))!;const sale=(await db.sales.get(saved.payment.saleId!))!;expect(sale).toMatchObject({orderId:order.id,amount:2500,given:5000,change:2500});expect(receiptText(sale)).toContain(`Order ${order.number}`);
  await db.undoSale(sale.id);saved=(await db.orders.get(order.id))!;expect(saved.payment.status).toBe('pending');expect((await db.sales.get(sale.id))?.voidReason).toBe('undo');
  await expect(db.undoSale(sale.id)).rejects.toThrow();expect(await db.events.where('command').equals('order.payment').count()).toBe(1);
});

test('create-and-pay is atomic and failed credit consent does not consume an order number',async()=>{
  const {db,input,account}=await boot(1000),count=await db.events.count();
  await expect(db.saveOrder(input,{settlement:{method:'credit',accountId:account.id}})).rejects.toMatchObject({name:'CreditLimitError'});
  expect(await db.orders.count()).toBe(1);expect(await db.sales.count()).toBe(0);expect(await db.creditEntries.count()).toBe(0);expect(await db.events.count()).toBe(count);
  const paid=await db.saveOrder(input,{settlement:{method:'credit',accountId:account.id,confirmation:{balance:0,limit:1000}}});
  expect(paid).toMatchObject({number:'A-0002',revision:2,payment:{status:'credited'}});expect(await db.sales.count()).toBe(1);expect(await db.creditEntries.count()).toBe(1);
});

test('active paid orders accept fulfilment changes while protecting receipt amounts and payment links',async()=>{
  const {db,input,customer}=await boot(),paid=await db.saveOrder({...input,type:'delivery',address:'Old road',deliveryFee:100},{settlement:{method:'cash'}});
  const sale=await db.sales.get(paid.payment.saleId!);
  await db.saveCustomer({...customer,phone:'01711222483'},{id:customer.id});
  const edited=await db.saveOrder({...input,type:'delivery',address:'New road',deliveryFee:100,lines:paid.lines},{id:paid.id,revision:paid.revision});
  expect(edited).toMatchObject({address:'New road',total:2600,customer:{phone:paid.customer.phone},payment:{status:'paid',saleId:sale!.id}});expect(await db.sales.get(sale!.id)).toEqual(sale);
  await expect(db.saveOrder({...input,type:'delivery',address:'New road',deliveryFee:100,lines:paid.lines.map(line=>({...line,unitPrice:1500}))},{id:paid.id,revision:edited.revision})).rejects.toThrow(/cannot be edited/);
  expect((await db.orders.get(paid.id))?.revision).toBe(edited.revision);expect(await db.sales.count()).toBe(1);
});

test('atomic credit settlement obeys limits across orders and rejects stale consent',async()=>{
  const {db,order,input,account}=await boot(3000),second=await db.saveOrder(input);
  const results=await Promise.allSettled([db.settleOrder(order.id,{method:'credit',accountId:account.id},1),db.settleOrder(second.id,{method:'credit',accountId:account.id},1)]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await db.sales.count()).toBe(1);expect(await db.creditEntries.count()).toBe(1);
  const pending=(await db.orders.toArray()).find(order=>order.payment.status==='pending')!;
  await db.recordCreditPayment(account.id,100,'cash');
  await expect(db.settleOrder(pending.id,{method:'credit',accountId:account.id,confirmation:{balance:2500,limit:3000}},1)).rejects.toMatchObject({name:'CreditLimitError',balance:2400});
  await db.settleOrder(pending.id,{method:'credit',accountId:account.id,confirmation:{balance:2400,limit:3000}},1);
  const ledger=await db.readCreditLedger(account.id);expect(creditBalance(ledger.account,ledger.entries)).toBe(4900);
});

test('audit failure rolls back settlement, credit, cancellation, refund and their linked records',async()=>{
  const {db,order,account}=await boot();let fail='khata.charge';
  db.events.hook('creating',(_key,event)=>{if(event.command===fail)throw new Error('Audit denied');});
  await expect(db.settleOrder(order.id,{method:'credit',accountId:account.id},1)).rejects.toThrow('Audit denied');expect(await db.sales.count()).toBe(0);expect(await db.creditEntries.count()).toBe(0);expect((await db.orders.get(order.id))?.revision).toBe(1);
  fail='';const paid=await db.settleOrder(order.id,{method:'credit',accountId:account.id},1);await db.recordCreditPayment(account.id,1000,'cash');const count=await db.events.count();
  fail='sale.order-cancel';await expect(db.changeOrderStatus(order.id,'cancelled',2)).rejects.toThrow('Audit denied');expect((await db.sales.get(paid.payment.saleId!))?.voidedAt).toBeUndefined();expect(await db.creditEntries.count()).toBe(2);expect(await db.events.count()).toBe(count);
  fail='';const cancelled=await db.changeOrderStatus(order.id,'cancelled',2);
  fail='refund.record';await expect(db.refundOrder(order.id,{amount:1000,method:'cash'},3)).rejects.toThrow('Audit denied');expect(await db.orderRefunds.count()).toBe(0);expect((await db.orders.get(order.id))?.payment.cancellation?.refundDue).toBe(1000);expect((await db.orders.get(order.id))?.revision).toBe(cancelled.revision);expect(await db.creditEntries.where('refundId').above('').count()).toBe(0);
});

test('cancellation, partial refunds, correction and status undo retain the full journal',async()=>{
  const {db,order}=await boot();let saved=await db.settleOrder(order.id,{method:'cash'},1);const saleId=saved.payment.saleId!;
  saved=await db.changeOrderStatus(order.id,'cancelled',2);expect(saved.payment.cancellation?.refundDue).toBe(2500);expect(saleCashIn((await db.sales.get(saleId))!)).toBe(2500);
  const refund=await db.refundOrder(order.id,{amount:1000,method:'cash'},3);expect(refundCashOut(refund)).toBe(1000);
  await expect(db.undoOrderStatus(order.id,4)).rejects.toThrow(/refund has been recorded/);
  await db.undoOrderRefund(refund.id,4);expect((await db.orders.get(order.id))?.payment.cancellation?.refundDue).toBe(2500);expect((await db.orderRefunds.get(refund.id))?.voidedAt).toBeDefined();
  await db.addOrderNote(order.id,'Customer still wants the order.',5);saved=await db.undoOrderStatus(order.id,6);expect(saved).toMatchObject({status:'requested',revision:7});expect(saved.payment.cancellation).toBeUndefined();expect((await db.sales.get(saleId))?.voidedAt).toBeUndefined();expect(await db.orderNotes.where('orderId').equals(order.id).count()).toBe(1);
  expect(await db.orderRefunds.count()).toBe(1);expect(await db.events.where('command').equals('refund.undo').count()).toBe(1);
});

test('credit refunds change collections but not debt; khata refund undo routes through the order',async()=>{
  const {db,order,account}=await boot();const paid=await db.settleOrder(order.id,{method:'credit',accountId:account.id},1);await db.recordCreditPayment(account.id,1000,'wallet','bKash');
  await db.changeOrderStatus(order.id,'cancelled',2);const refund=await db.refundOrder(order.id,{amount:1000,method:'cash'},3);
  let ledger=await db.readCreditLedger(account.id);expect(creditBalance(ledger.account,ledger.entries)).toBe(0);expect(creditOverview(ledger.account,ledger.entries,ledger.setup.outlet.timezone,'BD').collectedThisWeek).toBe(0);
  const refundEntry=ledger.entries.find(entry=>entry.refundId===refund.id)!;await db.undoCreditEntry(refundEntry.id);expect((await db.orderRefunds.get(refund.id))?.voidedAt).toBeDefined();
  await db.undoSale(paid.payment.saleId!);ledger=await db.readCreditLedger(account.id);expect(creditBalance(ledger.account,ledger.entries)).toBe(1500);expect((await db.orders.get(order.id))?.status).toBe('requested');expect(creditOverview(ledger.account,ledger.entries,ledger.setup.outlet.timezone,'BD').collectedThisWeek).toBe(1000);
});

test('refunds serialize across tabs and a double correction cannot duplicate cash or collections',async()=>{
  const {db,order}=await boot();await db.settleOrder(order.id,{method:'wallet',wallet:'Nagad'},1);await db.changeOrderStatus(order.id,'cancelled',2);
  const results=await Promise.allSettled([db.refundOrder(order.id,{amount:2000,method:'cash'},3),db.refundOrder(order.id,{amount:2000,method:'cash'},3)]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await db.orderRefunds.count()).toBe(1);
  const refund=(await db.orderRefunds.toArray())[0];const undo=await Promise.allSettled([db.undoOrderRefund(refund.id),db.undoOrderRefund(refund.id)]);expect(undo.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await db.orders.get(order.id))?.payment.cancellation?.refundDue).toBe(2500);
});

test('a payment correction cannot recreate cancelled credit debt',async()=>{
  const {db,order,account}=await boot();await db.settleOrder(order.id,{method:'credit',accountId:account.id},1);
  const payment=await db.recordCreditPayment(account.id,2500,'cash');await db.changeOrderStatus(order.id,'cancelled',2);
  const count=await db.events.count();
  await expect(db.undoCreditEntry(payment.id)).rejects.toThrow(/cancellation/);
  expect(creditBalance(account,(await db.readCreditLedger(account.id)).entries)).toBe(0);expect(await db.events.count()).toBe(count);
  await db.undoOrderStatus(order.id,3);await db.undoCreditEntry(payment.id);
  expect(creditBalance(account,(await db.readCreditLedger(account.id)).entries)).toBe(2500);
});

test('archived paid-up customers can receive recorded refunds without introducing new credit',async()=>{
  const {db,order,account,customer}=await boot();await db.settleOrder(order.id,{method:'credit',accountId:account.id},1);await db.recordCreditPayment(account.id,2500,'cash');await db.archiveCustomer(customer.id);
  await db.changeOrderStatus(order.id,'cancelled',2);const refund=await db.refundOrder(order.id,{amount:2500,method:'cash'},3);expect(refund.accountId).toBe(account.id);expect(creditBalance(account,(await db.readCreditLedger(account.id)).entries)).toBe(0);
  await db.undoOrderRefund(refund.id,4);await expect(db.undoOrderStatus(order.id,5)).rejects.toThrow(/Restore/);
});

test('version 4 orders, notes, cash receipts and events survive the refund-table upgrade',async()=>{
  const name=`mise-order-v4-${randomUUID()}`,legacy=new Dexie(name);
  legacy.version(4).stores({businesses:'id',outlets:'id,businessId',members:'id,businessId',categories:'id,outletId',items:'id,outletId,categoryId',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision]',sales:'id,outletId,createdAt',customers:'id,businessId,phone,&[businessId+phone]',creditAccounts:'id,outletId,customerId,&[outletId+customerId+currency]',creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,&reversalOf,&[accountId+sequence]',orders:'id,outletId,status,customer.id,createdAt,&[outletId+sequence],&[outletId+number]',orderNotes:'id,orderId,outletId,&[orderId+revision]',orderCommunications:'id,orderId,outletId,&[orderId+revision]'});
  const seeded=setupCommand(shop),setup=seeded.snapshot,input=orderFixture().input,created=saveOrderCommand(input,{setup,items:seeded.items,sequence:1}),noted=addOrderNoteCommand(created.order,'Use the side door',setup,1),sale=recordSaleCommand({expression:'25',method:'cash'},{setup,items:[],wallets:[]});
  await legacy.table('businesses').put(setup.business);await legacy.table('outlets').put(setup.outlet);await legacy.table('members').put(setup.owner);await legacy.table('categories').bulkPut(seeded.categories);await legacy.table('items').bulkPut(seeded.items);await legacy.table('orders').put(noted.order);await legacy.table('orderNotes').put(noted.note);await legacy.table('sales').put(sale.sale);await legacy.table('events').bulkPut([seeded.event,created.event,noted.event,sale.event]);legacy.close();
  const db=new MiseDatabase(name);databases.push(db);await db.open();expect(db.verno).toBe(8);expect(await db.orders.get(created.order.id)).toEqual(noted.order);expect(await db.orderNotes.get(noted.note.id)).toEqual(noted.note);expect(await db.sales.get(sale.sale.id)).toEqual(sale.sale);expect(await db.events.count()).toBe(4);expect(await db.orderRefunds.count()).toBe(0);
});
