import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {normalizePath,type Plugin} from 'vite';
import {publicTokens} from './public-tokens';
import {minify} from 'terser';

const tokenId='virtual:mise-public-tokens.css',resolvedTokenId='\0'+tokenId;
const tokenFile=new URL('../../packages/ui/variables.css',import.meta.url),usageFiles=['../../packages/ui/button.css','../../packages/ui/card.css','../../packages/ui/public-fonts.css','./src/public-shop/public-shop.css','./src/public-shop/main.ts','./src/public-shop/icons.ts','./src/public-shop/dom.ts','./s/index.html'].map(path=>new URL(path,import.meta.url));
const watched=[tokenFile,...usageFiles].map(url=>normalizePath(fileURLToPath(url)));

export function publicShopBuild(base:string):Plugin{return {
  name:'mise-public-shop',enforce:'post',
  resolveId(id){if(id===tokenId)return resolvedTokenId;},
  load(id){if(id!==resolvedTokenId)return;for(const file of watched)this.addWatchFile(file);return publicTokens(readFileSync(tokenFile,'utf8'),usageFiles.map(file=>readFileSync(file,'utf8')).join('\n'));},
  handleHotUpdate(context){if(watched.includes(normalizePath(context.file))){const module=context.server.moduleGraph.getModuleById(resolvedTokenId);if(module){context.server.moduleGraph.invalidateModule(module);return [...context.modules,module];}}},
  transformIndexHtml:{order:'post',handler(html,context){return context.path==='/s/index.html'?html.replace(/<link\b[^>]*rel=["']manifest["'][^>]*>/gi,''):html;}},
  async generateBundle(_options,bundle){
    for(const name of ['geist-OFL.txt','hind-siliguri-OFL.txt'])this.emitFile({type:'asset',fileName:'s/licenses/'+name,source:readFileSync(new URL('../../packages/ui/assets/public-fonts/'+name,import.meta.url),'utf8')});
    const files=new Set<string>(['s/index.html']),visited=new Set<string>();
    function visit(name:string){
      if(visited.has(name))return;visited.add(name);const value=bundle[name];if(!value)return;files.add(name);
      if(value.type==='chunk'){
        value.imports.forEach(visit);value.dynamicImports.forEach(visit);
        const metadata=(value as typeof value&{viteMetadata?:{importedCss:Set<string>;importedAssets:Set<string>}}).viteMetadata;
        metadata?.importedCss.forEach(visit);metadata?.importedAssets.forEach(visit);
      }else if(name.endsWith('.css')){
        const css=String(value.source);
        for(const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)){
          if(match[1].startsWith('data:'))continue;const url=new URL(match[1],`https://build.invalid${base}${name}`);if(url.origin==='https://build.invalid'&&url.pathname.startsWith(base))visit(url.pathname.slice(base.length));
        }
      }
    }
    for(const value of Object.values(bundle))if(value.type==='chunk'&&value.isEntry&&value.facadeModuleId?.replaceAll('\\','/').endsWith('/s/index.html'))visit(value.fileName);
    if(files.size<2)throw new Error('The public shop entry was not generated.');
    const resources=[...files].sort().map(name=>base+name);resources.push(base+'mise-mark.svg');
    const revision=createHash('sha256').update(JSON.stringify(resources)).update(String(bundle['s/index.html']?.type==='asset'?bundle['s/index.html'].source:'')).digest('hex').slice(0,16),prefix=`mise-public:${base}:`,cache=prefix+revision;
    const worker=`const CACHE=${JSON.stringify(cache)},PREFIX=${JSON.stringify(prefix)},FILES=${JSON.stringify(resources)},PAGE=${JSON.stringify(base+'s/index.html')};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const old=(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==CACHE);await Promise.all(old.slice(0,-2).map(key=>caches.delete(key)));await self.clients.claim();})()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;event.respondWith((async()=>{const request=event.request.mode==='navigate'?PAGE:event.request;const current=await(await caches.open(CACHE)).match(request);if(current)return current;for(const key of(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==CACHE).reverse()){const found=await(await caches.open(key)).match(request);if(found)return found;}return fetch(event.request);})());});`;
    const compact=await minify(worker,{toplevel:true,compress:{passes:3}});if(!compact.code)throw Error('The public offline worker was not generated.');
    this.emitFile({type:'asset',fileName:'s/sw.js',source:compact.code});
    this.emitFile({type:'asset',fileName:'s/resources.json',source:JSON.stringify({entry:base+'s/',resources:[...resources,base+'s/sw.js']},null,2)});
  },
};}
