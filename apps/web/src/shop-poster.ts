import QRCode from 'qrcode';
import { decodeShopPayload } from '@mise/core/public-shop-decode';
import { marketPacks } from '@mise/core/packs';

export const posterSizes = {
  a5: { label: 'A5 poster', width: 148, height: 210 },
  card: { label: 'Counter card', width: 105, height: 148 },
} as const;
export type PosterSize = keyof typeof posterSizes;
export interface ShopPosterImage { png:Blob; preview:string; name:string; phone:string; secondary:string; language:string; code:string; modules:number; correction:'M'|'L' }

function wrap(context:CanvasRenderingContext2D,text:string,width:number):string[] {
  const lines:string[]=[];let line='';
  for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)) {
    if(line&&context.measureText(line+segment).width>width){lines.push(line.trim());line='';}
    line+=segment;
  }
  if(line.trim())lines.push(line.trim());return lines;
}
export function encodeShopQr(link:string) {
  const url=new URL(link);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.pathname.endsWith('/app/s/'))throw new Error('Generate a valid shop link before printing.');
  const shop=decodeShopPayload(url.hash.slice(1));
  let correction:'M'|'L'='M',qr:ReturnType<typeof QRCode.create>;
  try{qr=QRCode.create(link,{errorCorrectionLevel:correction});}
  catch{correction='L';try{qr=QRCode.create(link,{errorCorrectionLevel:correction});}catch{throw new Error('This shop link is too long for a QR code. Copy the link, or shorten the public notes and item list, then regenerate it.');}}
  return {shop,qr,correction};
}
export async function createShopPoster(link:string):Promise<ShopPosterImage> {
  const {shop,qr,correction}=encodeShopQr(link),pack=marketPacks[shop.market],language=pack['lang/code'];
  const secondary=language==='en'?'':pack['lang/scan-cta'];
  const secondaryFont=language==='bn'?'Hind Siliguri':language==='hi'?'Hind':'Geist';
  // Load explicitly: a canvas alone does not cause document.fonts.ready to fetch an unused face.
  await Promise.all([document.fonts.load('600 24px Geist',shop.name),document.fonts.load('600 24px "Hind Siliguri"',shop.name),document.fonts.load('600 24px Hind',shop.name),document.fonts.load('600 20px "'+secondaryFont+'"',secondary||'Scan to order'),document.fonts.load('400 12px Geist')]);
  await document.fonts.ready;
  const canvas=document.createElement('canvas');canvas.width=1680;canvas.height=2380;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Images cannot be prepared here. Copy the shop link instead.');
  ctx.scale(4,4);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,420,595);ctx.fillStyle='#141414';ctx.textAlign='center';ctx.textBaseline='middle';
  const sans='Geist, "Hind Siliguri", Hind, sans-serif';
  let nameSize=24,nameLines:string[]=[];
  do{ctx.font=`600 ${nameSize}px ${sans}`;nameLines=wrap(ctx,shop.name,356);if(nameLines.length<=2||nameSize===12)break;nameSize-=2;}while(nameSize>=12);
  const nameHeight=nameSize+8,nameExtra=Math.max(0,nameLines.length*nameHeight-32);
  nameLines.forEach((line,index)=>ctx.fillText(line,210,24+nameHeight*(index+.5)));
  ctx.font=`600 40px ${sans}`;ctx.fillText('Scan to order',210,92+nameExtra);
  if(secondary){ctx.font=`600 20px "${secondaryFont}", sans-serif`;ctx.fillStyle='#3f3f3d';ctx.fillText(secondary,210,136+nameExtra);}
  // The reference's illustrative QR is enlarged for real, self-contained shop links.
  // Preserve four white modules and whole source pixels; never crop, stretch or decorate the matrix.
  const box=320-nameExtra,top=168+nameExtra,size=qr.modules.size,scale=Math.floor((box-16)*4/(size+8)),pixels=(size+8)*scale;
  const left=Math.floor((1680-pixels)/2)/4,qrTop=Math.floor(top*4+(box*4-pixels)/2)/4;
  ctx.strokeStyle='#141414';ctx.lineWidth=3;ctx.beginPath();ctx.roundRect((420-box)/2,top,box,box,16);ctx.stroke();
  ctx.fillStyle='#141414';
  for(let row=0;row<size;row++)for(let col=0;col<size;col++)if(qr.modules.get(row,col))ctx.fillRect(left+(col+4)*scale/4,qrTop+(row+4)*scale/4,scale/4,scale/4);
  ctx.font=`600 16px ${sans}`;ctx.fillText(shop.phone,210,512);
  ctx.font=`400 12px ${sans}`;ctx.fillStyle='#3f3f3d';ctx.fillText('Send your request on WhatsApp. No app needed.',210,540);
  ctx.fillStyle='#6f6f6c';ctx.font=`400 11px ${sans}`;ctx.fillText('Powered by Mise',210,570);
  const png=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('The PNG could not be prepared. Copy the shop link instead.')),'image/png'));
  const preview=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('The preview could not be prepared. Copy the shop link instead.'));reader.readAsDataURL(png);});
  return {png,preview,name:shop.name,phone:shop.phone,secondary,language,code:shop.code,modules:size,correction};
}
