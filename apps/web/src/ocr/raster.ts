import {abortOcr} from './assets';

/** Improve small printed text without changing the saved original. Decode only
 * after encoded dimensions are checked. The temporary bitmap/canvas is released
 * on success, cancellation and failure. Coordinates refer to the displayed image. */
export async function prepareOcrRaster(image:Blob,signal:AbortSignal):Promise<{bytes:Uint8Array<ArrayBuffer>;scale:number}>{
 abortOcr(signal);
 const bitmap=await createImageBitmap(image);
 let canvas:OffscreenCanvas|undefined;
 try{
  abortOcr(signal);
  if(bitmap.width*bitmap.height>16_000_000||bitmap.width>16_384||bitmap.height>16_384)throw new Error('Use an image up to 16 megapixels, or enter the details by hand.');
  const scale=bitmap.width*bitmap.height<=4_000_000&&Math.max(bitmap.width,bitmap.height)<2400?2:1;
  canvas=new OffscreenCanvas(bitmap.width*scale,bitmap.height*scale);
  const context=canvas.getContext('2d');if(!context)throw new Error('Image preparation is unavailable. Enter the saved image details by hand.');
  context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const raster=await canvas.convertToBlob({type:'image/png'});abortOcr(signal);
  const bytes=new Uint8Array(await raster.arrayBuffer());abortOcr(signal);return {bytes,scale};
 }finally{bitmap.close();if(canvas){canvas.width=1;canvas.height=1;}}
}
