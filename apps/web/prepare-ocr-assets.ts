import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import manifest from './src/ocr/assets.json';

/** No build-time CDN downloads. A changed dependency must have a reviewed manifest. */
export function prepareOcrAssets():void {
 const require=createRequire(import.meta.url);
 const workerPackage=require.resolve('tesseract.js/package.json');
 const packages={worker:workerPackage,core:createRequire(workerPackage).resolve('tesseract.js-core/package.json'),eng:require.resolve('@tesseract.js-data/eng/package.json'),ben:require.resolve('@tesseract.js-data/ben/package.json')};
 for(const [name,path] of Object.entries(packages)){
  const version=(JSON.parse(readFileSync(path,'utf8')) as {version:string}).version;
  if(version!==manifest.versions[name as keyof typeof packages])throw new Error(`Review the pinned OCR ${name} version and asset manifest before building.`);
 }
 const output=fileURLToPath(new URL(`./public/ocr/${manifest.release}/`,import.meta.url));
 mkdirSync(output,{recursive:true});
 for(const asset of manifest.files){
  const bytes=readFileSync(join(dirname(packages[asset.package as keyof typeof packages]),asset.source));
  if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error(`OCR asset differs from its reviewed manifest: ${asset.name}`);
  writeFileSync(join(output,asset.name),bytes);
 }
 for(const [packageName,source,name] of [['worker','LICENSE.md','TESSERACT-LICENSE.txt'],['worker','dist/worker.min.js.LICENSE.txt','WORKER-NOTICES.txt'],['core','LICENSE','CORE-LICENSE.txt']] as const)writeFileSync(join(output,name),readFileSync(join(dirname(packages[packageName]),source)));
 writeFileSync(join(output,'NOTICE.txt'),readFileSync(fileURLToPath(new URL('./src/ocr/NOTICE.txt',import.meta.url))));
}
