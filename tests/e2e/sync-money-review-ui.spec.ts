import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
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
async function initialize(page:Page,n:1|2){
 await page.goto('app/');await installSyncApplyFixture(page);
 await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));
 await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 await installSyncApplyFixture(page);
}
for(const outcome of ['replaced','withdrawn'] as const)test(`the money review interface ${outcome} an offline credit sale with exact consent, lost reply recovery and two-browser convergence`,async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);
 const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await page.context().setOffline(true);await other.setOffline(true);
  const originalSale=await manager.evaluate(()=>window.miseSyncApplyTest.credit('800'));
  await manager.evaluate(()=>window.miseSyncApplyTest.cash('5'));
  const original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect()),later=original.queue[1].commands[0];
  let expectedQueue=original.queue;
  if(later.type!=='sale.record')throw Error('Expected later original cash');
  await page.evaluate(()=>window.miseSyncApplyTest.credit('700'));
  await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());
  expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).syncSession?.problem).toBe('review');
  await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');
  await manager.getByRole('button',{name:'Review saved money action',exact:true}).click();
  const panel=manager.getByRole('region',{name:'Saved money review'}),apply=panel.getByRole('button',{name:'Apply reviewed money action',exact:true}),consent=panel.getByRole('checkbox',{name:'Allow this credit sale above the checked limit',exact:true});
  await panel.getByRole('button',{name:'Check money values',exact:true}).click();
  await expect(consent).toBeVisible();await expect(consent).not.toBeChecked();await expect(apply).toBeDisabled();
  await expect(panel.locator('.order-review-comparison')).toContainText(formatMoney(originalSale.amount,'BDT'));
  await expect(panel.getByRole('link',{name:'Open khata for manual changes',exact:true})).toHaveAttribute('href',new RegExp('/khata/'+originalSale.customerId+'\\?currency=BDT$'));
  if(outcome==='replaced'){
   await consent.check();await panel.getByRole('button',{name:'Check money values again',exact:true}).click();
   await expect(consent).not.toBeChecked();await expect(apply).toBeDisabled();
   await consent.check();await expect(apply).toBeEnabled();
   await page.evaluate(()=>window.miseSyncApplyTest.credit('10'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
   await apply.click();await expect(panel.getByText('The shop values changed. Review the updated comparison before choosing again.',{exact:true})).toBeVisible();
   await expect(consent).not.toBeChecked();await expect(apply).toBeDisabled();expect(await server.financialCount([originalSale.id])).toBe(0);await consent.check();
  }else{
   for(const width of [360,390,768,1024,1440]){
    await manager.setViewportSize({width,height:1000});
    expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect((await new AxeBuilder({page:manager}).include('.money-action-review').analyze()).violations).toEqual([]);
    await panel.screenshot({path:test.info().outputPath(`money-review-${width}.png`),style:'.app-bottom-nav,.phone-app-header,.app-skip{visibility:hidden}'});
   }
  }
  expect((await new AxeBuilder({page:manager}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
  server.loseNextResolution();await (outcome==='replaced'?apply:panel.getByRole('button',{name:'Withdraw saved money action',exact:true})).click();
  await expect(panel.getByRole('alert')).toContainText('unconfirmed');await installSyncApplyFixture(manager);
  const lost=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(lost.queue).toEqual(original.queue);expect(lost.backup.tables).toEqual(original.backup.tables);
  expect(lost.moneyReviews[0]).toMatchObject({phase:'unconfirmed',choice:{outcome,confirmCredit:outcome==='replaced'}});expect(lost.moneyReviews[0].quote).not.toHaveProperty('token');
  expect(await server.financialCount([originalSale.id])).toBe(outcome==='replaced'?1:0);
  await other.setOffline(true);await manager.reload();await manager.getByRole('button',{name:'Review saved money action',exact:true}).click();
  await expect(panel.getByText(/Your choice to .* is saved, but its server outcome is unconfirmed/)).toBeVisible();
  await expect(consent).toBeChecked({checked:outcome==='replaced'});
  await expect(panel.getByRole('button',{name:'Check saved money outcome',exact:true})).toBeDisabled();
  await installSyncApplyFixture(manager);expect((await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue).toEqual(original.queue);
  if(outcome==='withdrawn'){
   const returnUrl=manager.url();await panel.getByRole('link',{name:'Download a JSON backup',exact:true}).click();
   await expect(manager.locator('.exports-page')).toHaveAttribute('aria-busy','false');
   const sheet=manager.getByRole('dialog',{name:'Export',exact:true});if(await sheet.isVisible())await sheet.getByRole('button',{name:'Backup and restore',exact:true}).click();
   const downloading=manager.waitForEvent('download');await manager.getByRole('button',{name:'Download JSON backup',exact:true}).click();
   const downloaded=await downloading,bytes=await readFile((await downloaded.path())!,'utf8'),backup=JSON.parse(bytes);
   for(const table of backupTableNames)if(table!=='events')expect(backup.tables[table],table).toEqual(original.backup.tables[table]);
   for(const event of original.backup.tables.events)expect(backup.tables.events).toContainEqual(event);
   expect(Object.keys(backup.tables)).toHaveLength(22);expect(bytes).not.toMatch(/apiUrl|publishableKey|access_token|refresh_token|Authorization|moneyReviews/);
   await manager.goto(returnUrl);await manager.getByRole('button',{name:'Review saved money action',exact:true}).click();await installSyncApplyFixture(manager);
   expectedQueue=(await manager.evaluate(()=>window.miseSyncApplyTest.inspect())).queue;expect(expectedQueue.slice(0,original.queue.length)).toEqual(original.queue);
  }
  await other.setOffline(false);await expect(panel.getByRole('button',{name:'Check saved money outcome',exact:true})).toBeEnabled({timeout:20000});
  await panel.getByRole('button',{name:'Check saved money outcome',exact:true}).click();
  await expect(panel.locator('.review-outcome')).toContainText(outcome==='replaced'?'reviewed replacement was recorded':'saved action was withdrawn');
  // Acknowledged receipts alone do not prove canonical application finished.
  await expect(manager.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});
  await page.evaluate(()=>window.miseSyncApplyTest.pull());
  const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  expect(b.moneyReviews[0].phase).toBe('confirmed');expect(b.queue.every(row=>row.status==='accepted')).toBe(true);expect(b.queue.map(row=>row.commands)).toEqual(expectedQueue.map(row=>row.commands));expect(b.queue.map(row=>row.changes)).toEqual(expectedQueue.map(row=>row.changes));
  expect(b.backup.tables.inboxItems).toEqual(original.backup.tables.inboxItems);expect(await server.financialCount([originalSale.id,later.saleId])).toBe(outcome==='replaced'?2:1);
  for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
  expect(b.backup.tables.events.find(event=>event.id===original.queue[0].commands[0].id)?.command).toBe('sync.resolve');
 }finally{await page.context().setOffline(false);await other.close();}
});
test('a real account change after SQL replacement keeps the source unacknowledged and the original account recovers its actual outcome',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await other.setOffline(true);const sale=await manager.evaluate(()=>window.miseSyncApplyTest.credit('800'));
  const original=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());await page.evaluate(()=>window.miseSyncApplyTest.credit('700'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await other.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');
  await manager.getByRole('button',{name:'Review saved money action',exact:true}).click();const panel=manager.getByRole('region',{name:'Saved money review'});
  await panel.getByRole('button',{name:'Check money values',exact:true}).click();await panel.getByRole('checkbox').check();
  const held=server.calls.heldCommands;server.holdNextResolutionReply();await panel.getByRole('button',{name:'Apply reviewed money action',exact:true}).click();
  await expect.poll(()=>server.calls.heldCommands).toBe(held+1);expect(await server.financialCount([sale.id])).toBe(1);await installSyncApplyFixture(manager);
  await manager.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(1));server.releaseCommandReply();
  await expect(manager.getByRole('heading',{name:'Choose an outlet and member',exact:true})).toBeVisible();
  const changed=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(changed.queue).toEqual(original.queue);expect(changed.backup.tables).toEqual(original.backup.tables);expect(changed.binding).toEqual(original.binding);expect(changed.moneyReviews[0].choice).toEqual({outcome:'replaced',confirmCredit:true});expect(changed.operator?.phase).toBe('locked');
  await manager.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(2));await manager.evaluate(()=>window.miseSyncApplyTest.reselect());await manager.evaluate(()=>window.miseSyncApplyTest.cycle());
  const resumed=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(resumed.queue[0].status).toBe('accepted');expect(resumed.queue[0].receipts[0]).toMatchObject({type:'command.resolved',outcome:'replaced'});
  await manager.goto('app/settings/sync?flags=cloudSync');await manager.getByRole('button',{name:'Review saved money action',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Check saved money outcome',exact:true})).toBeVisible();await panel.getByRole('button',{name:'Check saved money outcome',exact:true}).click();await expect(panel.locator('.review-outcome')).toContainText('reviewed replacement was recorded');
  await installSyncApplyFixture(manager);const accepted=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());expect(accepted.queue[0].status).toBe('accepted');expect(accepted.queue[0].commands).toEqual(original.queue[0].commands);expect(accepted.queue[0].changes).toEqual(original.queue[0].changes);expect(await server.financialCount([sale.id])).toBe(1);
 }finally{server.releaseCommandReply();await page.context().setOffline(false);await other.close();}
});
