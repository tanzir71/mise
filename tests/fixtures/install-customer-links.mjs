import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let bundle;
async function vite(){const entry=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]});return import(pathToFileURL(entry).href);}
export async function startCustomerLinkService(options){
 const {build}=await vite(),built=await build({configFile:false,root:process.cwd(),logLevel:'silent',ssr:{noExternal:['lz-string']},resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{ssr:'tests/fixtures/customer-link-service.ts',write:false,minify:false,rollupOptions:{external:['@electric-sql/pglite']}}}),output=Array.isArray(built)?built[0].output:built.output,chunk=output.find(v=>v.type==='chunk');if(!chunk||output.filter(v=>v.type==='chunk').length!==1)throw Error('Expected one synthetic customer-link service');mkdirSync('.private',{recursive:true});const file=resolve('.private/customer-link-service-'+process.pid+'.mjs');writeFileSync(file,chunk.code);return(await import(pathToFileURL(file).href+'?start='+Date.now())).startCustomerLinkService(options);
}
export async function installCustomerLinks(page){
 bundle??=(async()=>{const {build}=await vite(),built=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,lib:{entry:resolve('tests/fixtures/customer-link-browser.ts'),formats:['iife'],name:'MiseCustomerLinkTest'},rollupOptions:{output:{inlineDynamicImports:true}}}}),output=Array.isArray(built)?built[0].output:built.output,chunk=output.find(v=>v.type==='chunk');if(!chunk||output.filter(v=>v.type==='chunk').length!==1)throw Error('Expected one customer-link initializer');return chunk.code;})();
 const script=await bundle,url=new URL('__mise_customer_link_test.js',page.url()).href;await page.route(url,route=>route.fulfill({contentType:'text/javascript; charset=utf-8',body:script}));await page.addScriptTag({url});
}
