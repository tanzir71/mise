import {decodeCommandRecord} from '../../../packages/core/cloud-records.ts';
import {parseLinkCommand,publishedLink,type LinkCommand} from '../../../packages/core/link-commands.ts';
import {generateReviewedShopLinkCommand,undoShopLinkCommand,type ShopLinkSetup} from '../../../packages/core/shop-links.ts';
import type {Business,Outlet,AuditEvent} from '../../../packages/core/models.ts';
export class LinkMutationInvalid extends Error {}
export class LinkMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function linkFingerprint(c:LinkCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseLinkCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
/** Validate the original frozen publication; SQL alone builds mutation/audit/receipt. */
export function linkWriteFields(value:unknown,command:LinkCommand,ticketId:string):Record<string,unknown>{
 const c=parseLinkCommand(command);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||value.actorId!==c.ownerId||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid shop-link preparation.');
 const raw:unknown=JSON.parse(value.contextJson);if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!object(raw.actor)||typeof raw.undone!=='boolean')throw new Error('Invalid shop-link source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,actor=decodeCommandRecord('members',raw.actor);
 if(business.id!==value.businessId||outlet.businessId!==business.id||outlet.id!==c.outletId||actor.id!==c.ownerId||actor.businessId!==business.id||actor.active!==true||!['owner','manager'].includes(actor.role as string))throw new Error('Invalid shop-link scope.');
 if(c.occurredAt>value.at+300000)throw new LinkMutationConflict('Check the device clock and retain the original link action.');
 const setup:ShopLinkSetup={business,outlet,owner:{id:c.ownerId,businessId:business.id,active:true,outletIds:[outlet.id],phone:typeof actor.phone==='string'?actor.phone:''}};
 try{
  let url:string|null;
  if(c.type==='shopLink.generate'){
   const {base,shop}=publishedLink(c.url),frozen=JSON.parse(c.review.sourceToken);
   if(frozen.businessId!==business.id)throw Error('Foreign reviewed business.');
   const reviewed:ShopLinkSetup={business:{...business,marketCode:shop.market},outlet:{...outlet,name:shop.name,address:shop.address,currency:shop.currency,timezone:shop.timezone,shopLink:c.review.previousUrl??undefined},owner:{...setup.owner,phone:frozen.ownerPhone}};
   const change=generateReviewedShopLinkCommand({phone:shop.phone,hours:shop.hours,deliveryNote:shop.deliveryNote,mode:shop.mode,itemIds:shop.items.map(i=>i.id)},reviewed,shop.items,c.review,base,c.occurredAt,{code:shop.code,edition:shop.edition,eventId:c.id});
   if(change.outlet.shopLink!==c.url)throw Error('Publication changed.');url=c.url;
  }else{
   if(!object(raw.source)||!time(raw.sourceOccurredAt)||raw.undone)throw Error('Original generation unavailable.');
   const source={...decodeCommandRecord('events',raw.source),at:raw.sourceOccurredAt} as unknown as AuditEvent;
   if(source.id!==c.sourceId)throw Error('Original generation changed.');url=undoShopLinkCommand(source,setup,c.occurredAt,()=>c.id).outlet.shopLink??null;
  }
  return {p_ticket_id:ticketId,p_token:value.token,p_result_json:JSON.stringify({url})};
 }catch{throw new LinkMutationConflict('The reviewed link or its original generation changed. Keep the local link and review it.');}
}
