import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
import {backupTableNames} from '../../packages/core/backup-tables';
import {startConvergenceServer} from '../sync-convergence-server';
import {installRealtimeFixture} from '../realtime-browser-fixture';
// @ts-expect-error Isolated browser fixture; never part of the shipped app.
import {installSyncApplyFixture} from '../fixtures/install-sync-apply.mjs';

test.describe.configure({mode:'serial'});
let server:Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeAll(async()=>{server=await startConvergenceServer({originalOwner:true});});
test.afterAll(async()=>{await server?.close();});
async function synced(page:Page){
 try{
  await installSyncApplyFixture(page);
  await expect.poll(async()=>{
   const state=await inspect(page),hash=state.base?.version===2?state.base.applicationHash:null,
    current=state.applications.find(application=>application.hash===hash),
    covered=new Set(current?.covered.map(intent=>intent.id));
   return state.queue.every(row=>row.status==='accepted'&&row.commands.every(command=>covered.has(command.id)))&&
    await page.getByRole('link',{name:'Sync: Synced',exact:true}).isVisible();
  },{timeout:30000}).toBe(true);
 }
 catch(error){await installSyncApplyFixture(page);const value=await inspect(page);console.log(JSON.stringify({path:new URL(page.url()).pathname,session:value.syncSession,operator:value.operator,binding:value.binding,queue:value.queue.map(row=>({id:row.id,status:row.status,commands:row.commands.map(command=>command.type),receipts:row.receipts})),calls:server.calls,diagnostics:server.diagnostics}));throw error;}
}
async function initialize(page:Page,n:1|2){
 const socket=await installRealtimeFixture(page,server.config(n).jwt);await page.goto('app/');await installSyncApplyFixture(page);
 await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(n));await page.goto('app/settings/sync?flags=cloudSync');
 await page.getByRole('button',{name:'Turn on sync',exact:true}).click();await synced(page);await installSyncApplyFixture(page);return socket;
}
async function inspect(page:Page){return page.evaluate(()=>window.miseSyncApplyTest.inspect());}
async function openRecovery(page:Page){
 await page.goto('app/settings/sync?flags=cloudSync');await expect(page.getByRole('button',{name:'Review outlet access',exact:true})).toBeVisible({timeout:20000});
 await page.getByRole('button',{name:'Review outlet access',exact:true}).click();await expect(page.getByRole('heading',{name:'Review this outlet’s access',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Check current access',exact:true})).toBeEnabled({timeout:20000});
}
async function review(page:Page){await page.getByRole('button',{name:'Check current access',exact:true}).click();await expect(page.getByRole('button',{name:'Apply reviewed changes',exact:true})).toBeEnabled({timeout:30000});}

test('two actual browsers recover a changed epoch with accepted cash, offline actions and complete images intact',async({page,browser})=>{
 test.setTimeout(150000);const ownerSocket=await initialize(page,1),other=await browser.newContext({baseURL:test.info().project.use.baseURL}),manager=await other.newPage();
 try{
  const managerSocket=await initialize(manager,2);await page.evaluate(()=>window.miseSyncApplyTest.cash('53'));await synced(page);managerSocket.notify();
  await expect.poll(async()=>(await inspect(manager)).backup.tables.sales.some(row=>row.amount===5300)).toBe(true);
  await page.context().setOffline(true);await other.setOffline(true);
  await page.evaluate(async()=>{await window.miseSyncApplyTest.cash('59');await window.miseSyncApplyTest.captureImage();});await manager.evaluate(()=>window.miseSyncApplyTest.cash('61'));
  const before=await inspect(page),managerBefore=await inspect(manager),commands=server.calls.commands;await server.changeEpoch();
  await page.context().setOffline(false);await other.setOffline(false);await openRecovery(page);
  expect(server.calls.commands).toBe(commands);server.loseNextPage();await page.getByRole('button',{name:'Check current access',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();await installSyncApplyFixture(page);const paused=await inspect(page),saved=paused.recoveries.filter(row=>row.kind==='session').find(row=>row.id==='active');
  expect(paused.backup.tables).toEqual(before.backup.tables);expect(paused.queue).toEqual(before.queue);expect(paused.binding).toEqual(before.binding);
  await page.reload();await installSyncApplyFixture(page);await page.getByRole('button',{name:'Resume review',exact:true}).click();await expect(page.getByRole('button',{name:'Apply reviewed changes',exact:true})).toBeEnabled({timeout:30000});
  const resumed=await inspect(page);expect(resumed.recoveries.filter(row=>row.kind==='session').find(row=>row.id==='active')?.readId).toBe(saved?.readId);
  for(const width of [360,390,768,1024,1440]){
   await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   expect((await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='critical'||v.impact==='serious')).toEqual([]);
   if([360,768,1440].includes(width))await test.info().attach('scope-review-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  }
  await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await synced(page);await installSyncApplyFixture(page);
  await openRecovery(manager);await review(manager);await manager.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await synced(manager);await installSyncApplyFixture(manager);
  ownerSocket.notify();managerSocket.notify();await expect.poll(async()=>(await inspect(page)).backup.tables.sales.some(row=>row.amount===6100)).toBe(true);await synced(page);
  const a=await inspect(page),b=await inspect(manager);
  for(const result of [a,b]){expect(result.binding?.version).toBe(3);expect(result.queue.every(row=>row.status==='accepted')).toBe(true);for(const amount of [5300,5900,6100])expect(result.backup.tables.sales.filter(row=>row.amount===amount)).toHaveLength(1);}
  expect(a.queue.map(row=>row.commands)).toEqual(before.queue.map(row=>row.commands));expect(b.queue.map(row=>row.commands)).toEqual(managerBefore.queue.map(row=>row.commands));
  expect(a.binding?.origin).toEqual(before.binding);expect(b.binding?.origin).toEqual(managerBefore.binding);
  expect(a.recoveries.find(row=>row.kind==='admission')?.source.working.tables).toEqual(before.backup.tables);
  expect(a.admissions).toEqual(before.admissions);expect(b.backup.tables.inboxItems).toEqual(a.backup.tables.inboxItems);expect(b.imageSizes).toEqual(a.imageSizes);
  for(const table of backupTableNames.filter(table=>table!=='members'))expect(b.backup.tables[table]).toEqual(a.backup.tables[table]);
  expect(await server.financialCount([...a.backup.tables.sales,...b.backup.tables.sales].filter(row=>[5300,5900,6100].includes(row.amount)).map(row=>row.id))).toBe(3);
 }finally{await page.context().setOffline(false);await other.setOffline(false);await other.close();}
});

test('a fresh role review resumes an admitted shop after a lost activation response without applying it twice',async({page})=>{
 test.setTimeout(90000);await initialize(page,2);await page.context().setOffline(true);await page.evaluate(()=>window.miseSyncApplyTest.cash('67'));const before=await inspect(page);await server.promoteManager();await page.context().setOffline(false);await openRecovery(page);await review(page);
 await installSyncApplyFixture(page);let lost=false;
 await page.route('**/rest/v1/rpc/operator_context',async route=>{const value=await inspect(page);if(!lost&&value.binding?.version===3){lost=true;await route.fulfill({status:503,contentType:'application/json',body:'{}'});}else await route.continue();});
 await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await expect(page.getByRole('button',{name:'Resume sync',exact:true})).toBeVisible({timeout:30000});await expect.poll(()=>lost).toBe(true);
 const admitted=await inspect(page);expect(admitted.operator?.role).toBe('owner');expect(admitted.binding?.origin).toEqual(before.binding);expect(admitted.recoveries.filter(row=>row.kind==='admission')).toHaveLength(1);expect(admitted.queue.map(row=>row.commands)).toEqual(before.queue.map(row=>row.commands));
 await page.unroute('**/rest/v1/rpc/operator_context');await page.reload();await installSyncApplyFixture(page);await page.getByRole('button',{name:'Resume sync',exact:true}).click();await synced(page);await installSyncApplyFixture(page);
 const current=await inspect(page);expect(current.recoveries.filter(row=>row.kind==='admission')).toEqual(admitted.recoveries.filter(row=>row.kind==='admission'));expect(current.backup.tables.sales.filter(row=>row.amount===6700)).toHaveLength(1);expect(current.queue.every(row=>row.status==='accepted')).toBe(true);expect(await server.financialCount(current.backup.tables.sales.filter(row=>row.amount===6700).map(row=>row.id))).toBe(1);
});
test('changing phone accounts after review keeps original money, images and backup and requires fresh original-account review',async({page})=>{
 test.setTimeout(90000);await initialize(page,1);await page.context().setOffline(true);await page.evaluate(async()=>{await window.miseSyncApplyTest.cash('79');await window.miseSyncApplyTest.captureImage();});const before=await inspect(page);await server.changeEpoch();await page.context().setOffline(false);await openRecovery(page);await review(page);await installSyncApplyFixture(page);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download saved shop backup',exact:true}).click();const file=await download,path=await file.path();expect(path).toBeTruthy();const copy=JSON.parse(await readFile(path!,'utf8'));expect(copy.tables).toEqual(before.backup.tables);expect(JSON.stringify(copy)).not.toMatch(/apiUrl|publishableKey|Authorization|access_token|refresh_token/);
 const originalReview=await inspect(page);await page.getByRole('button',{name:'Cancel review',exact:true}).click();await expect(page.getByRole('button',{name:'Check current access',exact:true})).toBeVisible();const cancelled=await inspect(page);expect(cancelled.backup.tables).toEqual(before.backup.tables);expect(cancelled.queue).toEqual(before.queue);expect(cancelled.binding).toEqual(before.binding);expect(cancelled.recoveries.filter(row=>row.kind==='session').find(row=>row.id==='active')?.phase).toBe('cancelled');await review(page);expect((await inspect(page)).recoveries.filter(row=>row.kind==='session').find(row=>row.id==='active')?.readId).not.toBe(originalReview.recoveries.filter(row=>row.kind==='session').find(row=>row.id==='active')?.readId);
 await page.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(2));await expect.poll(async()=>(await inspect(page)).operator?.phase).toBe('locked');
 const apply=page.getByRole('button',{name:'Apply reviewed changes',exact:true});await expect(apply).toBeEnabled();await apply.click();await expect(page.getByRole('alert')).toBeVisible();const rejected=await inspect(page);expect(rejected.backup.tables).toEqual(before.backup.tables);expect(rejected.binding).toEqual(before.binding);expect(rejected.queue).toEqual(before.queue);expect(rejected.recoveries.filter(row=>row.kind==='admission')).toHaveLength(0);
 await page.getByRole('button',{name:'Back to the shop',exact:true}).click();await expect(page.getByRole('heading',{name:'Choose an outlet and member',exact:true})).toBeVisible();await page.getByRole('button',{name:'Review cloud access',exact:true}).click();await expect(page.getByRole('heading',{name:'Review this outlet’s access',exact:true})).toBeVisible();
 await page.evaluate(config=>window.miseSyncApplyTest.switchAccount(config),server.config(1));await page.getByRole('button',{name:'Start a fresh review',exact:true}).click();await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await synced(page);await installSyncApplyFixture(page);const restored=await inspect(page);expect(restored.backup.tables.sales.filter(row=>row.amount===7900)).toHaveLength(1);expect(restored.queue.every(row=>row.status==='accepted')).toBe(true);
});
