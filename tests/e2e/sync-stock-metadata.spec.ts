import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startConvergenceServer} from '../sync-convergence-server';
import {installRealtimeFixture} from '../realtime-browser-fixture';
import {backupTableNames} from '../../packages/core/backup-tables';
import {syncDownloadToken} from '../../packages/core/sync-download';
import {stockQuantityText} from '../../packages/core/stock-quantity';
// @ts-expect-error Isolated native fixture installer is JavaScript, not product code.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';

test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeEach(async()=>{server=await startConvergenceServer();});
test.afterEach(async()=>{await server?.close();});
const inspect=(page:Page)=>page.evaluate(()=>window.miseSyncApplyTest.inspect());
async function initialize(page:Page,n:1|2){
 await page.goto('app/');await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));
 await page.goto('app/stock');await expect(page.locator('.stock-page')).toHaveAttribute('aria-busy','false');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 await installSyncApplyFixture(page);
}
async function rename(page:Page,name:string,next:string){
 await page.getByRole('button',{name:'Edit '+name,exact:false}).click();const form=page.getByRole('dialog',{name:'Edit stock item',exact:true});await form.getByLabel('Name',{exact:true}).fill(next);await form.getByRole('button',{name:'Save stock item',exact:true}).click();await expect(form).not.toBeVisible();
}
async function received(page:Page,name:string,unit:string){
 await page.getByRole('button',{name:'Edit on hand '+name,exact:false}).click();const form=page.getByRole('dialog',{name:'Update stock',exact:true});await form.getByRole('combobox',{name:'Action',exact:true}).selectOption('received');await form.getByLabel('Quantity ('+unit+')',{exact:true}).fill('3');await form.getByRole('button',{name:'Save stock change',exact:true}).click();await expect(form).not.toBeVisible();
}
async function enableAutomaticSync(page:Page){
 await installRealtimeFixture(page,server.config(2).jwt);await page.goto('app/settings/sync?flags=cloudSync');await page.getByRole('button',{name:'Turn on sync',exact:true}).click();await expect(page.getByRole('link',{name:'Sync: Synced',exact:true})).toBeVisible({timeout:20000});await page.goto('app/stock');await expect(page.locator('.stock-page')).toHaveAttribute('aria-busy','false');
}
async function converge(owner:Page,manager:Page){
 await owner.evaluate(()=>window.miseSyncApplyTest.pull());await installSyncApplyFixture(manager);const a=await inspect(owner),b=await inspect(manager);
 for(const table of backupTableNames){if(table==='members')continue;expect(syncDownloadToken([...a.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))),table).toBe(syncDownloadToken([...b.backup.tables[table]].sort((x,y)=>x.id.localeCompare(y.id))));}
 expect(b.queue.every(row=>row.status==='accepted')).toBe(true);return b;
}

test('actual stock forms and automatic sync merge the last metadata edit over a newer description and receipt without replacing the physical amount',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);const baseline=await inspect(manager),item=baseline.backup.tables.stockItems.find(row=>row.archivedAt===undefined)!;
  await context.setOffline(true);await rename(manager,item.name,'Manager original description · বাংলা');const original=await inspect(manager),hashes=await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes());expect(original.queue[0].commands[0]).toMatchObject({type:'stock.update',moveId:null,input:{onHand:item.onHand}});
  await rename(page,item.name,'Owner current description');await received(page,'Owner current description',item.unit);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());
  await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.pull());const projected=await inspect(manager);expect(projected.queue).toEqual(original.queue);expect(projected.backup.tables.stockItems.find(row=>row.id===item.id)).toMatchObject({name:'Manager original description · বাংলা',onHand:item.onHand+3});expect(await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes())).toEqual(hashes);
  await enableAutomaticSync(manager);
  const final=await converge(page,manager),command=original.queue[0].commands[0],saved=final.backup.tables.stockItems.find(row=>row.id===item.id)!;
  expect(final.queue.map(row=>row.commands)).toEqual(original.queue.map(row=>row.commands));expect(final.queue.map(row=>row.changes)).toEqual(original.queue.map(row=>row.changes));expect(saved).toMatchObject({name:'Manager original description · বাংলা',onHand:item.onHand+3,revision:item.revision+3});
  expect(final.backup.tables.stockMoves).toHaveLength(baseline.backup.tables.stockMoves.length+1);expect(final.backup.tables.events.find(row=>row.id===command.id)).toMatchObject({before:{name:'Owner current description',onHand:item.onHand+3},after:{item:{name:'Manager original description · বাংলা',onHand:item.onHand+3}}});
  for(const table of ['sales','creditEntries','purchases'] as const)expect(final.backup.tables[table]).toEqual(baseline.backup.tables[table]);expect(server.diagnostics).toEqual([]);
  await expect(manager.getByRole('button',{name:'Edit on hand Manager original description · বাংলা',exact:false})).toHaveText(stockQuantityText(item.onHand+3));
  for(const width of [360,390,768,1024,1440]){await manager.setViewportSize({width,height:900});expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page:manager}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical'),String(width)).toEqual([]);}
 }finally{await context.close();}
});

test('a lost actual metadata reply keeps its original queue and images through offline reload, then recovers one later-revision receipt',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);const baseline=await inspect(manager),item=baseline.backup.tables.stockItems.find(row=>row.archivedAt===undefined)!;
  await context.setOffline(true);await rename(manager,item.name,'Saved metadata after interruption');const original=await inspect(manager),hashes=await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes());
  await received(page,item.name,item.unit);await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.pull());
  server.loseNextCommand();await expect(manager.evaluate(()=>window.miseSyncApplyTest.deliver())).rejects.toThrow(/local copy|same command/);expect((await inspect(manager)).queue).toEqual(original.queue);
  await context.setOffline(true);await manager.reload();await expect(manager.getByRole('button',{name:'Edit on hand Saved metadata after interruption',exact:false})).toHaveText(stockQuantityText(item.onHand+3));await installSyncApplyFixture(manager);expect((await inspect(manager)).queue).toEqual(original.queue);expect(await manager.evaluate(()=>window.miseSyncApplyTest.imageHashes())).toEqual(hashes);
  await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.deliver());await manager.evaluate(()=>window.miseSyncApplyTest.pull());const final=await converge(page,manager),command=original.queue[0].commands[0];
  expect(final.queue[0].receipts[0]).toMatchObject({id:command.id,type:'stock.update',results:[{stockItemId:item.id,moveId:null,revision:item.revision+2,onHand:item.onHand+3}]});expect(final.queue[0].commands).toEqual(original.queue[0].commands);expect(final.queue[0].changes).toEqual(original.queue[0].changes);expect(final.backup.tables.events.filter(row=>row.id===command.id)).toHaveLength(1);expect(final.backup.tables.stockMoves).toHaveLength(baseline.backup.tables.stockMoves.length+1);expect(server.diagnostics).toEqual([]);
 }finally{await context.close();}
});

test('a saved metadata edit remains archived after a concurrent archive and active name reuse, without an implicit restore or movement',async({page,browser})=>{
 test.setTimeout(120000);await initialize(page,1);const context=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await context.newPage();
 try{
  await initialize(manager,2);const baseline=await inspect(manager),item=baseline.backup.tables.stockItems.find(row=>row.archivedAt===undefined)!;
  await context.setOffline(true);await rename(manager,item.name,'Reused description');const original=await inspect(manager);
  await page.getByRole('button',{name:'Edit '+item.name,exact:false}).click();await page.getByRole('dialog',{name:'Edit stock item',exact:true}).getByRole('button',{name:'Archive stock item',exact:true}).click();
  await page.locator('.stock-heading').getByRole('button',{name:'Add stock item',exact:true}).click();const form=page.getByRole('dialog',{name:'New stock item',exact:true});await form.getByLabel('Name',{exact:true}).fill('Reused description');await form.getByLabel('Unit',{exact:true}).fill(item.unit);await form.getByLabel('On hand',{exact:true}).fill('1');await form.getByLabel('Target (par)',{exact:true}).fill('3');await form.getByLabel('Pack size',{exact:true}).fill('1');await form.getByRole('button',{name:'Save stock item',exact:true}).click();await expect(form).not.toBeVisible();
  await page.evaluate(()=>window.miseSyncApplyTest.deliver());await page.evaluate(()=>window.miseSyncApplyTest.pull());const archived=(await inspect(page)).backup.tables.stockItems.find(row=>row.id===item.id)!;
  await context.setOffline(false);await manager.evaluate(()=>window.miseSyncApplyTest.pull());const projected=await inspect(manager);expect(projected.queue).toEqual(original.queue);expect(projected.backup.tables.stockItems.find(row=>row.id===item.id)).toMatchObject({name:'Reused description',archivedAt:archived.archivedAt,onHand:item.onHand});
  await enableAutomaticSync(manager);const final=await converge(page,manager),saved=final.backup.tables.stockItems.find(row=>row.id===item.id)!;
  expect(saved).toMatchObject({name:'Reused description',archivedAt:archived.archivedAt,onHand:item.onHand,revision:item.revision+2});expect(saved.activeKey).toBeUndefined();expect(final.backup.tables.stockItems.filter(row=>row.name==='Reused description'&&row.archivedAt===undefined)).toHaveLength(1);expect(final.backup.tables.stockMoves).toHaveLength(baseline.backup.tables.stockMoves.length+1);expect(final.queue[0].commands).toEqual(original.queue[0].commands);
  await manager.getByRole('button',{name:'Archived',exact:true}).click();await expect(manager.locator(`[data-stock-id="${item.id}"]`)).toContainText('Reused description');await expect(manager.locator(`[data-stock-id="${item.id}"]`).getByRole('button',{name:'Restore',exact:true})).toBeVisible();expect(server.diagnostics).toEqual([]);
 }finally{await context.close();}
});
