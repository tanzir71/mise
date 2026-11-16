import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Plugin} from 'vite';

export function publicShopBuild(base:string):Plugin{return {
  name:'mise-public-shop',enforce:'post',
  transformIndexHtml:{order:'post',handler(html,context){return context.path==='/s/index.html'?html.replace(/<link\b[^>]*rel=["']manifest["'][^>]*>/gi,''):html;}},
  generateBundle(_options,bundle){
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
    this.emitFile({type:'asset',fileName:'s/sw.js',source:worker});
    this.emitFile({type:'asset',fileName:'s/resources.json',source:JSON.stringify({entry:base+'s/',resources:[...resources,base+'s/sw.js']},null,2)});
  },
};}
