import {decodeShopPayload,publicShopUrl} from './public-shop-codec';
import type {PublicShop} from './public-shop';
import type {ShopLinkReview} from './shop-links';
export const linkBodyHeader='X-Mise-Shop-Link-Write',linkBodyLimit=256000;
interface LinkBase {id:string;outletId:string;ownerId:string;occurredAt:number}
export type LinkCommand=(LinkBase&{type:'shopLink.generate';review:ShopLinkReview;url:string})|(LinkBase&{type:'shopLink.undo';sourceId:string});
export interface LinkCommandReceipt extends LinkBase {type:LinkCommand['type'];at:number;outletUpdatedAt:number}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export function isLinkCommandType(v:unknown):v is LinkCommand['type']{return v==='shopLink.generate'||v==='shopLink.undo';}
export function publishedLink(url:string):{base:string;shop:PublicShop}{
 const u=new URL(url);if(url.length>linkBodyLimit||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||!u.pathname.endsWith('/app/s/'))throw new Error('Keep the original public Mise URL.');
 const shop=decodeShopPayload(u.hash.slice(1));u.hash='';u.pathname=u.pathname.slice(0,-2);const base=u.href;if(publicShopUrl(base,shop)!==url)throw new Error('Keep the exact canonical public shop URL.');return {base,shop};
}
export function parseLinkCommand(v:unknown):LinkCommand{
 if(!object(v)||!isLinkCommandType(v.type)||![v.id,v.outletId,v.ownerId].every(id)||new Set([v.id,v.outletId,v.ownerId]).size!==3||!time(v.occurredAt))throw new Error('Keep the original link action, member and time.');
 const base={id:v.id as string,outletId:v.outletId as string,ownerId:v.ownerId as string,occurredAt:v.occurredAt};
 if(v.type==='shopLink.undo'&&exact(v,'id,type,outletId,ownerId,occurredAt,sourceId')&&id(v.sourceId)&&![v.id,v.outletId,v.ownerId].includes(v.sourceId))return {...base,type:v.type,sourceId:v.sourceId};
 if(v.type!=='shopLink.generate'||!exact(v,'id,type,outletId,ownerId,occurredAt,review,url')||typeof v.url!=='string'||!object(v.review)||!exact(v.review,'previousUrl,sourceToken')||!(v.review.previousUrl===null||typeof v.review.previousUrl==='string'&&v.review.previousUrl.length<=linkBodyLimit)||typeof v.review.sourceToken!=='string'||v.review.sourceToken.length>64000)throw new Error('Keep the original reviewed link.');
 const {shop}=publishedLink(v.url),s:unknown=JSON.parse(v.review.sourceToken);
 if(shop.publishedAt!==v.occurredAt||!id(shop.edition)||shop.edition===v.id||!shop.items.every(item=>id(item.id))||!object(s)||!exact(s,'businessId,outletId,ownerId,ownerPhone,market,name,address,currency,timezone,items')||!id(s.businessId)||s.outletId!==v.outletId||s.ownerId!==v.ownerId||typeof s.ownerPhone!=='string'||!/^\+[1-9][0-9]{6,14}$/.test(s.ownerPhone)||s.market!==shop.market||s.name!==shop.name||s.address!==shop.address||s.currency!==shop.currency||s.timezone!==shop.timezone||JSON.stringify(s.items)!==JSON.stringify(shop.items))throw new Error('Keep every reviewed public field and original publication identity.');
 const result:LinkCommand={...base,type:v.type,review:{previousUrl:v.review.previousUrl,sourceToken:v.review.sourceToken},url:v.url};if(new TextEncoder().encode(JSON.stringify(result)).length>linkBodyLimit)throw new Error('Keep a complete local copy of this oversized link action.');return result;
}
export function linkWritePlan(command:LinkCommand){const c=parseLinkCommand(command);return {url:c.type==='shopLink.generate'?c.url:null,reviewJson:c.type==='shopLink.generate'?JSON.stringify(c.review):null,sourceId:c.type==='shopLink.undo'?c.sourceId:null,intentJson:JSON.stringify(c)};}
export function parseLinkCommandReceipt(v:unknown,c:LinkCommand):LinkCommandReceipt{
 if(!object(v)||!exact(v,'id,type,outletId,ownerId,occurredAt,at,outletUpdatedAt')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.ownerId!==c.ownerId||v.occurredAt!==c.occurredAt||!time(v.at)||!time(v.outletUpdatedAt)||v.outletUpdatedAt<Math.max(v.at,c.occurredAt))throw new Error('Invalid original link action receipt.');
 return {id:c.id,type:c.type,outletId:c.outletId,ownerId:c.ownerId,occurredAt:c.occurredAt,at:v.at,outletUpdatedAt:v.outletUpdatedAt};
}
