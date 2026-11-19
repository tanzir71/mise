import {expect,test,type Page} from '@playwright/test';
import {startConvergenceServer} from '../sync-convergence-server';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {backupTableNames} from '../../packages/core/backup-tables';
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
test('a frozen SQL window retains all pending domain families, complete images and original queue identities, then converges two native browsers',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);const remote=await manager.evaluate(()=>window.miseSyncApplyTest.customer('Remote before frozen read'));await manager.evaluate(()=>window.miseSyncApplyTest.deliver());
  const read=await page.evaluate(()=>window.miseSyncApplyTest.freezePull());expect(read).toBeTruthy();
  await page.context().setOffline(true);const ids=await page.evaluate(()=>window.miseSyncApplyTest.editPendingFamilies('Original offline family batch')),before=await page.evaluate(()=>window.miseSyncApplyTest.inspect());
  expect(before.queue.every(row=>row.status==='pending'&&row.receipts.length===0)).toBe(true);expect(before.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images[0].data).toBeTruthy();
  await page.reload();await installSyncApplyFixture(page);expect((await page.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(before.queue);
  await page.context().setOffline(false);const result=await page.evaluate(()=>window.miseSyncApplyTest.pull()),projected=await page.evaluate(()=>window.miseSyncApplyTest.inspect());
  expect(result.readId).toBe(read);expect(result.pending).toBe(before.queue.flatMap(row=>row.commands).length);expect(result.covered).toBe(0);expect(projected.queue).toEqual(before.queue);expect(projected.backup.tables.customers.some(row=>row.id===remote.id)).toBe(true);
  for(const table of backupTableNames)for(const row of before.backup.tables[table])expect(projected.backup.tables[table].some(current=>current.id===row.id),table+':'+row.id).toBe(true);
  expect(projected.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images).toEqual(before.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images);
  expect(projected.backup.tables.orders.find(row=>row.id===ids.orderId)?.payment.saleId).toBe(before.backup.tables.orders.find(row=>row.id===ids.orderId)?.payment.saleId);
  const delivery=await page.evaluate(()=>window.miseSyncApplyTest.deliver()).catch(async error=>{const state=await page.evaluate(()=>window.miseSyncApplyTest.inspect());throw new Error(JSON.stringify({diagnostics:server.diagnostics,queue:state.queue.map(row=>({types:row.commands.map(command=>command.type),receipts:row.receipts.length}))}),{cause:error});});expect(delivery).toBeTruthy();await page.evaluate(()=>window.miseSyncApplyTest.pull());await manager.evaluate(()=>window.miseSyncApplyTest.pull());
  const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
  expect(a.queue.every(row=>row.status==='accepted')).toBe(true);expect(a.queue.map(row=>row.commands)).toEqual(before.queue.map(row=>row.commands));expect(a.applications.at(-1)?.pending).toEqual([]);expect(a.imageSizes).toEqual(b.imageSizes);
  const puts=server.calls.imagePuts;expect(puts).toBe(1);await page.evaluate(()=>window.miseSyncApplyTest.deliver());expect(server.calls.imagePuts).toBe(puts);expect(server.diagnostics).toEqual([]);
 }finally{await page.context().setOffline(false);await other.close();}
});
test('commands accepted after the frozen window remain pending in that window without inventing or replacing receipts',async({page})=>{
 test.setTimeout(120000);await initialize(page,1);const read=await page.evaluate(()=>window.miseSyncApplyTest.freezePull()),ids=await page.evaluate(()=>window.miseSyncApplyTest.editPendingFamilies('Accepted after frozen read'));
 await page.evaluate(()=>window.miseSyncApplyTest.deliver());const accepted=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(accepted.queue.every(row=>row.status==='accepted')).toBe(true);
 const result=await page.evaluate(()=>window.miseSyncApplyTest.pull()),projected=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(result.readId).toBe(read);expect(result.pending).toBe(accepted.queue.flatMap(row=>row.commands).length);expect(result.covered).toBe(0);expect(projected.queue).toEqual(accepted.queue);expect(projected.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images).toEqual(accepted.backup.tables.inboxItems.find(row=>row.id===ids.inboxId)?.images);
 await page.evaluate(()=>window.miseSyncApplyTest.pull());const final=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(final.applications.at(-1)?.pending).toEqual([]);expect(final.queue).toEqual(accepted.queue);
 for(const table of backupTableNames)expect(final.backup.tables[table].filter(row=>table!=='events'||!('command'in row)||row.command!=='inbox.image.upload').map(row=>row.id).sort(),table).toEqual(accepted.backup.tables[table].map(row=>row.id).sort());
 expect(final.backup.tables.events.filter(event=>event.command==='inbox.image.upload')).toHaveLength(1);
 expect(server.diagnostics).toEqual([]);
});
test('a lost committed image reply retains the original capture and retries one immutable image without a second upload audit',async({page})=>{
 test.setTimeout(90000);await initialize(page,1);const item=await page.evaluate(()=>window.miseSyncApplyTest.captureImage()),before=await page.evaluate(()=>window.miseSyncApplyTest.inspect());server.loseNextImageReply();
 await expect(page.evaluate(()=>window.miseSyncApplyTest.deliver())).rejects.toThrow(/unconfirmed|same command/);const retained=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(retained.queue[0].status).toBe('accepted');expect(retained.queue[0].commands).toEqual(before.queue[0].commands);expect(retained.backup.tables.inboxItems.find(row=>row.id===item.id)?.images).toEqual(before.backup.tables.inboxItems.find(row=>row.id===item.id)?.images);expect(server.calls.imagePuts).toBe(1);
 await page.reload();await installSyncApplyFixture(page);await page.evaluate(()=>window.miseSyncApplyTest.deliver());expect(server.calls.imagePuts).toBe(2);expect((await page.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(retained.queue);
 await page.evaluate(()=>window.miseSyncApplyTest.pull());const final=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(final.backup.tables.events.filter(event=>event.command==='inbox.image.upload'&&event.inboxId===item.id)).toHaveLength(1);expect(final.backup.tables.inboxItems.find(row=>row.id===item.id)?.images).toEqual(before.backup.tables.inboxItems.find(row=>row.id===item.id)?.images);
 await page.evaluate(()=>window.miseSyncApplyTest.deliver());expect(server.calls.imagePuts).toBe(2);expect(server.diagnostics).toEqual([]);
});
