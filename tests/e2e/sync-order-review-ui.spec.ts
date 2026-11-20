import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startConvergenceServer} from '../sync-convergence-server';
import {installRealtimeFixture} from '../realtime-browser-fixture';
import {backupTableNames} from '../../packages/core/backup-tables';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {formatMoney} from '../../packages/core/money';
// @ts-expect-error Isolated browser installer, never production source.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';
test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeEach(async()=>{server=await startConvergenceServer();});
test.afterEach(async()=>{await server?.close();});
async function initialize(page:Page,n:1|2){await page.goto('app/');await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});await installSyncApplyFixture(page);}
for(const outcome of ['replaced','withdrawn'] as const)test(`the actual review interface ${outcome} an offline payment and recovers its lost outcome without duplicate money`,async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await page.context().setOffline(true);await other.setOffline(true);
  const payment=await manager.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('payment'));await manager.evaluate(()=>window.miseSyncApplyTest.cash('5'));const original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect()),later=original.queue[1].commands[0];if(later.type!=='sale.record')throw Error('Expected later counter cash');
  let current=await page.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('price'));await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');
  await manager.getByRole('button',{name:'Review saved order action',exact:true}).click();const panel=manager.getByRole('region',{name:'Saved order review'});await expect(panel.getByRole('button',{name:'Check current values',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Check current values',exact:true}).click();await expect(panel.getByRole('button',{name:'Apply reviewed action',exact:true})).toBeEnabled();await expect(panel.locator('.order-review-comparison')).toContainText(formatMoney(current.total!,current.currency));
  if(outcome==='replaced'){
   current=await page.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('price'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());await panel.getByRole('button',{name:'Apply reviewed action',exact:true}).click();await expect(panel.getByText('The shop values changed. Review the updated comparison before choosing again.',{exact:true})).toBeVisible();expect(await server.financialCount([payment.payment.saleId!])).toBe(0);await expect(panel.locator('.order-review-comparison')).toContainText(formatMoney(current.total!,current.currency));
  }
  expect((await new AxeBuilder({page:manager}).include('.order-action-review').analyze()).violations).toEqual([]);
  expect((await new AxeBuilder({page:manager}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
  server.loseNextResolution();await panel.getByRole('button',{name:outcome==='replaced'?'Apply reviewed action':'Withdraw saved action',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('unconfirmed');await installSyncApplyFixture(manager);const lost=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(lost.queue).toEqual(original.queue);expect(lost.backup.tables).toEqual(original.backup.tables);expect(lost.orderReviews[0]).toMatchObject({phase:'unconfirmed',choice:outcome});expect(lost.orderReviews[0].quote).not.toHaveProperty('token');expect(await server.financialCount([payment.payment.saleId!])).toBe(outcome==='replaced'?1:0);
  await other.setOffline(true);await manager.reload();await manager.getByRole('button',{name:'Review saved order action',exact:true}).click();await expect(panel.getByText(/Your choice to/)).toBeVisible();await expect(panel.getByRole('button',{name:'Check saved outcome',exact:true})).toBeDisabled();await installSyncApplyFixture(manager);expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(original.queue);await other.setOffline(false);
  await expect(panel.getByRole('button',{name:'Check saved outcome',exact:true})).toBeEnabled({timeout:20000});await panel.getByRole('button',{name:'Check saved outcome',exact:true}).click();await expect(panel.locator('.review-outcome')).toContainText(outcome==='replaced'?'reviewed action was recorded':'saved action was withdrawn');
  await expect.poll(async()=>{await installSyncApplyFixture(manager);return (await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue.every(r=>r.status==='accepted');},{timeout:20000}).toBe(true);await page.evaluate(()=>window.miseSyncApplyTest.pull());
  const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(b.orderReviews[0].phase).toBe('confirmed');expect(b.queue.map(r=>r.commands)).toEqual(original.queue.map(r=>r.commands));expect(b.queue.map(r=>r.changes)).toEqual(original.queue.map(r=>r.changes));expect(b.backup.tables.inboxItems).toEqual(original.backup.tables.inboxItems);expect(await server.financialCount([payment.payment.saleId!,later.saleId])).toBe(outcome==='replaced'?2:1);
  for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
 }finally{await page.context().setOffline(false);await other.close();}
});
