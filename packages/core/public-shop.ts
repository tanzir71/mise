import type { MarketCode } from './packs';

export const PUBLIC_SHOP_MAX_ITEMS=20;
export const PUBLIC_SHOP_MAX_TEXT=16000;
export const PUBLIC_SHOP_MAX_PAYLOAD=2400;
export const publicShopCodePattern=/^[A-Z0-9]{1,4}-[A-Z0-9]{4,12}$/;
export const e164Pattern=/^\+[1-9]\d{6,14}$/;
export interface PublicShopItem {id:string;name:string;nameLocal:string;unit:string;price:number;category:string;available:boolean;oftenBought:boolean}
export interface PublicShop {
  v:1;code:string;edition:string;publishedAt:number;name:string;address:string;hours:string;phone:string;deliveryNote:string;
  market:MarketCode;currency:string;timezone:string;mode:'list'|'menu';items:PublicShopItem[];
}
export function publicRecord(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('Use a valid public shop record.');
  if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error('The link may contain only the listed public shop fields.');
  return value as Record<string,unknown>;
}
export function publicText(value:unknown,max:number,multiline=false,required=false):string{
  if(typeof value!=='string'||value.length>max||(required&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||(!multiline&&/[\r\n]/.test(value)))throw new Error('Use valid text within the public field limit.');
  try{encodeURIComponent(value);}catch{throw new Error('Use well-formed text in the public fields.');}return value;
}
export function parsePublicShop(value:unknown):PublicShop{
  const row=publicRecord(value,['v','code','edition','publishedAt','name','address','hours','phone','deliveryNote','market','currency','timezone','mode','items']);
  if(row.v!==1||typeof row.code!=='string'||!publicShopCodePattern.test(row.code)||typeof row.edition!=='string'||!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(row.edition))throw new Error('This shop-link version or identifier is unsupported.');
  if(!Number.isSafeInteger(row.publishedAt)||(row.publishedAt as number)<0||!['BD','IN','ID','KE','OTHER'].includes(row.market as string)||!['list','menu'].includes(row.mode as string))throw new Error('Use supported public shop settings.');
  if(typeof row.phone!=='string'||!e164Pattern.test(row.phone)||typeof row.currency!=='string'||!/^[A-Z]{3}$/.test(row.currency)||typeof row.timezone!=='string')throw new Error('Use a public E.164 phone, currency and timezone.');
  try{new Intl.DateTimeFormat('en',{timeZone:row.timezone});}catch{throw new Error('Use a valid shop timezone.');}
  if(!Array.isArray(row.items)||row.items.length>PUBLIC_SHOP_MAX_ITEMS)throw new Error(`Choose at most ${PUBLIC_SHOP_MAX_ITEMS} public items.`);
  const ids=new Set<string>();
  const items=row.items.map(value=>{
    const item=publicRecord(value,['id','name','nameLocal','unit','price','category','available','oftenBought']);
    if(typeof item.id!=='string'||! /^[a-zA-Z0-9_-]{1,40}$/.test(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.price)||(item.price as number)<0||typeof item.available!=='boolean'||typeof item.oftenBought!=='boolean')throw new Error('Use unique public items with integer minor-unit prices.');ids.add(item.id);
    return {id:item.id,name:publicText(item.name,80,false,true),nameLocal:publicText(item.nameLocal,80),unit:publicText(item.unit,20,false,true),price:item.price as number,category:publicText(item.category,60),available:item.available,oftenBought:item.oftenBought};
  });
  if(row.mode==='menu'&&!items.length)throw new Error('Choose an item for the menu or use the list style.');
  return {v:1,code:row.code,edition:row.edition,publishedAt:row.publishedAt as number,name:publicText(row.name,80,false,true),address:publicText(row.address,250,true),hours:publicText(row.hours,200,true),phone:row.phone,deliveryNote:publicText(row.deliveryNote,400,true),market:row.market as MarketCode,currency:row.currency,timezone:row.timezone,mode:row.mode as PublicShop['mode'],items};
}
