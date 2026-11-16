import { decompressLzBounded } from './lz-bounded';
import { shopBase64url } from './public-shop-base64';
import { parsePublicShop,PUBLIC_SHOP_MAX_PAYLOAD,PUBLIC_SHOP_MAX_TEXT,type PublicShop } from './public-shop';

/** Customer entry: no owner encoder, database, React or phone-library imports. */
export function decodeShopPayload(payload:string):PublicShop {
  if(!payload||payload.length>PUBLIC_SHOP_MAX_PAYLOAD||!/^[a-zA-Z0-9_-]+$/.test(payload)||payload.length%4===1)throw new Error('This shop link is incomplete or too long.');
  const binary=atob(payload.replaceAll('-','+').replaceAll('_','/')),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
  if(shopBase64url(bytes)!==payload)throw new Error('Use a complete shop link.');
  const text=decompressLzBounded(bytes,PUBLIC_SHOP_MAX_TEXT);
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('This shop link does not contain valid public data.');}return parsePublicShop(value);
}
