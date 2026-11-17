import {expect,test} from '@playwright/test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let script='';
test.beforeAll(async()=>{
  const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
  const built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/cloud-upload-browser.ts'),formats:['iife'],name:'MiseUploadTest'},rollupOptions:{output:{inlineDynamicImports:true}}}});
  const output=Array.isArray(built)?built[0].output:built.output,chunk=output.find((entry:{type:string})=>entry.type==='chunk');if(!chunk||output.filter((entry:{type:string})=>entry.type==='chunk').length!==1)throw new Error('Expected one isolated browser test bundle');script=chunk.code;
});
test.beforeEach(async({page})=>{
  // Test-only HTTP interception; no debug route or harness enters the shipped site.
  await page.route('**/__mise_cloud_upload_test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?script:'<!doctype html><title>Upload persistence verification</title><script src="/__mise_cloud_upload_test/harness.js"></script>'}));
  await page.goto('http://127.0.0.1:4321/__mise_cloud_upload_test/');await page.waitForFunction(()=>!!window.miseCloudUploadTest);
});
test.afterEach(async({page})=>{await page.evaluate(()=>window.miseCloudUploadTest.cleanup()).catch(()=>{});});
test('a 5000-record snapshot and original image survive a full browser reload as native IndexedDB blobs',async({page})=>{
  const prepared=await page.evaluate(()=>window.miseCloudUploadTest.prepare());expect(prepared.records).toBe(5000);expect(prepared.chunks).toBeGreaterThan(1);expect(prepared.compressedBytes).toBeLessThan(prepared.rawBytes);
  await page.reload();await page.waitForFunction(()=>!!window.miseCloudUploadTest);expect(await page.evaluate(()=>window.miseCloudUploadTest.inspect())).toEqual({sameLocalData:true,nativeBlob:true,records:5000,sameOriginalImage:true});
});
test('native compressed transfer resumes a lost reply without resending accepted data or replacing the local shop',async({page})=>{
  const prepared=await page.evaluate(()=>window.miseCloudUploadTest.prepare());expect(await page.evaluate(()=>window.miseCloudUploadTest.interrupt())).toEqual({accepted:[0],cached:[]});
  const resumed=await page.evaluate(()=>window.miseCloudUploadTest.resume());expect(resumed.receipt.records).toBe(5000);expect(resumed.cachedReceipt).toEqual(resumed.receipt);expect(resumed.puts).toHaveLength(prepared.chunks);expect(resumed.puts.filter(index=>index===0)).toHaveLength(1);expect(resumed.commits).toBe(1);expect(resumed.sameLocalData).toBe(true);
});
