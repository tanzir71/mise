import {expect,test,type Page} from '@playwright/test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let script='';
test.beforeAll(async()=>{
 const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
 const built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/desk-browser.ts'),formats:['iife'],name:'MiseDeskBrowserTest'},rollupOptions:{output:{inlineDynamicImports:true}}}}),output=Array.isArray(built)?built[0].output:built.output,chunk=output.find((entry:{type:string})=>entry.type==='chunk');
 if(!chunk||output.filter((entry:{type:string})=>entry.type==='chunk').length!==1)throw Error('Expected one isolated desk journal fixture');script=chunk.code;
});
async function install(page:Page){
 // Intercepted native-storage harness only; no fixture route/asset is published.
 await page.route('**/__mise_desk_storage_test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',body:route.request().url().endsWith('.js')?script:'<!doctype html><meta charset="utf-8"><title>Desk journal verification</title><script src="/__mise_desk_storage_test/harness.js"></script>'}));
 await page.goto('http://127.0.0.1:4321/__mise_desk_storage_test/');await page.waitForFunction(()=>!!window.miseDeskBrowserTest);
}
test.beforeEach(async({page})=>{await install(page);});
test.afterEach(async({page})=>{await page.evaluate(()=>window.miseDeskBrowserTest.cleanup()).catch(()=>{});});
test('native desk operations survive a browser reload and confirm the original HTTP event without storing capability values',async({page})=>{
 const prepared=await page.evaluate(()=>window.miseDeskBrowserTest.prepare());expect(prepared).toMatchObject({privateValuesCopied:false,counts:{registers:0,withdrawals:0}});
 await page.reload();await page.waitForFunction(()=>!!window.miseDeskBrowserTest);const saved=await page.evaluate(()=>window.miseDeskBrowserTest.inspect());expect(saved).toMatchObject({version:2,pending:[{id:prepared.id,kind:'register'}]});
 expect(await page.evaluate(source=>window.miseDeskBrowserTest.confirm(source),prepared.source)).toEqual({eventId:prepared.id,id:'00000000000000000000000005',counts:{registers:1,withdrawals:0},enabled:true});
});
test('offline Disable retains the complete native Inbox and original withdrawals after reload without sending HTTP',async({page,context})=>{
 await page.evaluate(()=>window.miseDeskBrowserTest.prepare());await context.setOffline(true);const disabled=await page.evaluate(()=>window.miseDeskBrowserTest.disable());expect(disabled).toMatchObject({enabled:false,tasks:2,counts:{registers:0,withdrawals:0}});
 await context.setOffline(false);await page.reload();await page.waitForFunction(()=>!!window.miseDeskBrowserTest);expect(await page.evaluate(()=>window.miseDeskBrowserTest.inspect())).toMatchObject({pending:disabled.events.map(id=>({id,kind:'revoke'})),snapshot:{profile:{enabled:false,tasks:{tasks:[{orderId:'00000000000000000000000201'},{orderId:'00000000000000000000000202'}]}}}});
});
test('an in-flight registration response cannot undo a newer native Disable',async({page})=>{
 const prepared=await page.evaluate(()=>window.miseDeskBrowserTest.prepare());expect(await page.evaluate(source=>window.miseDeskBrowserTest.lateResult(source),prepared.source)).toEqual({enabled:false,history:[{kind:'register',confirmed:true},{kind:'revoke',confirmed:false}],pending:['revoke']});
});
test('two browser tabs cannot commit competing registrations from the same native profile snapshot',async({page,context})=>{
 const prepared=await page.evaluate(()=>window.miseDeskBrowserTest.prepare()),saved=await page.evaluate(()=>window.miseDeskBrowserTest.inspect()),other=await context.newPage();
 try{await install(other);const results=await Promise.all([page.evaluate(({snapshot,source})=>window.miseDeskBrowserTest.queue(snapshot,source,1),{snapshot:saved.snapshot,source:prepared.source}),other.evaluate(({snapshot,source})=>window.miseDeskBrowserTest.queue(snapshot,source,2),{snapshot:saved.snapshot,source:prepared.source})]);expect(results.filter(Boolean)).toHaveLength(1);expect((await page.evaluate(()=>window.miseDeskBrowserTest.inspect())).events).toHaveLength(2);}finally{await other.close();}
});
test('native quota failure rolls every newly journaled withdrawal back with the unchanged profile',async({page})=>{
 await page.evaluate(()=>window.miseDeskBrowserTest.prepare());expect(await page.evaluate(()=>window.miseDeskBrowserTest.quota())).toEqual({rejected:true,profileRetained:true,journalRetained:true});
});
test('serialized proof and an account change inside the native receipt writer retain the original pending operation',async({page})=>{
 const prepared=await page.evaluate(()=>window.miseDeskBrowserTest.prepare());expect(await page.evaluate(source=>window.miseDeskBrowserTest.proofAndAccount(source),prepared.source)).toEqual({copiedRejected:true,changedRejected:true,profileRetained:true,pending:[prepared.id]});
});
test('a genuine earlier-account outcome remains history without changing the newer native account',async({page})=>{
 const prepared=await page.evaluate(()=>window.miseDeskBrowserTest.prepare()),result=await page.evaluate(source=>window.miseDeskBrowserTest.switchedAccount(source),prepared.source);
 expect(result.after).toEqual(result.before);expect(result).toMatchObject({earlierHidden:true,earlierRecorded:true});
});
