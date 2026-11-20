import {expect,test,type Page} from '@playwright/test';
import {startConvergenceServer} from '../sync-convergence-server';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {backupTableNames} from '../../packages/core/backup-tables';
import {installRealtimeFixture} from '../realtime-browser-fixture';
// @ts-expect-error The isolated native installer is JavaScript, not shipped code.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';

test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeEach(async()=>{server=await startConvergenceServer();});
test.afterEach(async()=>{await server?.close();});
async function initialize(page:Page,n:1|2){
 await page.goto('app/');await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));
 await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();await installSyncApplyFixture(page);
}
test('original concurrent notes, supplier sets, Inbox fields and explicit Sent merge through SQL and pending projection without rewriting commands',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);await page.evaluate(()=>window.miseSyncApplyTest.seedConcurrentSupplier());await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
 const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);const baseline=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  await other.setOffline(true);await page.context().setOffline(true);
  const ids=await manager.evaluate(()=>window.miseSyncApplyTest.editConcurrentSources('Manager')),original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  await page.evaluate(()=>window.miseSyncApplyTest.editConcurrentSources('Owner'));const ownerOriginal=await page.evaluate(()=>window.miseSyncApplyTest.inspect());
  const managerSupplier=original.queue.flatMap(row=>row.commands).find(c=>c.type==='supplier.update'),ownerSupplier=ownerOriginal.queue.flatMap(row=>row.commands).find(c=>c.type==='supplier.update');
  if(managerSupplier?.type!=='supplier.update'||ownerSupplier?.type!=='supplier.update')throw Error('Expected original supplier intents');
  expect(managerSupplier.occurredAt).toBeLessThan(ownerSupplier.occurredAt);
  await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);const pending=await manager.evaluate(()=>window.miseSyncApplyTest.pull()),projected=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  expect(pending.pending).toBe(original.queue.flatMap(row=>row.commands).length);expect(pending.covered).toBe(0);expect(projected.queue).toEqual(original.queue);
  expect(projected.backup.tables.orderNotes.filter(row=>row.orderId===ids.orderId).map(row=>row.text)).toEqual(expect.arrayContaining(['Owner original note · বাংলা','Manager original note · বাংলা']));
  expect(projected.backup.tables.suppliers.find(row=>row.id===ids.supplierId)).toMatchObject({name:'Manager supplier',note:'Manager literal note'});
  const inbox=projected.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)!;expect(inbox).toMatchObject({kind:'order',archived:true});expect(inbox.images).toEqual(baseline.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)!.images);
  expect(projected.backup.tables.orderCommunications.filter(row=>row.orderId===ids.orderId)).toHaveLength(baseline.backup.tables.orderCommunications.filter(row=>row.orderId===ids.orderId).length+1);
  await manager.reload();await installSyncApplyFixture(manager);expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(original.queue);
  await manager.evaluate(()=>window.miseSyncApplyTest.deliver()).catch(error=>{throw new Error(JSON.stringify(server.diagnostics),{cause:error});});await manager.evaluate(()=>window.miseSyncApplyTest.pull());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
  expect(b.queue.every(row=>row.status==='accepted')).toBe(true);expect(b.queue.map(row=>row.commands)).toEqual(original.queue.map(row=>row.commands));expect(b.applications.at(-1)?.pending).toEqual([]);
  const supplier=b.backup.tables.suppliers.find(row=>row.id===ids.supplierId)!;expect(supplier).toMatchObject({name:'Manager supplier',revision:3});
  expect(b.backup.tables.events.find(row=>row.id===managerSupplier.id)).toMatchObject({before:{name:'Owner supplier'},after:{name:'Manager supplier'}});
  expect(b.backup.tables.orders.find(row=>row.id===ids.orderId)?.revision).toBe(baseline.backup.tables.orders.find(row=>row.id===ids.orderId)!.revision+3);
  expect(b.backup.tables.orderCommunications.find(row=>row.text==='Original manager quote · বাংলা')).toBeDefined();
  for(const table of ['sales','creditEntries','stockMoves'] as const)expect(b.backup.tables[table]).toEqual(baseline.backup.tables[table]);
  expect(b.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images).toEqual(inbox.images);
  const exact=syncDownloadToken(b.backup.tables);await manager.evaluate(()=>window.miseSyncApplyTest.deliver());await manager.evaluate(()=>window.miseSyncApplyTest.pull());expect(syncDownloadToken((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).backup.tables)).toBe(exact);expect(server.diagnostics).toEqual([]);
 }finally{await page.context().setOffline(false);await other.close();}
});
test('a real financial conflict retains its exact rejected action, images and later cash across native reload and retry',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await page.context().setOffline(true);await other.setOffline(true);
  const paid=await manager.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('payment'));await manager.evaluate(()=>window.miseSyncApplyTest.cash('5'));const original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect()),payment=original.queue[0].commands[0],laterCash=original.queue[1].commands[0];expect(payment.type).toBe('order.payment');if(laterCash.type!=='sale.record')throw Error('Expected original later cash');const unsentSaleIds=[paid.payment.saleId!,laterCash.saleId];
  await page.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('price'));await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());const stopped=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  expect(stopped.syncSession?.problem).toBe('review');expect(stopped.queue).toEqual(original.queue);expect(stopped.backup.tables).toEqual(original.backup.tables);expect(stopped.actionReviews).toHaveLength(1);const review=stopped.actionReviews[0];expect(review).toMatchObject({commandId:payment.id,entryId:original.queue[0].id,status:409,commandIndex:0,observations:1,confirmedAt:null,receiptHash:null});expect(await server.financialCount(unsentSaleIds)).toBe(0);
  await other.setOffline(true);await manager.reload();await installSyncApplyFixture(manager);const retained=await manager.evaluate(()=>window.miseSyncApplyTest.actionReviews());expect(retained[0].review).toEqual(review);expect(retained[0].command).toEqual(payment);expect(retained[0].changes).toEqual(original.queue[0].changes);expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).backup.tables).toEqual(original.backup.tables);
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());const retried=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(retried.actionReviews).toHaveLength(1);expect(retried.actionReviews[0]).toMatchObject({...review,lastObservedAt:expect.any(Number),observations:2});expect(retried.queue).toEqual(original.queue);expect(await server.financialCount(unsentSaleIds)).toBe(0);expect(server.diagnostics).toEqual(Array(2).fill({name:'prepare_order_write',code:'PT409',message:'Review the latest order revision.'}));
 }finally{await page.context().setOffline(false);await other.close();}
});

test('the built app automatically admits original offline conflicts and refreshes the other browser without manual delivery calls',async({page,browser})=>{
 test.setTimeout(120000);const ownerSocket=await installRealtimeFixture(page,server.config(1).jwt);await initialize(page,1);await page.evaluate(()=>window.miseSyncApplyTest.seedConcurrentSupplier());await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
 const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 const turnOn=async(p:Page)=>{await p.goto('app/settings/sync?flags=cloudSync');await p.getByRole('button',{name:'Turn on sync',exact:true}).click();await expect(p.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});await installSyncApplyFixture(p);};
 try{
  await installRealtimeFixture(manager,server.config(2).jwt);await initialize(manager,2);await turnOn(page);await turnOn(manager);
  await page.context().setOffline(true);await other.setOffline(true);
  const ids=await manager.evaluate(()=>window.miseSyncApplyTest.editConcurrentSources('Manager')),original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());await page.evaluate(()=>window.miseSyncApplyTest.editConcurrentSources('Owner'));
  await expect(page.getByRole('link',{name:/^Sync: Offline/})).toBeVisible();await expect(manager.getByRole('link',{name:/^Sync: Offline/})).toBeVisible();
  await page.context().setOffline(false);await expect(page.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});
  await other.setOffline(false);await expect(manager.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});ownerSocket.notify();
  await expect.poll(async()=>{const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());return syncDownloadToken(backupTableNames.filter(t=>t!=='members').map(t=>[t,[...a.backup.tables[t]].sort((x,y)=>x.id.localeCompare(y.id))]))===syncDownloadToken(backupTableNames.filter(t=>t!=='members').map(t=>[t,[...b.backup.tables[t]].sort((x,y)=>x.id.localeCompare(y.id))]));},{timeout:20000}).toBe(true);
  const final=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(final.queue.every(row=>row.status==='accepted')).toBe(true);expect(final.queue.map(row=>row.commands)).toEqual(original.queue.map(row=>row.commands));expect(final.backup.tables.suppliers.find(row=>row.id===ids.supplierId)).toMatchObject({name:'Manager supplier',revision:3});expect(final.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)).toMatchObject({kind:'order',archived:true});expect(final.backup.tables.orderNotes.filter(row=>row.orderId===ids.orderId).map(row=>row.text)).toEqual(expect.arrayContaining(['Owner original note · বাংলা','Manager original note · বাংলা']));expect(final.backup.tables.orderCommunications.find(row=>row.text==='Original manager quote · বাংলা')).toBeDefined();expect(server.diagnostics).toEqual([]);
 }finally{await page.context().setOffline(false);await other.close();}
});
