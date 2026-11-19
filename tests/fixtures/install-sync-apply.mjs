import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let bundle;
async function buildFixture(){const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href),built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/sync-apply-browser.ts'),formats:['iife'],name:'MiseSyncApplyTest'},rollupOptions:{output:{inlineDynamicImports:true}}}}),out=Array.isArray(built)?built[0].output:built.output,chunk=out.find(p=>p.type==='chunk');if(!chunk||out.filter(p=>p.type==='chunk').length!==1)throw Error('Expected one isolated application fixture');return chunk.code;}
export async function installSyncApplyFixture(page){bundle??=buildFixture();const script=await bundle,url=new URL('__mise_sync_apply_test.js',page.url()).href;await page.context().route(url,r=>r.fulfill({contentType:'text/javascript',body:script}));await page.addScriptTag({url});}
