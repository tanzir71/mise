import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
let bundle;
export async function paymentNativeBrowserModule(){
 bundle??=(async()=>{
  const require=createRequire(resolve('package.json')),vite=require.resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vite).href);
  const result=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,target:'es2022',lib:{entry:resolve('tests/fixtures/payment-native-browser.ts'),formats:['es']},rollupOptions:{output:{inlineDynamicImports:true}}}}),output=(Array.isArray(result)?result[0]:result).output,chunk=output.find(item=>item.type==='chunk');
  if(!chunk||output.filter(item=>item.type==='chunk').length!==1)throw Error('Expected one isolated native payment verification module.');return chunk.code;
 })();return bundle;
}
