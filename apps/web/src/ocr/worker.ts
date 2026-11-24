import {ocrImageSize,ocrRead,ocrLimits,type OcrRead} from '@mise/core/ocr';
import type {InboxImageType} from '@mise/core/inbox-image';
import {abortOcr,ocrAssetRoot,prepareOcrDownload,type OcrProgress} from './assets';
import {prepareOcrRaster} from './raster';

export interface OcrOptions {signal:AbortSignal;onProgress?:(value:OcrProgress)=>void}
interface Packet {workerId?:string;jobId?:string;action?:string;status?:string;data?:unknown}
type Job={id:string;action:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
let active=false;

/** Adapter for the pinned Tesseract.js 7 worker protocol. Owning the native
 * Worker lets cancellation terminate even while the engine is initializing.
 * Only one job can run on this page, and no engine or image survives a read. */
export async function readImageOnDevice(image:Blob,options:OcrOptions):Promise<OcrRead>{
 const {signal,onProgress}=options;abortOcr(signal);
 if(active)throw new Error('Another image is being read. Cancel it or wait, then try this image.');
 if(!globalThis.isSecureContext||!globalThis.caches||!globalThis.crypto?.subtle||!navigator.serviceWorker?.controller)throw new Error('Finish installing Mise and reload to use the saved on-device reader, or enter the details by hand.');
 active=true;let worker:Worker|undefined,job:Job|undefined,sequence=0;
 const workerId=crypto.randomUUID();
 function stop(error:Error){worker?.terminate();worker=undefined;if(job){clearTimeout(job.timer);const reject=job.reject;job=undefined;reject(error);}}
 const cancel=()=>stop(new DOMException('Image reading cancelled.','AbortError'));
 signal.addEventListener('abort',cancel,{once:true});
 try{
  if(!image.size||image.size>ocrLimits.imageBytes)throw new Error('Read one saved image up to 5 MB. Enter larger images by hand.');
  const imageBytes=new Uint8Array(await image.arrayBuffer());abortOcr(signal);ocrImageSize(imageBytes,image.type as InboxImageType);
  const raster=await prepareOcrRaster(image,signal);abortOcr(signal);
  const base=import.meta.env.BASE_URL,origin=location.origin,root=ocrAssetRoot(base,origin);
  await prepareOcrDownload(base,origin,signal,onProgress);abortOcr(signal);
  worker=new Worker(new URL('worker.min.js',root),{name:'Mise on-device image reader'});
  worker.onerror=()=>stop(new Error('The image reader stopped. The original is still saved; enter the details by hand.'));
  worker.onmessageerror=()=>stop(new Error('The image reader returned an incomplete result. Enter the details by hand.'));
  worker.onmessage=(event:MessageEvent<Packet>)=>{
   const value=event.data;
   if(!value||typeof value!=='object'||!job||value.workerId!==workerId||value.jobId!==job.id||value.action!==job.action)return;
   if(value.status==='progress'){
    const data=value.data;if(data&&typeof data==='object'&&'progress'in data&&typeof data.progress==='number'&&Number.isFinite(data.progress))onProgress?.({stage:job.action==='recognize'?'read':'load',progress:Math.max(0,Math.min(1,data.progress))});return;
   }
   if(value.status==='reject'){stop(new Error('This image could not be read. Check the saved original and enter its details by hand.'));return;}
   if(value.status==='resolve'){clearTimeout(job.timer);const resolve=job.resolve;job=undefined;resolve(value.data);}
  };
  function send(action:string,payload:unknown):Promise<unknown>{
   abortOcr(signal);if(!worker)throw new Error('The image reader stopped. Try again or enter the details by hand.');
   return new Promise((resolve,reject)=>{
    const id=String(++sequence);job={id,action,resolve,reject,timer:setTimeout(()=>stop(new Error('Image reading took too long. The original is still saved; enter its details by hand.')),120_000)};
    worker!.postMessage({workerId,jobId:id,action,payload});
   });
  }
  await send('load',{options:{lstmOnly:true,corePath:root.href,logging:false}});
  await send('loadLanguage',{langs:'eng+ben',options:{langPath:root.href.replace(/\/$/,''),cacheMethod:'none',gzip:true,lstmOnly:true}});
  await send('initialize',{langs:'eng+ben',oem:1,config:{}});
  await send('setParameters',{params:{preserve_interword_spaces:'1',user_defined_dpi:'300',tessedit_pageseg_mode:'6'}});
  const result=await send('recognize',{image:raster.bytes,options:{},output:{text:true,blocks:true}});
  abortOcr(signal);const read=ocrRead(result);
  return {...read,lines:read.lines.map(line=>({...line,box:line.box?{x0:line.box.x0/raster.scale,y0:line.box.y0/raster.scale,x1:line.box.x1/raster.scale,y1:line.box.y1/raster.scale}:null}))};
 }finally{signal.removeEventListener('abort',cancel);stop(new DOMException('Image reader closed.','AbortError'));active=false;}
}
