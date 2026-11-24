import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
let bundle;
async function build(options){const entry=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),vite=await import(pathToFileURL(entry).href);const result=await vite.build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,...options}}),output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(item=>item.type==='chunk');if(!chunk||output.filter(item=>item.type==='chunk').length!==1)throw Error('Expected one isolated kitchen fixture');return chunk.code;}
export async function startKitchenUiService(){const code=await build({ssr:'tests/fixtures/kitchen-ui-service.ts',rollupOptions:{external:['@electric-sql/pglite','ws']}});mkdirSync('.private',{recursive:true});const path=resolve('.private/kitchen-ui-service-'+process.pid+'.mjs');writeFileSync(path,code);return(await import(pathToFileURL(path).href+'?start='+Date.now())).startKitchenUiService();}
export async function installKitchenUi(page){bundle??=build({lib:{entry:resolve('tests/fixtures/kitchen-ui-browser.ts'),formats:['iife'],name:'MiseKitchenUiTest'},rollupOptions:{output:{inlineDynamicImports:true}}});const code=await bundle,url=new URL('__mise_kitchen_ui_test.js',page.url()).href;await page.route(url,route=>route.fulfill({contentType:'text/javascript; charset=utf-8',body:code}));await page.addScriptTag({url});}
let visualService;
export async function captureKitchenScreen(page,mode='board'){
 visualService??=await startKitchenUiService();
 const config=mode==='queued'||mode==='review'||mode==='undone'||mode.startsWith('permission-')?await visualService.prepare():await visualService.prepareBoard();
 await installKitchenUi(page);await page.evaluate(screen=>window.miseKitchenUiTest.initialize(screen),config.screen);await page.reload();
 await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await expect(page.getByText('Live updates connected',{exact:false})).toBeVisible();
 if(mode==='cancelled'){
  await visualService.cancelFromDesk();await expect(page.getByRole('button',{name:'Understood',exact:true})).toBeVisible();
 }
 if(mode.startsWith('permission-')){
  if(mode==='permission-original'){
   await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.context().setOffline(true);await page.getByRole('button',{name:'Got it',exact:true}).click();
  }
  await visualService.setTeamConfirmation(false);await page.context().setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByText('Preparation is read-only.',{exact:false})).toBeVisible();
  if(mode==='permission-original'){
   await page.getByRole('button',{name:/Saved taps ·/}).click();await expect(page.getByRole('button',{name:'Close saved tap',exact:true})).toBeEnabled();await page.getByText('Original ticket',{exact:true}).click();
  }else if(mode==='permission-restored'){
   await visualService.setTeamConfirmation(true);await page.getByRole('button',{name:'Check now',exact:true}).click();await page.getByRole('button',{name:'Got it',exact:true}).click();
   if(page.viewportSize().width<640)await page.getByRole('button',{name:/^Cooking\s/}).click();
   await page.getByRole('button',{name:'Ready',exact:true}).click();await expect.poll(()=>visualService.inspect()).toMatchObject({receipts:2,status:'ready'});
   if(page.viewportSize().width<640)await page.getByRole('button',{name:/^Ready\s/}).click();
  }else await expect(page.getByRole('button',{name:'Got it',exact:true})).toBeDisabled();
 }
 if(mode==='scheduled'){
  const start=Date.now()+3600000;await visualService.ageOrder();await visualService.scheduleFromDesk(start);await installKitchenUi(page);
  await expect.poll(()=>page.evaluate(id=>window.miseKitchenUiTest.inspect().then(state=>state?.ticketStates.find(ticket=>ticket.id===id)?.scheduledFor),config.orderId)).toBe(start);
  await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 }
 if(mode==='handoff'){
  await visualService.handoffFromDesk();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);
 }
 if(mode==='offline'||mode==='queued'||mode==='review'){
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.context().setOffline(true);await expect(page.getByText('Offline · showing saved tickets',{exact:false})).toBeVisible();
 }
 if(mode==='queued'){
  await page.getByRole('button',{name:'Got it',exact:true}).click();
  if(page.viewportSize().width<640)await page.getByRole('button',{name:/^Cooking\s/}).click();
  await page.getByRole('button',{name:'Ready',exact:true}).click();await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toBeVisible();
 }
 if(mode==='review'){
  await page.getByRole('button',{name:'Got it',exact:true}).click();
  await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Saved taps · 1',exact:true}).click();
  await page.getByText('Original ticket',{exact:true}).click();
 }
 if(mode==='undone'){
  await page.getByRole('button',{name:'Got it',exact:true}).click();
  await expect.poll(async()=>visualService.inspect()).toMatchObject({receipts:1});
  await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toHaveCount(0);
  await visualService.undoLastStatus();await expect(page.getByRole('button',{name:'Got it',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Saved taps · 1',exact:true}).click();await page.getByText('Original ticket',{exact:true}).click();
 }
 const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();if(result.violations.length)throw Error('Kitchen visual fixture has accessibility violations: '+result.violations.map(v=>v.id).join(', '));
}
export async function closeKitchenScreenVisual(){await visualService?.close();visualService=undefined;}
