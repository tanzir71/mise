import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
let browserBundle;
async function bundle(options){const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),vite=await import(pathToFileURL(vitePath).href),result=await vite.build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,...options}}),output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(value=>value.type==='chunk');if(!chunk||output.filter(value=>value.type==='chunk').length!==1)throw Error('Expected one isolated desk fixture');return chunk.code;}
export async function startDeskUiService(){const code=await bundle({ssr:'tests/fixtures/desk-ui-service.ts',rollupOptions:{external:['@electric-sql/pglite','web-push']}});mkdirSync('.private',{recursive:true});const path=resolve('.private/desk-ui-service-'+process.pid+'.mjs');writeFileSync(path,code);return(await import(pathToFileURL(path).href+'?start='+Date.now())).startDeskUiService();}
export async function installDeskUi(page){browserBundle??=bundle({lib:{entry:resolve('tests/fixtures/desk-ui-browser.ts'),formats:['iife'],name:'MiseDeskUiTest'},rollupOptions:{output:{inlineDynamicImports:true}}});const code=await browserBundle,url=new URL('__mise_desk_ui_test.js',page.url()).href;await page.route(url,route=>route.fulfill({contentType:'text/javascript; charset=utf-8',body:code}));await page.addScriptTag({url});}
export async function mockDeskBrowser(context,permission='default'){
 await context.addInitScript(initial=>{
  // The browser edge is synthetic; IndexedDB, Web Locks, React, Auth HTTP,
  // PostgreSQL permissions and mutation handlers remain the actual code.
  let permission=localStorage.getItem('__mise_desk_test_permission')||initial;const name='__mise_desk_test_capability',bytes=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)),encode=value=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  window.miseDeskPermissionCalls=[];
  Object.defineProperty(Notification,'permission',{configurable:true,get:()=>permission});Notification.requestPermission=()=>{window.miseDeskPermissionCalls.push(navigator.userActivation.isActive);permission='granted';localStorage.setItem('__mise_desk_test_permission',permission);return Promise.resolve(permission);};
  const restore=value=>value?{endpoint:value.endpoint,expirationTime:null,options:{applicationServerKey:bytes(value.applicationKey).buffer},getKey:key=>bytes(value.keys[key]).buffer,unsubscribe:async()=>{localStorage.removeItem(name);return true;}}:null;
  PushManager.prototype.getSubscription=async function(){const raw=localStorage.getItem(name);return restore(raw?JSON.parse(raw):null);};
  PushManager.prototype.subscribe=async function(options){const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),key=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)),value={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-desk-'+crypto.randomUUID(),applicationKey:encode(new Uint8Array(options.applicationServerKey)),keys:{p256dh:encode(key),auth:encode(crypto.getRandomValues(new Uint8Array(16)))}};localStorage.setItem(name,JSON.stringify(value));return restore(value);};
 },permission);
}
let visualService;
export async function captureDeskNotifications(page,mode='inbox'){
 visualService??=await startDeskUiService();const prepared=await visualService.prepare();await mockDeskBrowser(page.context());await installDeskUi(page);await page.evaluate(input=>window.miseDeskUiTest.initialize(input),prepared);
 const root=new URL(page.url());root.pathname=root.pathname.replace(/\/app\/.*$/,'/app/');root.search='';root.hash='';
 await page.goto(new URL(mode==='queue'?'orders':mode==='inbox'?'inbox':'settings/notifications',root).href);
 if(mode==='cleanup'||mode==='offline'){
  await expect(page.getByRole('button',{name:'Enable here',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Enable here',exact:true}).click();await expect(page.getByText('Notifications enabled on this browser.',{exact:true})).toBeVisible();
  if(mode==='cleanup'){await page.goto(new URL('settings/notifications/cleanup',root).href);await page.getByRole('combobox',{name:'Saved setup',exact:true}).selectOption({index:1});await page.getByRole('button',{name:'Disable saved setup here',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm original removals',exact:true})).toBeEnabled();}
  else{await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.context().setOffline(true);await page.getByRole('button',{name:'Disable here',exact:true}).click();await expect(page.getByText('Disabled on this browser. Saved warnings stay in Inbox.',{exact:true})).toBeVisible();}
 }else if(mode==='inbox')await expect(page.getByRole('heading',{name:/A-2041.*Got it/})).toBeVisible();
 else if(mode==='queue')await expect(page.locator('.kitchen-alarm')).toHaveCount(1);
 else await expect(page.getByRole('button',{name:'Enable here',exact:true})).toBeEnabled();
 const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();if(report.violations.length)throw Error('Desk visual fixture accessibility: '+report.violations.map(value=>value.id).join(', '));
}
export async function closeDeskNotificationsVisual(){const service=visualService;visualService=undefined;if(service)await service.close();}
