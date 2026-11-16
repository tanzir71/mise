import { compressToUint8Array } from 'lz-string';
import { decompressLzBounded } from './lz-bounded';
import { parsePublicShop,PUBLIC_SHOP_MAX_PAYLOAD,PUBLIC_SHOP_MAX_TEXT,type PublicShop } from './public-shop';

function base64url(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export function encodeShopPayload(value:unknown):string{
  const text=JSON.stringify(parsePublicShop(value));if(text.length>PUBLIC_SHOP_MAX_TEXT)throw new Error('Choose a shorter public item list.');
  const payload=base64url(compressToUint8Array(text));if(payload.length>PUBLIC_SHOP_MAX_PAYLOAD)throw new Error('The link is too long. Choose fewer items or shorten the public notes.');return payload;
}
export function decodeShopPayload(payload:string):PublicShop{
  if(!payload||payload.length>PUBLIC_SHOP_MAX_PAYLOAD||!/^[a-zA-Z0-9_-]+$/.test(payload)||payload.length%4===1)throw new Error('This shop link is incomplete or too long.');
  const binary=atob(payload.replaceAll('-','+').replaceAll('_','/')),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
  if(base64url(bytes)!==payload)throw new Error('Use a complete shop link.');
  const text=decompressLzBounded(bytes,PUBLIC_SHOP_MAX_TEXT);
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('This shop link does not contain valid public data.');}return parsePublicShop(value);
}
export function publicShopUrl(appBaseUrl:string,value:unknown):string{
  const base=new URL(appBaseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||!base.pathname.endsWith('/app/'))throw new Error('Use the Mise app’s public base URL.');
  return new URL('s/',base).href+'#'+encodeShopPayload(value);
}
