import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
import {startConvergenceServer} from '../sync-convergence-server';
import {installRealtimeFixture} from '../realtime-browser-fixture';
import {backupTableNames} from '../../packages/core/backup-tables';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {formatMoney} from '../../packages/core/money';
// @ts-expect-error Isolated browser fixture installer, never production source.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';
test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeEach(async()=>{server=await startConvergenceServer();});
test.afterEach(async()=>{await server?.close();});
async function initialize(page:Page,n:1|2){
 await page.goto('app/');await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});await installSyncApplyFixture(page);
}
const inspect=(page:Page)=>page.evaluate(()=>window.miseSyncApplyTest.inspect());
async function changeCurrency(page:Page,currency:string){await page.evaluate(value=>window.miseSyncApplyTest.setCurrency(value),currency);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());}
for(const outcome of ['withdrawn','replaced'] as const)test(`the invoice review ${outcome} a retained original with lost reply recovery, full images and two-browser convergence`,async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);await context.setOffline(true);const invoice=await manager.evaluate(()=>window.miseSyncApplyTest.queuePurchase());await manager.evaluate(()=>window.miseSyncApplyTest.captureImage());const original=await inspect(manager),originalImages=await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes());let expectedQueue=original.queue;expect(originalImages.length).toBeGreaterThan(0);
  await changeCurrency(page,'USD');await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());expect((await inspect(manager)).syncSession?.problem).toBe('review');
  if(outcome==='replaced')await changeCurrency(page,'BDT');
  await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();const panel=manager.getByRole('region',{name:'Saved invoice review'}),apply=panel.getByRole('button',{name:'Apply reviewed invoice action',exact:true});
  await panel.getByRole('button',{name:'Check current invoice values',exact:true}).click();await expect(panel.locator('.order-review-comparison')).toContainText(formatMoney(invoice.total,'BDT'));await panel.getByText('Invoice lines (1)',{exact:true}).first().click();await expect(panel.locator('.purchase-review-lines').first()).toContainText('2.5 kg');
  if(outcome==='withdrawn'){
   await expect(apply).toBeDisabled();await expect(panel).toContainText('The shop currency changed.');
   for(const width of [360,390,768,1024,1440]){await manager.setViewportSize({width,height:1000});expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page:manager}).include('.purchase-action-review').analyze()).violations).toEqual([]);await panel.screenshot({path:test.info().outputPath(`invoice-review-${width}.png`),style:'.app-bottom-nav,.phone-app-header,.app-skip{visibility:hidden}'});}
  }else{
   await expect(apply).toBeEnabled();await page.evaluate(()=>window.miseSyncApplyTest.setTimezone('UTC'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());await apply.click();await expect(panel.getByText('The shop values changed. Review the updated comparison before choosing again.',{exact:true})).toBeVisible();expect(await server.purchaseCount([invoice.id])).toBe(0);await expect(panel.locator('.order-review-proposal')).toContainText('UTC');await expect(apply).toBeEnabled();
  }
  expect((await new AxeBuilder({page:manager}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
  server.loseNextResolution();await (outcome==='replaced'?apply:panel.getByRole('button',{name:'Withdraw saved invoice action',exact:true})).click();await expect(panel.getByRole('alert')).toContainText('unconfirmed');await installSyncApplyFixture(manager);const lost=await inspect(manager);expect(lost.queue).toEqual(original.queue);expect(lost.backup.tables).toEqual(original.backup.tables);expect(lost.purchaseReviews[0]).toMatchObject({phase:'unconfirmed',choice:{outcome}});expect(lost.purchaseReviews[0].quote).not.toHaveProperty('token');expect(await server.purchaseCount([invoice.id])).toBe(outcome==='replaced'?1:0);
  await context.setOffline(true);await manager.reload();await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();await expect(panel.getByText(/Your choice to .* is saved, but its server outcome is unconfirmed/)).toBeVisible();await expect(panel.getByRole('button',{name:'Check saved outcome',exact:true})).toBeDisabled();await installSyncApplyFixture(manager);expect((await inspect(manager)).queue).toEqual(original.queue);expect(await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes())).toEqual(originalImages);
  if(outcome==='withdrawn'){
   const returnUrl=manager.url();await panel.getByRole('link',{name:'Download a JSON backup',exact:true}).click();await expect(manager.locator('.exports-page')).toHaveAttribute('aria-busy','false');const sheet=manager.getByRole('dialog',{name:'Export',exact:true});if(await sheet.isVisible())await sheet.getByRole('button',{name:'Backup and restore',exact:true}).click();const downloading=manager.waitForEvent('download');await manager.getByRole('button',{name:'Download JSON backup',exact:true}).click();const download=await downloading,bytes=await readFile((await download.path())!,'utf8'),backup=JSON.parse(bytes);for(const table of backupTableNames)if(table!=='events')expect(backup.tables[table],table).toEqual(original.backup.tables[table]);for(const event of original.backup.tables.events)expect(backup.tables.events).toContainEqual(event);expect(Object.keys(backup.tables)).toHaveLength(21);expect(bytes).not.toMatch(/apiUrl|publishableKey|access_token|refresh_token|Authorization|purchaseReviews/);await manager.goto(returnUrl);await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();await installSyncApplyFixture(manager);expectedQueue=(await inspect(manager)).queue;expect(expectedQueue.slice(0,original.queue.length)).toEqual(original.queue);
  }
  await context.setOffline(false);await expect(panel.getByRole('button',{name:'Check saved outcome',exact:true})).toBeEnabled({timeout:20000});await panel.getByRole('button',{name:'Check saved outcome',exact:true}).click();await expect(panel.locator('.review-outcome')).toContainText(outcome==='replaced'?'reviewed invoice action was recorded':'invoice action was withdrawn');await expect(manager.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});await page.evaluate(()=>window.miseSyncApplyTest.pull());await installSyncApplyFixture(manager);const owner=await inspect(page),accepted=await inspect(manager);expect(accepted.purchaseReviews[0].phase).toBe('confirmed');expect(accepted.queue.every(row=>row.status==='accepted')).toBe(true);expect(accepted.queue.map(row=>row.commands)).toEqual(expectedQueue.map(row=>row.commands));expect(accepted.queue.map(row=>row.changes)).toEqual(expectedQueue.map(row=>row.changes));expect(await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes())).toEqual(originalImages);expect(await server.purchaseCount([invoice.id])).toBe(outcome==='replaced'?1:0);
  for(const table of ['stockItems','stockMoves','sales','creditEntries'] as const)expect(accepted.backup.tables[table],table).toEqual(original.backup.tables[table]);for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...owner.backup.tables[table]].sort((a,b)=>a.id.localeCompare(b.id))),table).toBe(syncDownloadToken([...accepted.backup.tables[table]].sort((a,b)=>a.id.localeCompare(b.id))));}expect(accepted.backup.tables.events.find(event=>event.id===original.queue[0].commands[0].id)?.command).toBe('sync.resolve');
 }finally{await context.close();}
});
test('an account change after invoice SQL completion retains the source until the original account recovers its genuine outcome',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);await context.setOffline(true);const invoice=await manager.evaluate(()=>window.miseSyncApplyTest.queuePurchase()),original=await inspect(manager);await changeCurrency(page,'USD');await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await changeCurrency(page,'BDT');await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();const panel=manager.getByRole('region',{name:'Saved invoice review'});await panel.getByRole('button',{name:'Check current invoice values',exact:true}).click();const held=server.calls.heldCommands;server.holdNextResolutionReply();await panel.getByRole('button',{name:'Apply reviewed invoice action',exact:true}).click();await expect.poll(()=>server.calls.heldCommands).toBe(held+1);expect(await server.purchaseCount([invoice.id])).toBe(1);await installSyncApplyFixture(manager);await manager.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(1));server.releaseCommandReply();await expect(manager.getByRole('heading',{name:'Choose an outlet and member',exact:true})).toBeVisible();const changed=await inspect(manager);expect(changed.queue).toEqual(original.queue);expect(changed.backup.tables).toEqual(original.backup.tables);expect(changed.binding).toEqual(original.binding);expect(changed.purchaseReviews[0].choice).toEqual({outcome:'replaced'});expect(changed.operator?.phase).toBe('locked');
  await manager.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(2));await manager.evaluate(()=>window.miseSyncApplyTest.reselect());await manager.evaluate(()=>window.miseSyncApplyTest.cycle());const resumed=await inspect(manager);expect(resumed.queue[0].status).toBe('accepted');expect(resumed.queue[0].receipts[0]).toMatchObject({type:'command.resolved',outcome:'replaced'});await manager.goto('app/settings/sync?flags=cloudSync');await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();await panel.getByRole('button',{name:'Check saved outcome',exact:true}).click();await expect(panel.locator('.review-outcome')).toContainText('reviewed invoice action was recorded');await installSyncApplyFixture(manager);const accepted=await inspect(manager);expect(accepted.queue[0].commands).toEqual(original.queue[0].commands);expect(accepted.queue[0].changes).toEqual(original.queue[0].changes);expect(await server.purchaseCount([invoice.id])).toBe(1);
 }finally{server.releaseCommandReply();await context.close();}
});

test('stopping an invoice decision after SQL completion preserves its choice and recovers the actual outcome',async({page,browser})=>{
 test.setTimeout(120000);
 await initialize(page,1);
 const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);
  await context.setOffline(true);
  const invoice=await manager.evaluate(()=>window.miseSyncApplyTest.queuePurchase()),original=await inspect(manager);
  await changeCurrency(page,'USD');
  await context.setOffline(false);
  await manager.evaluate(()=>window.miseSyncApplyTest.cycle());
  await changeCurrency(page,'BDT');
  await installRealtimeFixture(manager,server.config(2).jwt);
  await manager.goto('app/settings/sync?flags=cloudSync');
  await manager.getByRole('button',{name:'Review saved invoice',exact:true}).click();
  const panel=manager.getByRole('region',{name:'Saved invoice review'});
  await panel.getByRole('button',{name:'Check current invoice values',exact:true}).click();
  const held=server.calls.heldCommands;
  server.holdNextResolutionReply();
  await panel.getByRole('button',{name:'Apply reviewed invoice action',exact:true}).click();
  await expect.poll(()=>server.calls.heldCommands).toBe(held+1);
  expect(await server.purchaseCount([invoice.id])).toBe(1);
  await panel.getByRole('button',{name:'Stop invoice check',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('unconfirmed');
  server.releaseCommandReply();
  await installSyncApplyFixture(manager);
  const stopped=await inspect(manager);
  expect(stopped.queue).toEqual(original.queue);
  expect(stopped.backup.tables).toEqual(original.backup.tables);
  expect(stopped.purchaseReviews[0]).toMatchObject({phase:'unconfirmed',choice:{outcome:'replaced'}});
  await panel.getByRole('button',{name:'Check saved outcome',exact:true}).click();
  await expect(panel.locator('.review-outcome')).toContainText('reviewed invoice action was recorded');
  await expect(manager.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});
  expect(await server.purchaseCount([invoice.id])).toBe(1);
 }finally{server.releaseCommandReply();await context.close();}
});
