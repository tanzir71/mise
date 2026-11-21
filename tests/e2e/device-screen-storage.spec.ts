import {expect,test} from '@playwright/test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let script='';
test.beforeAll(async()=>{
 const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
 const built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/device-screen-browser.ts'),formats:['iife'],name:'MiseDeviceScreenTest'},rollupOptions:{output:{inlineDynamicImports:true}}}}),output=Array.isArray(built)?built[0].output:built.output,chunk=output.find((entry:{type:string})=>entry.type==='chunk');if(!chunk||output.filter((entry:{type:string})=>entry.type==='chunk').length!==1)throw Error('Expected one isolated screen-storage fixture');script=chunk.code;
});
test.beforeEach(async({page})=>{
 // Browser interception only; no diagnostic entry or private fixture is served
 // from the production site, compiled assets or repository downloads.
 await page.route('**/__mise_device_screen_test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',body:route.request().url().endsWith('.js')?script:'<!doctype html><meta charset="utf-8"><title>Shared screen storage verification</title><script src="/__mise_device_screen_test/harness.js"></script>'}));
 await page.goto('http://127.0.0.1:4321/__mise_device_screen_test/');await page.waitForFunction(()=>!!window.miseDeviceScreenTest);
});
test.afterEach(async({page})=>{await page.evaluate(()=>window.miseDeviceScreenTest.cleanup()).catch(()=>{});});
test('native IndexedDB retains the screen-owned secret binding and original code through a full browser reload',async({page})=>{
 const prepared=await page.evaluate(()=>window.miseDeviceScreenTest.prepare());expect(prepared.requests).toBe(0);await page.reload();await page.waitForFunction(()=>!!window.miseDeviceScreenTest);expect(await page.evaluate(()=>window.miseDeviceScreenTest.inspect())).toMatchObject({phase:'pairing',revision:prepared.revision,requestId:prepared.requestId,tokenHash:prepared.tokenHash,code:'123456',names:['mise.screen.v1:/mise/app/']});
});
test('two native tab transactions cannot install competing screen credentials',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.competingTabs())).toEqual({accepted:1,rejected:1,phase:'pairing'});});
test('a browser quota failure retains the complete old state and sends no pairing request',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.quota())).toEqual({rejected:true,originalRetained:true,phase:'empty'});});
test('a late network response cannot restore a pairing cleared by another tab',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.staleResponse())).toEqual({rejected:true,phase:'empty',tombstoneRetained:true});});
test('a real scoped owner database with an unassigned share blocks enrollment and preserves the source',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.ownerGuard())).toEqual({blocked:true,row:{id:'original',text:'Unassigned original share'},requests:0});});
test('an existing owner Auth session blocks shared enrollment before any network request',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.authGuard())).toEqual({blocked:true,kept:true,requests:0});});
test('a route generation that ends before the native write cannot publish a late credential record',async({page})=>{expect(await page.evaluate(()=>window.miseDeviceScreenTest.stoppedWrite())).toEqual({rejected:true,originalRetained:true});});
