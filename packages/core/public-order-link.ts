import {decodeShopPayload} from './public-shop-decode';
import {customerApiOrigin} from './customer-link-url';
import {publicRecord,publicText,type PublicShop} from './public-shop';
export interface PublicOrderingLink {v:1;sourceUrl:string;apiUrl:string;shopToken:string;table:string|null}
const bad=()=>Error('Open the complete current ordering link from the shop.');
export function publicOrderShopSource(value:string):{url:URL;shop:PublicShop}{
 const url=new URL(value);customerApiOrigin(url.origin);
 if(url.username||url.password||url.search||!url.pathname.endsWith('/app/s/')||!url.hash||value.length>8192)throw bad();
 return {url,shop:decodeShopPayload(url.hash.slice(1))};
}
export function parsePublicOrderingLink(value:unknown):PublicOrderingLink{
 const r=publicRecord(value,['v','sourceUrl','apiUrl','shopToken','table']);
 if(Object.keys(r).sort().join(',')!=='apiUrl,shopToken,sourceUrl,table,v'||r.v!==1||typeof r.sourceUrl!=='string'||typeof r.shopToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.shopToken)||!(r.table===null||typeof r.table==='string'))throw bad();
 const source=publicOrderShopSource(r.sourceUrl);
 return {v:1,sourceUrl:source.url.href,apiUrl:customerApiOrigin(r.apiUrl),shopToken:r.shopToken,table:r.table===null?null:publicText(r.table,40,false,true)};
}
export function publicOrderingUrl(value:PublicOrderingLink):string{
 const link=parsePublicOrderingLink(value),{url}=publicOrderShopSource(link.sourceUrl);
 url.pathname=url.pathname.replace(/s\/$/,'o/');url.searchParams.set('flags','publicOrders');url.hash='mise-order='+encodeURIComponent(JSON.stringify(link));return url.href;
}
export function decodePublicOrdering(hash:string,location?:string):{shop:PublicShop;link:PublicOrderingLink|null}{
 if(!hash.startsWith('#mise-order='))return {shop:decodeShopPayload(hash.replace(/^#/,'')),link:null};
 if(hash.length>20000)throw bad();let raw:unknown;try{raw=JSON.parse(decodeURIComponent(hash.slice(12)));}catch{throw bad();}
 const link=parsePublicOrderingLink(raw),source=publicOrderShopSource(link.sourceUrl);
 if(location){const current=new URL(location);if(current.origin!==source.url.origin||current.pathname!==source.url.pathname.replace(/s\/$/,'o/'))throw bad();}
 return {shop:source.shop,link};
}
