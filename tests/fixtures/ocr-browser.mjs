import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('apps/web/package.json'));
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');

/** Test-only route body. It never becomes a production entry or global. */
export async function ocrBrowserModule(base){
 const result=await build({stdin:{contents:"export {readImageOnDevice} from './apps/web/src/ocr/worker';export {parseOcrInvoice} from './packages/core/ocr-invoice';",resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',define:{'import.meta.env.BASE_URL':JSON.stringify(base)}});
 return result.outputFiles[0].text;
}
