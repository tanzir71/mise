import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {joinedApplyFixture,coverageFacts} from './sync-apply-fixture';
import {applyCanonicalDownload} from '../apps/web/src/data/cloud-sync-apply';
import {backupToken} from '../packages/core/backup';
import {newInboxId} from '../packages/core/inbox';
import {defaultCreditMessaging} from '../packages/core/khata-messages';
import {defaultCreditTerms} from '../packages/core/khata';
import {closingPreview} from '../packages/core/today';
import {reviewShopLink} from '../packages/core/shop-links';
import {inboxPng} from './inbox-fixture';
import {backupTableNames} from '../packages/core/backup-tables';
import {creditBalance} from '../packages/core/khata';
import {recordSaleCommand} from '../packages/core/sales';
import type {MiseDatabase} from '../apps/web/src/data/db';
import type {OrderInput} from '../packages/core/orders';

const databases:MiseDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.delete();});
async function boot(){const f=await joinedApplyFixture();databases.push(f.db);return f;}
async function apply(f:Awaited<ReturnType<typeof boot>>){
 const queue=await f.db.outbox.toArray(),input=await f.stage(),snapshot=await f.db.readBackup(),result=await applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source)},f.refresh);
 expect(result.pending).toBe(queue.flatMap(row=>row.commands).length);expect(result.covered).toBe(0);expect(await f.db.outbox.toArray()).toEqual(queue);expect(queue.every(row=>row.receipts.length===0)).toBe(true);expect(await f.db.syncApplications.count()).toBe(1);
 const projected=await f.db.readBackup();for(const table of backupTableNames)expect(projected.tables[table].map(row=>row.id).sort(),table).toEqual(snapshot.tables[table].map(row=>row.id).sort());
 return {queue,snapshot,result};
}
const itemInput={name:'Original item\0\ud800',nameLocal:'বাংলা',price:3700,unit:'pc',category:'New original category',available:true,oftenBought:false};
const orderInput:OrderInput={source:'phone',sourceText:'Original request\0\ud800',name:'Original customer',phone:'',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:2,unitPrice:750}],deliveryFee:0,discount:0,payment:{method:'cash'}};
it('replays original catalogue create/update/delete and categories over the frozen base',async()=>{
 const f=await boot(),created=await f.db.saveItem(itemInput);await f.db.saveItem({...itemInput,price:3900},created.id);const deleted=f.backup.tables.items[0];await f.db.deleteItem(deleted.id);const {queue}=await apply(f);
 expect(await f.db.items.get(created.id)).toMatchObject({id:created.id,name:itemInput.name,price:3900,categoryId:created.categoryId});expect(await f.db.items.get(deleted.id)).toBeUndefined();expect(await f.db.categories.get(created.categoryId)).toMatchObject({name:itemInput.category});for(const row of queue)for(const command of row.commands)expect(await f.db.events.get(command.id)).toBeDefined();
});
it('replays customer creation, original related credit IDs and later wording without losing ledger parents',async()=>{
 const f=await boot(),customer=await f.db.saveCustomer({name:'Pending customer\0\ud800',nickname:'Pending',phone:'01712349999',address:'Road 12',notes:'Keep literal source',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000},opening:{amount:1200,occurredAt:Date.now()-86400000}});
 const account=(await f.db.creditAccounts.where('customerId').equals(customer.id).toArray())[0];await f.db.saveCustomer({...customer,name:'Edited pending customer',phone:customer.phone??''},{id:customer.id});await f.db.saveCreditTerms(customer.id,{...defaultCreditTerms,allowed:true,limit:120000},account.id);const {queue}=await apply(f);
 expect(await f.db.customers.get(customer.id)).toMatchObject({name:'Edited pending customer'});expect(await f.db.creditAccounts.get(account.id)).toMatchObject({customerId:customer.id,limit:120000});expect((await f.db.creditEntries.where('accountId').equals(account.id).toArray()).some(entry=>entry.amount===1200)).toBe(true);expect(queue.flatMap(row=>row.commands).some(command=>command.type==='customer.create'&&command.ids.accountId===account.id)).toBe(true);
});
it('replays supplier create/update/archive/restore and a complete invoice using original IDs',async()=>{
 const f=await boot(),supplier=await f.db.saveSupplier({name:'Original supplier',phone:'',note:'literal\0\ud800'}),edited=await f.db.saveSupplier({name:'Edited supplier',phone:'',note:supplier.note},{id:supplier.id,revision:supplier.revision}),archived=await f.db.archiveSupplier(supplier.id,true,edited.revision);await f.db.archiveSupplier(supplier.id,false,archived.revision);
 const purchase=await f.db.recordPurchase({supplierId:supplier.id,supplierName:'Edited supplier',reference:'PENDING-1',lines:[{name:'Chicken',unit:'kg',qty:1.5,unitPrice:12001}],paid:'due',note:'keep invoice'});await apply(f);
 expect(await f.db.suppliers.get(supplier.id)).toMatchObject({name:'Edited supplier',revision:4});expect((await f.db.suppliers.get(supplier.id))?.archivedAt).toBeUndefined();expect(await f.db.purchases.get(purchase.id)).toMatchObject({supplierId:supplier.id,total:18002,reference:'PENDING-1'});
});
it('replays a complete cash order, note and payment undo while retaining original financial identities',async()=>{
 const f=await boot(),order=await f.db.saveOrder(orderInput,{settlement:{method:'cash'}});await f.db.addOrderNote(order.id,'Original note\0\ud800',order.revision);const noted=(await f.db.orders.get(order.id))!;await f.db.undoOrderPayment(order.id,noted.revision);const {queue}=await apply(f);
 const current=(await f.db.orders.get(order.id))!;expect(current.payment.status).toBe('pending');expect(current.payment.saleId).toBeUndefined();expect(await f.db.orderNotes.where('orderId').equals(order.id).count()).toBe(1);expect((await f.db.sales.toArray()).some(sale=>sale.id===order.payment.saleId&&sale.voidedAt!==undefined)).toBe(true);expect(queue[0].commands[0]).toMatchObject({type:'order.create',orderId:order.id,settlement:{ids:{saleId:order.payment.saleId}}});
});
it('replays complete reviewed closing and its original surplus receipt and undo',async()=>{
 const f=await boot(),context=await f.db.readToday(),preview=closingPreview(context),closing=await f.db.closeDay({id:newInboxId(),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:preview.summary.expectedCash+700,note:'Original count',addDifference:true});await f.db.undoDayClosing(closing.id);await apply(f);expect(await f.db.dayClosings.get(closing.id)).toMatchObject({countedCash:preview.summary.expectedCash+700});expect((await f.db.dayClosings.get(closing.id))?.voidedAt).toBeDefined();if(closing.addedSaleId)expect((await f.db.sales.get(closing.addedSaleId))?.voidedAt).toBeDefined();
});
it('replays reminder wording and export preparation while preserving original audit IDs',async()=>{
 const f=await boot(),setup=(await f.db.setup())!;await f.db.saveCreditMessaging({...defaultCreditMessaging,paymentNote:'Pay at the counter\0\ud800'});await f.db.recordPreparedExport({outletId:setup.outlet.id,actorId:setup.owner.id,format:'json',datasets:[],rows:3,filename:'mise-backup.json',capturedAt:Date.now(),from:null,to:null,includePhones:true});const {queue}=await apply(f);expect((await f.db.outlets.get(setup.outlet.id))?.creditMessaging?.paymentNote).toBe('Pay at the counter\0\ud800');for(const row of queue)for(const command of row.commands)expect(await f.db.events.get(command.id)).toBeDefined();
});
it('replays owner profile edits without changing actor identity or outlet assignments',async()=>{
 const f=await boot(),setup=(await f.db.setup())!,assignments=[...setup.owner.outletIds];await f.db.saveSetup({name:'Edited shop',phone:'01712345482',businessType:setup.business.businessType,marketCode:setup.business.marketCode,outletName:'Edited outlet',address:'Road 13'});await apply(f);const current=(await f.db.setup())!;expect(current.business.name).toBe('Edited shop');expect(current.owner.id).toBe(setup.owner.id);expect(current.owner.outletIds).toEqual(assignments);expect(current.outlet.name).toBe('Edited outlet');
});
it('replays manual message preparation, Copy and explicit Sent without creating a second attempt',async()=>{
 const f=await boot(),setup=(await f.db.setup())!,session=await f.db.prepareHandoff({source:{kind:'shop',id:setup.outlet.id},purpose:'shop-link',target:'copy',text:'Original literal message · বাংলা',part:1,parts:1}),copied=await f.db.changeHandoff(session.id,1,{type:'copy'});await f.db.changeHandoff(session.id,copied.progress.revision,{type:'sent'});await apply(f);const current=await f.db.readHandoff(session.id);expect(current.progress.status).toBe('sent');expect(current.generation).toBe(session.generation);expect(current.draft.text).toBe(session.draft.text);expect(await f.db.events.where('handoffId').equals(session.id).count()).toBe(3);
});
it('replays an original captured image and sorting with its complete unchanged bytes',async()=>{
 const f=await boot(),item=await f.db.captureInbox({title:'Original capture',text:'Literal source\0\ud800',url:'',files:[new File([new Uint8Array(inboxPng)],'তালিকা.png',{type:'image/png'})]});await f.db.changeInbox(item.id,item.revision,{kind:'order'});const {snapshot}=await apply(f),current=(await f.db.readBackup()).tables.inboxItems.find(row=>row.id===item.id)!;expect(current.kind).toBe('order');expect(current.images).toEqual(snapshot.tables.inboxItems.find(row=>row.id===item.id)!.images);expect(current.text).toBe(item.text);
});
it('replays a frozen approved shop link without changing its publication or receipt identity',async()=>{
 const f=await boot(),setup=(await f.db.setup())!,items=await f.db.items.toArray(),input={phone:setup.owner.phone!,hours:'9–5',deliveryNote:'Call first',mode:'menu' as const,itemIds:items.map(item=>item.id)},review=reviewShopLink({setup,items,categories:await f.db.categories.toArray()},input.itemIds),event=await f.db.generateShopLink(input,review,'https://shop.test/app/');const saved=(await f.db.outlets.get(setup.outlet.id))!.shopLink;await apply(f);expect((await f.db.outlets.get(setup.outlet.id))?.shopLink).toBe(saved);expect(await f.db.events.get(event.id)).toMatchObject({command:'shopLink.generate',after:{url:saved}});
});
it('a changed order revision retains the complete original pending note rather than silently overwriting remote history',async()=>{
 const f=await boot(),order=f.backup.tables.orders[0];await f.db.addOrderNote(order.id,'Original pending note',order.revision);const original=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray(),input=await f.stage([{table:'orders',row:{...order,revision:order.revision+1,updatedAt:Date.now()}}]);await expect(applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source)},f.refresh)).rejects.toMatchObject({kind:'conflict'});expect(backupToken(await f.db.readBackup())).toBe(original);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.syncApplications.count()).toBe(0);
});
it('replays cancellation, partial refund, refund correction and cancellation undo with the original receipt',async()=>{
 const f=await boot(),paid=await f.db.saveOrder(orderInput,{settlement:{method:'cash'}}),cancelled=await f.db.changeOrderStatus(paid.id,'cancelled',paid.revision),refund=await f.db.refundOrder(paid.id,{amount:500,method:'cash',note:'Original refund'},cancelled.revision);await f.db.undoOrderRefund(refund.id);const before=(await f.db.orders.get(paid.id))!;await f.db.undoOrderStatus(paid.id,before.revision);await apply(f);const current=(await f.db.orders.get(paid.id))!;expect(current.status).toBe(paid.status);expect(current.payment.saleId).toBe(paid.payment.saleId);expect(current.payment.cancellation).toBeUndefined();expect((await f.db.sales.get(paid.payment.saleId!))?.voidedAt).toBeUndefined();expect((await f.db.orderRefunds.get(refund.id))?.voidedAt).toBeDefined();
});
it('replays a credit order cancellation and restoration without replacing its account or charge',async()=>{
 const f=await boot(),customer=f.backup.tables.customers[0],account=f.backup.tables.creditAccounts[0],paid=await f.db.saveOrder({...orderInput,customerId:customer.id,name:customer.name,payment:{method:'credit'}},{settlement:{method:'credit',accountId:account.id}}),cancelled=await f.db.changeOrderStatus(paid.id,'cancelled',paid.revision);await f.db.undoOrderStatus(paid.id,cancelled.revision);const before=await f.db.readBackup(),expected=creditBalance(account,before.tables.creditEntries);await apply(f);const current=await f.db.readBackup();expect(creditBalance(account,current.tables.creditEntries)).toBe(expected);expect(current.tables.orders.find(row=>row.id===paid.id)?.payment.saleId).toBe(paid.payment.saleId);expect(current.tables.creditEntries.filter(row=>row.saleId===paid.payment.saleId).map(row=>row.id).sort()).toEqual(before.tables.creditEntries.filter(row=>row.saleId===paid.payment.saleId).map(row=>row.id).sort());
});
it('replays explicit Sent companions for khata and order messages as the original single actions',async()=>{
 const f=await boot(),account=f.backup.tables.creditAccounts[0],order=f.backup.tables.orders[0],credit=await f.db.prepareHandoff({source:{kind:'credit',id:account.id},purpose:'reminder',target:'copy',text:'Please pay at the shop.',part:1,parts:1});await f.db.changeHandoff(credit.id,1,{type:'sent'},undefined,{kind:'credit'});const quote=await f.db.prepareHandoff({source:{kind:'order',id:order.id},purpose:'quote',target:'copy',text:'Your quoted total is ready.',part:1,parts:1});await f.db.changeHandoff(quote.id,1,{type:'sent'},undefined,{kind:'order',revision:order.revision});const original=await f.db.readBackup();await apply(f);const current=await f.db.readBackup();expect(current.tables.creditEntries.filter(row=>row.type==='reminder')).toHaveLength(1);expect(current.tables.orderCommunications.map(row=>row.id)).toEqual(original.tables.orderCommunications.map(row=>row.id));expect((await f.db.readHandoff(quote.id)).progress.status).toBe('sent');
});
it('replays a standalone supplier confirmation and its correction with normalized audit data',async()=>{
 const f=await boot(),id=newInboxId(),stock=f.backup.tables.stockItems[0];await f.db.recordSupplierMessage({id,supplierName:'Original supplier',text:'Original literal message\0\ud800',channel:'manual',stockItemIds:[stock.id],part:1,parts:1});await f.db.undoSupplierMessage(id);await apply(f);const message=(await f.db.supplierMessages.get(id))!;expect(message.voidedAt).toBeDefined();const original=await f.db.events.get(message.eventId);expect(original?.after).toMatchObject({id,updatedAt:original?.at});expect((await f.db.events.toArray()).some(event=>event.undoOf===message.eventId)).toBe(true);
});
it('replays a frozen link publication and original-time undo',async()=>{
 const f=await boot(),setup=(await f.db.setup())!,items=await f.db.items.toArray(),review=reviewShopLink({setup,items,categories:await f.db.categories.toArray()},items.map(item=>item.id)),event=await f.db.generateShopLink({phone:setup.owner.phone!,hours:'9–5',deliveryNote:'',mode:'menu',itemIds:items.map(item=>item.id)},review,'https://shop.test/app/');await f.db.undoShopLink(event.id);await apply(f);expect((await f.db.outlets.get(setup.outlet.id))?.shopLink).toBeUndefined();expect((await f.db.events.toArray()).some(row=>row.undoOf===event.id)).toBe(true);
});
it('logs the losing remote reminder wording while tentatively retaining the original local set',async()=>{
 const f=await boot(),outlet=f.backup.tables.outlets[0];await f.db.saveCreditMessaging({...defaultCreditMessaging,paymentNote:'Original local wording'});const queue=await f.db.outbox.toArray(),input=await f.stage([{table:'outlets',row:{...outlet,creditMessaging:{...defaultCreditMessaging,paymentNote:'Remote wording'},updatedAt:Date.now()}}]);await applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source)},f.refresh);const event=await f.db.events.get(queue[0].commands[0].id);expect(event?.before).toMatchObject({creditMessaging:{paymentNote:'Remote wording'}});expect(event?.after).toMatchObject({creditMessaging:{paymentNote:'Original local wording'}});expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('retains a reviewed closing if remote cash changes the reviewed totals',async()=>{
 const f=await boot(),preview=closingPreview(await f.db.readToday());await f.db.closeDay({id:newInboxId(),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:preview.summary.expectedCash,note:'',addDifference:false});const original=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray(),change=recordSaleCommand({expression:'5',method:'cash'},{setup:(await f.db.setup())!,items:await f.db.items.toArray(),wallets:[]},queue[0].at-1),input=await f.stage([{table:'sales',row:change.sale},{table:'events',row:change.event}]);await expect(applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source)},f.refresh)).rejects.toMatchObject({kind:'conflict'});expect(backupToken(await f.db.readBackup())).toBe(original);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.syncApplications.count()).toBe(0);
});
it('retains a colliding supplier identity instead of overwriting the canonical supplier',async()=>{
 const f=await boot(),supplier=await f.db.saveSupplier({name:'Original new supplier',phone:'',note:''}),original=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray(),remote={...supplier,name:'Other canonical supplier',eventId:newInboxId()},input=await f.stage([{table:'suppliers',row:remote},{table:'events',row:{id:remote.eventId,outletId:remote.outletId,actor:{type:'member',id:f.target.actorId},command:'supplier.create',before:null,after:remote,at:remote.createdAt}}]);await expect(applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source)},f.refresh)).rejects.toMatchObject({kind:'conflict'});expect(backupToken(await f.db.readBackup())).toBe(original);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.syncApplications.count()).toBe(0);
});
