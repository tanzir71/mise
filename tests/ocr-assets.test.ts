import {afterEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {ocrAssetForUrl,ocrAssetRoot,ocrCacheName,verifiedOcrAsset,type OcrAsset} from '../apps/web/src/ocr/assets';

afterEach(()=>vi.unstubAllGlobals());
function environment(){
 const saved=new Map<string,Response>(),fetcher=vi.fn();
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true});vi.stubGlobal('fetch',fetcher);vi.stubGlobal('caches',{open:async()=>({match:async(url:string)=>saved.get(url)?.clone(),put:async(url:string,response:Response)=>{saved.set(url,response.clone());},delete:async(url:string)=>saved.delete(url)})});
 return {saved,fetcher};
}
async function fixture(){const bytes=new TextEncoder().encode('public engine fixture'),sha256=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');return {bytes,asset:{name:'worker.min.js',package:'worker',source:'dist/worker.min.js',bytes:bytes.length,sha256,type:'text/javascript'} as OcrAsset};}
it('matches only exact release files within the current installation',()=>{
 for(const base of ['/app/','/mise/app/']){
  const root=ocrAssetRoot(base,'https://example.test');expect(root.pathname.startsWith(base+'ocr/')).toBe(true);expect(ocrCacheName(base,'https://example.test')).toContain(base);
  expect(ocrAssetForUrl(new URL('worker.min.js',root),base,root.origin)?.name).toBe('worker.min.js');
  for(const url of [new URL('worker.min.js?download=1',root),new URL('../other.js',root),new URL(root.href.replace('example.test','other.test')+'worker.min.js')])expect(ocrAssetForUrl(url,base,root.origin)).toBeUndefined();
 }
 expect(()=>ocrAssetRoot('https://other.test/app/','https://example.test')).toThrow('installation');
});
it('verifies complete downloaded bytes, then reads an identical offline copy without network',async()=>{
 const {saved,fetcher}=environment(),{bytes,asset}=await fixture();fetcher.mockResolvedValue(new Response(bytes));
 expect(await (await verifiedOcrAsset(asset,'/app/','https://example.test')).text()).toBe('public engine fixture');expect(saved.size).toBe(1);expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/app/ocr/'),{cache:'no-store',credentials:'omit',redirect:'error',signal:undefined});
 fetcher.mockRejectedValue(new Error('offline'));vi.stubGlobal('navigator',{onLine:false});
 expect(await (await verifiedOcrAsset(asset,'/app/','https://example.test')).text()).toBe('public engine fixture');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not cache wrong hashes, truncation, extra bytes, errors or redirects',async()=>{
 const {saved,fetcher}=environment(),{bytes,asset}=await fixture();
 for(const body of [bytes.slice(0,-1),new Uint8Array(bytes.length),new Uint8Array(bytes.length+1)]){fetcher.mockResolvedValue(new Response(body));await expect(verifiedOcrAsset(asset,'/app/','https://example.test')).rejects.toThrow('changed');expect(saved.size).toBe(0);}
 fetcher.mockResolvedValue(new Response('not found',{status:404}));await expect(verifiedOcrAsset(asset,'/app/','https://example.test')).rejects.toThrow('downloaded');expect(saved.size).toBe(0);
 const redirected=new Response(bytes);Object.defineProperty(redirected,'redirected',{value:true});fetcher.mockResolvedValue(redirected);await expect(verifiedOcrAsset(asset,'/app/','https://example.test')).rejects.toThrow('downloaded');expect(saved.size).toBe(0);
});
it('rejects a damaged offline cache, and can explicitly retry its real download online',async()=>{
 const {saved,fetcher}=environment(),{bytes,asset}=await fixture(),url=new URL(asset.name,ocrAssetRoot('/app/','https://example.test')).href;
 saved.set(url,new Response(new Uint8Array(bytes.length)));vi.stubGlobal('navigator',{onLine:false});await expect(verifiedOcrAsset(asset,'/app/','https://example.test')).rejects.toThrow('changed');expect(saved.size).toBe(0);expect(fetcher).not.toHaveBeenCalled();
 vi.stubGlobal('navigator',{onLine:true});fetcher.mockResolvedValue(new Response(bytes));expect((await verifiedOcrAsset(asset,'/app/','https://example.test')).ok).toBe(true);
});
it('stops a cancelled download before opening or changing a cache',async()=>{
 const {saved,fetcher}=environment(),{asset}=await fixture(),controller=new AbortController();controller.abort();await expect(verifiedOcrAsset(asset,'/app/','https://example.test',controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(saved.size).toBe(0);expect(fetcher).not.toHaveBeenCalled();
});
