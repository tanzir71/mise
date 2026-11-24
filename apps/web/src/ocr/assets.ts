import manifest from './assets.json';

export {manifest as ocrAssets};
export type OcrAsset=typeof manifest.files[number];
export interface OcrProgress {stage:'download'|'load'|'read';progress:number;bytes?:number;totalBytes?:number}
export function ocrAssetRoot(base:string,origin:string):URL{
 const url=new URL(base,origin);
 if(url.origin!==origin||url.search||url.hash||!url.pathname.endsWith('/'))throw new Error('Open OCR from this installation’s app.');
 return new URL(`ocr/${manifest.release}/`,url);
}
export function ocrCacheName(base:string,origin:string):string{return `mise-ocr:${ocrAssetRoot(base,origin).pathname}`;}
export function abortOcr(signal?:AbortSignal):void{if(signal?.aborted)throw new DOMException('Image reading cancelled.','AbortError');}
async function checkedBytes(response:Response,asset:OcrAsset,signal?:AbortSignal):Promise<Uint8Array<ArrayBuffer>>{
 if(!response.ok||!response.body||response.type==='opaque'||response.redirected)throw new Error('The on-device reader could not be downloaded. Enter the details by hand.');
 const reader=response.body.getReader(),bytes=new Uint8Array(asset.bytes);let at=0;
 try{
  for(;;){abortOcr(signal);const {done,value}=await reader.read();if(done)break;if(at+value.byteLength>bytes.length)throw new Error('The on-device reader download is incomplete or changed.');bytes.set(value,at);at+=value.byteLength;}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 abortOcr(signal);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 if(at!==asset.bytes||hash!==asset.sha256)throw new Error('The on-device reader download is incomplete or changed.');
 return bytes;
}
/** The cache contains only pinned public engine files, never a shop image or OCR
 * result. Validate full bytes on every use; a bad offline copy fails closed. */
export async function verifiedOcrAsset(asset:OcrAsset,base:string,origin:string,signal?:AbortSignal):Promise<Response>{
 abortOcr(signal);
 const url=new URL(asset.name,ocrAssetRoot(base,origin)).href,cache=await caches.open(ocrCacheName(base,origin));
 const saved=await cache.match(url);
 if(saved){
  try{const bytes=await checkedBytes(saved,asset,signal);return new Response(bytes,{headers:{'Content-Type':asset.type,'Cross-Origin-Resource-Policy':'same-origin'}});}
  catch(error){abortOcr(signal);await cache.delete(url);if(!navigator.onLine)throw error;}
 }
 const downloaded=await fetch(url,{signal,credentials:'omit',cache:'no-store',redirect:'error'}),bytes=await checkedBytes(downloaded,asset,signal);
 const response=new Response(bytes,{headers:{'Content-Type':asset.type,'Content-Length':String(bytes.length),'Cross-Origin-Resource-Policy':'same-origin'}});
 abortOcr(signal);await cache.put(url,response.clone());abortOcr(signal);return response;
}
export function ocrAssetForUrl(url:URL,base:string,origin:string):OcrAsset|undefined{
 if(url.origin!==origin||url.search||url.hash)return undefined;
 const root=ocrAssetRoot(base,origin);
 return manifest.files.find(asset=>url.pathname===root.pathname+asset.name);
}
export async function prepareOcrDownload(base:string,origin:string,signal?:AbortSignal,onProgress?:(value:OcrProgress)=>void):Promise<void>{
 const totalBytes=manifest.files.reduce((sum,asset)=>sum+asset.bytes,0);let bytes=0;
 onProgress?.({stage:'download',progress:0,bytes,totalBytes});
 for(const asset of manifest.files){await verifiedOcrAsset(asset,base,origin,signal);bytes+=asset.bytes;onProgress?.({stage:'download',progress:bytes/totalBytes,bytes,totalBytes});}
}
