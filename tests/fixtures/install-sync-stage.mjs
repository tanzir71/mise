import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

let bundle;
async function buildFixture(){
 const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
 const built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/sync-download-browser.ts'),formats:['iife'],name:'MiseSyncStageTest'},rollupOptions:{output:{inlineDynamicImports:true}}}});
 const output=Array.isArray(built)?built[0].output:built.output,chunk=output.find(part=>part.type==='chunk');if(!chunk||output.filter(part=>part.type==='chunk').length!==1)throw Error('Expected one isolated sync staging fixture bundle.');return chunk.code;
}
/** Intercepted local-only verification code; no debug API enters the shipped app. */
export async function installSyncStageFixture(page){
 bundle??=buildFixture();const script=await bundle,url=new URL('__mise_sync_stage_test.js',page.url()).href;
 await page.route(url,route=>route.fulfill({contentType:'text/javascript',body:script}));await page.addScriptTag({url});
}
