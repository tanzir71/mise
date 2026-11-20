import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
import {backupTableNames} from '../../packages/core/backup-tables';
import {startConvergenceServer} from '../sync-convergence-server';
import {installRealtimeFixture} from '../realtime-browser-fixture';
// @ts-expect-error Isolated browser fixture installer, not application source.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';

type State=Awaited<ReturnType<Window['miseSyncApplyTest']['inspect']>>;
async function initialize(page:Page,config:Parameters<Window['miseSyncApplyTest']['initialize']>[0]){
 await page.goto('app/');await installSyncApplyFixture(page);
 await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),config);
 await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 await installSyncApplyFixture(page);
}
const inspect=(page:Page)=>page.evaluate(()=>window.miseSyncApplyTest.inspect());
function expectConvergence(manager:State,owner:State,ownerId:string){
 const {members:managerMembers,...managerTables}=manager.backup.tables,{members:ownerMembers,...ownerTables}=owner.backup.tables;
 expect(managerTables).toEqual(ownerTables);
 expect(managerMembers).toEqual(ownerMembers.map(member=>{if(member.id!==ownerId)return member;const historical={...member,active:false};delete historical.phone;return historical;}));
}

test('an offline BDT invoice is retained after a live USD profile change, including its original images and downloadable backup',async({page,browser})=>{
 test.setTimeout(120000);
 const server=await startConvergenceServer(),context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(page,server.config(1));await initialize(manager,server.config(2));await context.setOffline(true);
  const invoice=await manager.evaluate(()=>window.miseSyncApplyTest.queuePurchase());await manager.evaluate(()=>window.miseSyncApplyTest.captureImage());
  const original=await inspect(manager),command=original.queue[0].commands[0];
  expect(command.type).toBe('purchase.record');expect(invoice).toMatchObject({currency:'BDT',total:30003});
  await page.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());
  const rejected=await inspect(manager);expect(rejected.queue).toEqual(original.queue);expect(rejected.backup.tables).toEqual(original.backup.tables);expect(rejected.imageSizes).toEqual(original.imageSizes);
  expect(rejected.actionReviews).toHaveLength(1);expect(rejected.actionReviews[0]).toMatchObject({status:409,commandId:command.id});expect(await server.purchaseCount([invoice.id])).toBe(0);
  await installRealtimeFixture(manager,server.config(2).jwt);await manager.goto('app/settings/sync?flags=cloudSync');
  await expect(manager.getByText('Some saved work needs review. Your local records and downloaded pages are kept.')).toBeVisible();
  await expect(manager.getByRole('button',{name:'Review saved order action',exact:true})).toHaveCount(0);await expect(manager.getByRole('button',{name:'Review saved money action',exact:true})).toHaveCount(0);
  expect((await new AxeBuilder({page:manager}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
  await context.setOffline(true);await manager.reload();await expect(manager.getByRole('link',{name:'Download a JSON backup',exact:true})).toBeVisible();
  const returnUrl=manager.url();await manager.getByRole('link',{name:'Download a JSON backup',exact:true}).click();
  await expect(manager.locator('.exports-page')).toHaveAttribute('aria-busy','false');
  const sheet=manager.getByRole('dialog',{name:'Export',exact:true});if(await sheet.isVisible())await sheet.getByRole('button',{name:'Backup and restore',exact:true}).click();
  const download=manager.waitForEvent('download');await manager.getByRole('button',{name:'Download JSON backup',exact:true}).click();const file=await download,path=await file.path();expect(path).toBeTruthy();
  const backup=JSON.parse(await readFile(path!,'utf8'));for(const table of backupTableNames)if(table!=='events')expect(backup.tables[table],table).toEqual(original.backup.tables[table]);for(const event of original.backup.tables.events)expect(backup.tables.events).toContainEqual(event);expect(Object.keys(backup.tables)).toHaveLength(21);expect(JSON.stringify(backup)).not.toMatch(/apiUrl|publishableKey|access_token|refresh_token|Authorization/);
  await manager.goto(returnUrl);await installSyncApplyFixture(manager);const reloaded=await inspect(manager);expect(reloaded.queue.slice(0,original.queue.length)).toEqual(original.queue);for(const table of backupTableNames)if(table!=='events')expect(reloaded.backup.tables[table],table).toEqual(original.backup.tables[table]);for(const event of original.backup.tables.events)expect(reloaded.backup.tables.events).toContainEqual(event);expect(reloaded.imageSizes).toEqual(original.imageSizes);expect(reloaded.actionReviews).toEqual(rejected.actionReviews);
  await manager.reload();await installSyncApplyFixture(manager);const reopened=await inspect(manager);expect(reopened.backup.tables).toEqual(reloaded.backup.tables);expect(reopened.queue).toEqual(reloaded.queue);expect(reopened.imageSizes).toEqual(reloaded.imageSizes);
 }finally{await context.close();await server.close();}
});

test('a historical BDT invoice and its offline undo converge once under a later USD profile',async({page,browser})=>{
 test.setTimeout(120000);
 const server=await startConvergenceServer(),context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(page,server.config(1));await initialize(manager,server.config(2));
  const invoice=await manager.evaluate(()=>window.miseSyncApplyTest.queuePurchase());await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  const created=await inspect(manager);expect(created.queue.every(row=>row.status==='accepted')).toBe(true);expect(await server.purchaseCount([invoice.id])).toBe(1);
  await context.setOffline(true);await manager.evaluate(id=>window.miseSyncApplyTest.undoOriginalPurchase(id),invoice.id);await manager.evaluate(()=>window.miseSyncApplyTest.captureImage());const original=await inspect(manager);
  await page.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.cycle());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  const accepted=await inspect(manager);expect(accepted.queue.every(row=>row.status==='accepted')).toBe(true);expect(accepted.actionReviews).toEqual([]);
  expect(accepted.queue.map(row=>row.commands)).toEqual(original.queue.map(row=>row.commands));expect(accepted.queue.map(row=>row.changes)).toEqual(original.queue.map(row=>row.changes));
  expect(accepted.backup.tables.purchases.filter(p=>p.id===invoice.id)).toHaveLength(1);expect(accepted.backup.tables.purchases.find(p=>p.id===invoice.id)).toMatchObject({currency:'BDT',total:30003,voidedAt:expect.any(Number)});
  expect(accepted.backup.tables.outlets.find(o=>o.id===invoice.outletId)?.currency).toBe('USD');expect(accepted.imageSizes).toEqual(original.imageSizes);expectConvergence(accepted,await inspect(page),server.config(1).actorId);
  expect(accepted.backup.tables.events.filter(e=>e.command==='purchase.record'&&e.after&&typeof e.after==='object'&&'id'in e.after&&e.after.id===invoice.id)).toHaveLength(1);
  expect(accepted.backup.tables.events.filter(e=>e.command==='purchase.undo'&&e.undoOf===invoice.eventId)).toHaveLength(1);
  await manager.evaluate(()=>window.miseSyncApplyTest.cycle());expect((await inspect(manager)).queue).toEqual(accepted.queue);expect(await server.purchaseCount([invoice.id])).toBe(1);
  await context.setOffline(true);await manager.reload();await installSyncApplyFixture(manager);const reopened=await inspect(manager);expect(reopened.backup.tables).toEqual(accepted.backup.tables);expect(reopened.queue).toEqual(accepted.queue);expect(reopened.imageSizes).toEqual(original.imageSizes);
 }finally{await context.close();await server.close();}
});
