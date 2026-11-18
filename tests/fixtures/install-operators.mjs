import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let bundle;
async function buildFixture(){const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href),built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/operators-browser.ts'),formats:['iife'],name:'MiseOperatorsTest'},rollupOptions:{output:{inlineDynamicImports:true}}}});const out=Array.isArray(built)?built[0].output:built.output,chunk=out.find(p=>p.type==='chunk');if(!chunk||out.filter(p=>p.type==='chunk').length!==1)throw Error('Expected one isolated operator fixture.');return chunk.code;}
/** Intercepted local test code; the production build has no debug API.
 * Context routing also covers worker-owned requests. Wait for clientsClaim so
 * takeover cannot abort the injection: https://playwright.dev/docs/service-workers */
export async function installOperatorsFixture(page){
 bundle??=buildFixture();const script=await bundle,url=new URL('__mise_operators_test.js',page.url()).href;
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
 await page.context().route(url,r=>r.fulfill({contentType:'text/javascript',body:script}));await page.addScriptTag({url});
}
