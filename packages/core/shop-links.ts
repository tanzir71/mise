import { ulid } from 'ulid';
import type { AuditEvent,Category,Item,Outlet,SetupSnapshot } from './models';
import { normalisePhone } from './phone';
import { validateShop } from './shop-access';
import { publicRecord,publicText,PUBLIC_SHOP_MAX_ITEMS,type PublicShop,type PublicShopItem } from './public-shop';
import { decodeShopPayload,publicShopUrl } from './public-shop-codec';

export interface ShopLinkInput {phone:string;hours:string;deliveryNote:string;mode:'list'|'menu';itemIds:string[]}
export interface ShopLinkContext {setup:SetupSnapshot;items:Item[];categories:Category[]}
export interface ShopLinkReview {previousUrl:string|null;sourceToken:string}
function selection(context:ShopLinkContext,ids:string[]):PublicShopItem[]{
  if(!Array.isArray(ids)||ids.length>PUBLIC_SHOP_MAX_ITEMS||new Set(ids).size!==ids.length)throw new Error(`Choose at most ${PUBLIC_SHOP_MAX_ITEMS} different items.`);
  return ids.map(id=>{
    const item=context.items.find(item=>item.id===id&&item.outletId===context.setup.outlet.id);if(!item)throw new Error('A selected item changed or was removed. Review the item list.');
    return {id:item.id,name:item.name,nameLocal:item.nameLocal,unit:item.unit,price:item.price,category:context.categories.find(category=>category.id===item.categoryId&&category.outletId===item.outletId)?.name||'',available:item.available,oftenBought:item.oftenBought===true};
  });
}
export function shopLinkSourceToken(context:ShopLinkContext,ids:string[]):string{
  validateShop(context.setup);const {business,outlet,owner}=context.setup;
  return JSON.stringify({businessId:business.id,outletId:outlet.id,ownerId:owner.id,ownerPhone:owner.phone,market:business.marketCode,name:outlet.name,address:outlet.address,currency:outlet.currency,timezone:outlet.timezone,items:selection(context,ids)});
}
export function reviewShopLink(context:ShopLinkContext,ids:string[]):ShopLinkReview{return {previousUrl:context.setup.outlet.shopLink??null,sourceToken:shopLinkSourceToken(context,ids)};}
function previousCode(link?:string):string|undefined{
  if(!link)return;
  try{const url=new URL(link);if(url.pathname.endsWith('/app/s/'))return decodeShopPayload(url.hash.slice(1)).code;}catch{/* A legacy shop URL can be replaced explicitly by Generate. */}
}
export function generateShopLinkCommand(input:ShopLinkInput,context:ShopLinkContext,review:ShopLinkReview,appBaseUrl:string,at=Date.now()):{outlet:Outlet;event:AuditEvent;shop:PublicShop}{
  validateShop(context.setup);publicRecord(input,['phone','hours','deliveryNote','mode','itemIds']);
  if(!review||review.previousUrl!==(context.setup.outlet.shopLink??null)||review.sourceToken!==shopLinkSourceToken(context,input.itemIds))throw new Error('The shop or catalogue changed. Review the link settings before generating again.');
  const phone=typeof input.phone==='string'?normalisePhone(input.phone,context.setup.business.marketCode):null;if(!phone)throw new Error('Enter the shop’s public WhatsApp phone number.');
  const {outlet,business,owner}=context.setup,prefix=outlet.name.normalize('NFKD').trim().split(/\s+/).map(word=>word.match(/[a-z]/i)?.[0]||'').join('').slice(0,2).toUpperCase()||'MS';
  const shop:PublicShop={v:1,code:previousCode(outlet.shopLink)||`${prefix}-${ulid(at).slice(-8)}`,edition:ulid(at),publishedAt:at,name:outlet.name,address:outlet.address,hours:publicText(input.hours,200,true),phone,deliveryNote:publicText(input.deliveryNote,400,true),market:business.marketCode,currency:outlet.currency,timezone:outlet.timezone,mode:input.mode,items:selection(context,input.itemIds)};
  const url=publicShopUrl(appBaseUrl,shop);
  return {outlet:{...outlet,shopLink:url,updatedAt:at},shop,event:{id:ulid(at),outletId:outlet.id,actor:{type:'member',id:owner.id},command:'shopLink.generate',before:{url:outlet.shopLink??null},after:{url},at}};
}
export function undoShopLinkCommand(source:AuditEvent,setup:SetupSnapshot,at=Date.now()):{outlet:Outlet;event:AuditEvent}{
  validateShop(setup);
  if(source.command!=='shopLink.generate'||source.outletId!==setup.outlet.id||source.actor.type!=='member'||source.actor.id!==setup.owner.id||at<source.at||at-source.at>600000)throw new Error('Undo your last link change within ten minutes.');
  const before=publicRecord(source.before,['url']),after=publicRecord(source.after,['url']);
  if((before.url!==null&&typeof before.url!=='string')||typeof after.url!=='string'||setup.outlet.shopLink!==after.url)throw new Error('Only the latest link change can be undone once.');
  const outlet={...setup.outlet,updatedAt:at};if(before.url===null)delete outlet.shopLink;else outlet.shopLink=before.url;
  return {outlet,event:{id:ulid(at),outletId:outlet.id,actor:{type:'member',id:setup.owner.id},command:'shopLink.undo',before:{url:after.url},after:{url:before.url},undoOf:source.id,at}};
}
