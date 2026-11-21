import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inspectSecretBytes} from './check-secrets.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),hash=value=>createHash('sha256').update(value).digest('hex');
/** Bundle shared sources without Docker or embedded configuration. Only the
 * kitchen relay may keep its explicitly version-pinned server runtime import. */
export async function edgeBundle(name){
  if(!/^[a-z][a-z0-9-]{0,62}$/.test(name))throw new Error('Choose one named Edge Function.');
  const entry='supabase/functions/'+name+'/index.ts',vitePath=createRequire(new URL('../package.json',import.meta.url)).resolve('vite',{paths:[resolve(root,'apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
  const allowedRuntimeImports=name==='kitchen-live'?['npm:ws@8.23.0']:[];
  const result=await build({root,configFile:false,envDir:resolve(root,'supabase/functions',name),logLevel:'silent',build:{target:'esnext',write:false,minify:true,lib:{entry:resolve(root,entry),formats:['es']},rollupOptions:{external:allowedRuntimeImports,output:{inlineDynamicImports:true}}}});
  const output=Array.isArray(result)?result[0].output:result.output,files=output.filter(item=>item.type==='chunk');
  if(files.length!==1||output.length!==1||files[0].imports.some(value=>!allowedRuntimeImports.includes(value))||files[0].dynamicImports.length)throw new Error('Edge bundle must be one module with only reviewed pinned runtime imports.');
  const chunk=files[0],findings=inspectSecretBytes(Buffer.from(chunk.code),entry);if(findings.length)throw new Error('Edge bundle credential/deployment guard rejected the output.');
  if(Buffer.byteLength(chunk.code)>20*1024*1024)throw new Error('Edge bundle exceeds the hosted function limit.');
  const canonicalRoot=root.replaceAll('\\','/').replace(/\/$/,'');
  const sources=Object.keys(chunk.modules).map(path=>path.replaceAll('\\','/')).filter(path=>path.startsWith(canonicalRoot+'/')&&!path.includes('/node_modules/')).map(path=>relative(root,path).replaceAll('\\','/')).sort();
  return {entrypoint_path:entry,files:[{name:entry,content:chunk.code}],bytes:Buffer.byteLength(chunk.code),sha256:hash(chunk.code),runtimeImports:[...chunk.imports],sourceHashes:Object.fromEntries(sources.map(path=>[path,hash(readFileSync(resolve(root,path)))]))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bundle=await edgeBundle(process.argv[2]||''),out=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
  if(out){const target=resolve(root,out);if(!target.startsWith(resolve(root,'.private')+sep))throw new Error('Write bundle payloads only under the ignored .private directory.');mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(bundle).replace(/[^\x00-\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));}
  console.log(JSON.stringify({entrypoint:bundle.entrypoint_path,bytes:bundle.bytes,sha256:bundle.sha256,sourceFiles:Object.keys(bundle.sourceHashes).length,payloadWritten:!!out}));
}
