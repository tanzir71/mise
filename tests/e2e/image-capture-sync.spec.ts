import {expect,test,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {startConvergenceServer} from '../sync-convergence-server';
// @ts-expect-error The isolated native installer is JavaScript, never shipped application code.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';

test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeAll(async()=>{server=await startConvergenceServer();});
test.afterAll(async()=>{await server?.close();});
async function initialize(page:Page,n:1|2){
 await page.goto('app/');await installSyncApplyFixture(page);
 await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));
 await page.goto('app/?flags=ocr');await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 await installSyncApplyFixture(page);
}
async function install(page:Page){await installSyncApplyFixture(page);}
test('a reviewed image invoice and complete undo converge through scoped SQL, including a lost final purchase reply',async({page,browser})=>{
 test.setTimeout(90_000);await initialize(page,1);const other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  await initialize(manager,2);await page.goto('app/inbox/capture/invoice');
  await page.getByLabel('Choose image',{exact:true}).setInputFiles(resolve('tests/fixtures/ocr/invoice-01.png'));
  await page.getByRole('button',{name:'Save image and read',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add to stock and purchases',exact:true})).toBeVisible();
  await install(page);await page.evaluate(()=>window.miseSyncApplyTest.deliver());
  const source=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(source.queue.at(-1)?.status).toBe('accepted');
  await page.getByLabel('I checked the invoice and counted these received quantities',{exact:true}).check();
  await page.getByRole('button',{name:'Add to stock and purchases',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Invoice recorded',exact:true})).toBeVisible();
  const original=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),group=original.queue.at(-1)!;
  expect(group.status).toBe('pending');expect(group.commands.map(c=>c.type)).toEqual(['stock.create','stock.create','stock.batch','purchase.record']);
  const purchase=original.backup.tables.purchases.find(p=>!source.backup.tables.purchases.some(before=>before.id===p.id))!;
  expect(original.backup.tables.inboxItems).toEqual(source.backup.tables.inboxItems);
  server.loseNextCommand('purchase.record');await expect(page.evaluate(()=>window.miseSyncApplyTest.deliver())).rejects.toThrow(/local copy|same command/);
  const partial=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(partial.queue.at(-1)?.receipts).toHaveLength(3);expect(partial.queue.at(-1)?.status).toBe('pending');expect(await server.purchaseCount([purchase.id])).toBe(1);
  await page.reload();await expect(page.getByRole('heading',{name:'Invoice recorded',exact:true})).toBeVisible();await install(page);
  await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());await manager.evaluate(()=>window.miseSyncApplyTest.pull());
  expect(await server.purchaseCount([purchase.id])).toBe(1);
  const accepted=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),received=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  for(const name of ['stockItems','stockMoves','purchases','events','inboxItems'] as const)expect(syncDownloadToken([...accepted.backup.tables[name]].sort((a,b)=>a.id.localeCompare(b.id)))).toBe(syncDownloadToken([...received.backup.tables[name]].sort((a,b)=>a.id.localeCompare(b.id))));
  expect(accepted.queue.at(-1)?.status).toBe('accepted');expect(accepted.queue.at(-1)?.receipts).toHaveLength(4);expect(accepted.imageSizes).toEqual(received.imageSizes);
  // Canonical application changes source revisions: reopen a real proof from the saved image.
  await page.reload();await expect(page.getByRole('heading',{name:'Invoice recorded',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Undo invoice and stock receipt',exact:true}).click();await expect(page.getByRole('heading',{name:'Invoice undone',exact:true})).toBeVisible();await install(page);
  const undo=await page.evaluate(()=>window.miseSyncApplyTest.inspect());expect(undo.queue.at(-1)?.commands.map(c=>c.type)).toEqual(['purchase.undo','stock.undo','stock.undo','stock.undo']);
  await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());await manager.evaluate(()=>window.miseSyncApplyTest.pull());
  const a=await page.evaluate(()=>window.miseSyncApplyTest.inspect()),b=await manager.evaluate(()=>window.miseSyncApplyTest.inspect());
  for(const name of ['stockItems','stockMoves','purchases','events','inboxItems'] as const)expect(syncDownloadToken([...a.backup.tables[name]].sort((x,y)=>x.id.localeCompare(y.id)))).toBe(syncDownloadToken([...b.backup.tables[name]].sort((x,y)=>x.id.localeCompare(y.id))));
  expect(a.backup.tables.purchases.find(p=>p.id===purchase.id)?.voidedAt).toBeDefined();expect(a.queue.every(q=>q.status==='accepted')).toBe(true);
 }finally{await other.close();}
});
