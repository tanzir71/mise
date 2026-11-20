import {expect,test,type Page} from '@playwright/test';
import {startConvergenceServer} from '../sync-convergence-server';
import {backupTableNames} from '../../packages/core/backup-tables';
import {syncDownloadToken} from '../../packages/core/sync-download';
// @ts-expect-error Isolated browser installer, never production source.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';
test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeEach(async()=>{server=await startConvergenceServer();});
test.afterEach(async()=>{await server?.close();});
async function initialize(page:Page,n:1|2){await page.goto('app/');await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});await installSyncApplyFixture(page);}
for(const outcome of ['replaced','withdrawn'] as const)test(`a deliberately ${outcome} offline payment converges through a genuine resolution after a lost response and offline reload`,async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await page.context().setOffline(true);await other.setOffline(true);
  const originalPaid=await manager.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('payment'));await manager.evaluate(()=>window.miseSyncApplyTest.cash('5'));const original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect()),command=original.queue[0].commands[0],later=original.queue[1].commands[0];if(command.type!=='order.payment'||later.type!=='sale.record')throw Error('Expected original payment and later counter cash.');
  const current=await page.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('price'));await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).syncSession?.problem).toBe('review');
  const selected=await manager.evaluate(()=>window.miseSyncApplyTest.prepareFinancialReview());expect(selected.review.current.order?.total).toBe(current.total);expect(selected.review.proposal).toMatchObject({enabled:true,total:current.total});expect(selected.packet.command).toEqual(command);
  const decision={...selected.packet,token:selected.review.token,outcome};server.loseNextCommand();await expect(manager.evaluate(value=>window.miseSyncApplyTest.resolveFinancialReview(value),decision)).rejects.toThrow(/unconfirmed|same command ID|original/i);
  const unconfirmed=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(unconfirmed.queue).toEqual(original.queue);expect(unconfirmed.backup.tables).toEqual(original.backup.tables);expect(await server.financialCount([originalPaid.payment.saleId!])).toBe(outcome==='replaced'?1:0);
  await other.setOffline(true);await manager.reload();await installSyncApplyFixture(manager);expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(original.queue);await other.setOffline(false);
  const receipt=await manager.evaluate(value=>window.miseSyncApplyTest.resolveFinancialReview(value),decision);expect(receipt).toMatchObject({type:'command.resolved',commandId:command.id,id:selected.packet.id,outcome});expect(receipt.id).not.toBe(command.id);
  await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await page.evaluate(()=>window.miseSyncApplyTest.pull());const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(b.syncSession?.problem).toBeNull();expect(b.queue.every(row=>row.status==='accepted')).toBe(true);expect(b.queue.map(row=>row.commands)).toEqual(original.queue.map(row=>row.commands));expect(b.queue.map(row=>row.changes)).toEqual(original.queue.map(row=>row.changes));expect(b.queue[0].receipts[0]).toMatchObject({type:'command.resolved',commandId:command.id,outcome});
  for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
  expect(b.backup.tables.inboxItems).toEqual(original.backup.tables.inboxItems);expect(b.backup.tables.orders.find(order=>order.id===current.id)?.payment.status).toBe(outcome==='replaced'?'paid':'pending');expect(await server.financialCount([originalPaid.payment.saleId!,later.saleId])).toBe(outcome==='replaced'?2:1);expect(b.backup.tables.events.find(event=>event.id===command.id)?.command).toBe('sync.resolve');expect(server.diagnostics).toEqual([{name:'prepare_order_write',code:'PT409',message:'Review the latest order revision.'}]);
 }finally{await page.context().setOffline(false);await other.close();}
});
