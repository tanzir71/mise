import {validateInboxImageBytes,type InboxImageType} from './inbox-image';

export const ocrLimits={imageBytes:5*1024*1024,pixels:16_000_000,dimension:16_384} as const;
export interface OcrBox {x0:number;y0:number;x1:number;y1:number}
export interface OcrLine {text:string;confidence:number|null;box:OcrBox|null}
export interface OcrRead {text:string;confidence:number|null;lines:OcrLine[]}
export const ocrWarning='Handwriting unclear, check';
export function ocrLineNeedsReview(line:OcrLine):boolean{return line.confidence===null||line.confidence<80;}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const confidence=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
function box(value:unknown):OcrBox|null{
 if(!record(value))return null;
 const {x0,y0,x1,y1}=value;
 return typeof x0==='number'&&typeof y0==='number'&&typeof x1==='number'&&typeof y1==='number'&&[x0,y0,x1,y1].every(Number.isFinite)&&x0>=0&&y0>=0&&x1>=x0&&y1>=y0?{x0,y0,x1,y1}:null;
}
/** Keep the full engine text, including unrecognized or very long lines. No action
 * or price is inferred here. A missing layout must not manufacture confidence. */
export function ocrRead(value:unknown):OcrRead{
 if(!record(value)||typeof value.text!=='string')throw new Error('The image reader returned an incomplete result. Enter the details by hand.');
 const lines:OcrLine[]=[];
 if(Array.isArray(value.blocks))for(const block of value.blocks){
  if(!record(block)||!Array.isArray(block.paragraphs))continue;
  for(const paragraph of block.paragraphs){
   if(!record(paragraph)||!Array.isArray(paragraph.lines))continue;
   for(const line of paragraph.lines)if(record(line)&&typeof line.text==='string')lines.push({text:line.text,confidence:confidence(line.confidence),box:box(line.bbox)});
  }
 }
 if(!lines.length)for(const text of value.text.split(/\r?\n/))if(text.trim())lines.push({text,confidence:null,box:null});
 return {text:value.text,confidence:confidence(value.confidence),lines};
}

/** Check encoded dimensions before a decoder/WASM allocation. The original file
 * stays unchanged: oversized or unsupported images use manual review. */
export function ocrImageSize(bytes:Uint8Array,type:InboxImageType):{width:number;height:number}{
 if(!['image/jpeg','image/png','image/webp'].includes(type))throw new Error('Use a saved JPEG, PNG or WebP image, or enter the details by hand.');
 if(!bytes.length||bytes.length>ocrLimits.imageBytes)throw new Error('Read one saved image up to 5 MB. Enter larger images by hand.');
 validateInboxImageBytes(type,bytes.subarray(0,12));
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let width=0,height=0;
 if(type==='image/png'&&bytes.length>=33){width=view.getUint32(16);height=view.getUint32(20);}
 else if(type==='image/jpeg'){
  for(let at=2;at+3<bytes.length;){
   if(bytes[at++]!==0xff)break;
   while(bytes[at]===0xff)at++;
   const marker=bytes[at++];if(marker===0xda||marker===0xd9)break;
   if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
   if(at+2>bytes.length)break;
   const length=view.getUint16(at);if(length<2||at+length>bytes.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=8){height=view.getUint16(at+3);width=view.getUint16(at+5);break;}
   at+=length;
  }
 }else if(type==='image/webp'&&bytes.length>=30){
  const chunk=String.fromCharCode(...bytes.subarray(12,16));
  if(chunk==='VP8X'){width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);}
  else if(chunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a){width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}
  else if(chunk==='VP8L'&&bytes[20]===0x2f){width=1+((bytes[21]|bytes[22]<<8)&0x3fff);height=1+((bytes[22]>>6|bytes[23]<<2|bytes[24]<<10)&0x3fff);}
 }
 if(!width||!height||width>ocrLimits.dimension||height>ocrLimits.dimension||width*height>ocrLimits.pixels)throw new Error('Use an image up to 16 megapixels with readable dimensions, or enter the details by hand.');
 return {width,height};
}
