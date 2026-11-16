import { compressToUint8Array } from 'lz-string';
import { shopBase64url } from './public-shop-base64';
import { parsePublicShop,PUBLIC_SHOP_MAX_PAYLOAD,PUBLIC_SHOP_MAX_TEXT } from './public-shop';
export { decodeShopPayload } from './public-shop-decode';

export function encodeShopPayload(value:unknown):string{
  const text=JSON.stringify(parsePublicShop(value));if(text.length>PUBLIC_SHOP_MAX_TEXT)throw new Error('Choose a shorter public item list.');
  const payload=shopBase64url(compressToUint8Array(text));if(payload.length>PUBLIC_SHOP_MAX_PAYLOAD)throw new Error('The link is too long. Choose fewer items or shorten the public notes.');return payload;
}
export function publicShopUrl(appBaseUrl:string,value:unknown):string{
  const base=new URL(appBaseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||!base.pathname.endsWith('/app/'))throw new Error('Use the Mise app’s public base URL.');
  return new URL('s/',base).href+'#'+encodeShopPayload(value);
}
