import type { MiseDatabase } from './db';
import type { ShopLinkInput,ShopLinkReview,ShopLinkContext } from '@mise/core/shop-links';
import { generateShopLinkCommand,undoShopLinkCommand } from '@mise/core/shop-links';
import type { AuditEvent } from '@mise/core/models';
import {parseLinkCommand,type LinkCommand} from '@mise/core/link-commands';
import {withOutboxIntent} from './outbox-capture';

async function context(db:MiseDatabase):Promise<ShopLinkContext>{
  const [setup,items,categories]=await Promise.all([db.setup(),db.items.toArray(),db.categories.toArray()]);if(!setup)throw new Error('Set up your shop first.');return {setup,items,categories};
}
export async function generateDatabaseShopLink(db:MiseDatabase,input:ShopLinkInput,review:ShopLinkReview,base:string):Promise<AuditEvent>{
  return db.transaction('rw',[db.businesses,db.outlets,db.members,db.items,db.categories,db.events],async()=>{
    const change=generateShopLinkCommand(input,await context(db),review,base),event=change.event;
    const write=async()=>{await db.outlets.put(change.outlet);await db.events.add(event);return event;};
    let intent:LinkCommand|undefined;try{intent=parseLinkCommand({id:event.id,type:'shopLink.generate',outletId:event.outletId,ownerId:event.actor.id,occurredAt:event.at,review,url:change.outlet.shopLink});}catch{/* Keep unsupported legacy/oversized links as complete local recovery writes. */}
    return intent?withOutboxIntent(db,intent,write):write();
  });
}
export async function undoDatabaseShopLink(db:MiseDatabase,id:string):Promise<void>{
  await db.transaction('rw',db.businesses,db.outlets,db.members,db.events,async()=>{
    const [setup,source]=await Promise.all([db.setup(),db.events.get(id)]);if(!setup||!source)throw new Error('The link change could not be found.');
    if(await db.events.where('command').equals('shopLink.undo').filter(event=>event.undoOf===id).first())throw new Error('This link change has already been undone.');
    const change=undoShopLinkCommand(source,setup),event=change.event;
    await withOutboxIntent(db,{id:event.id,type:'shopLink.undo',outletId:event.outletId,ownerId:event.actor.id,occurredAt:event.at,sourceId:source.id},async()=>{await db.outlets.put(change.outlet);await db.events.add(event);});
  });
}
