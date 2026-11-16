import type { MiseDatabase } from './db';
import type { ShopLinkInput,ShopLinkReview,ShopLinkContext } from '@mise/core/shop-links';
import { generateShopLinkCommand,undoShopLinkCommand } from '@mise/core/shop-links';
import type { AuditEvent } from '@mise/core/models';

async function context(db:MiseDatabase):Promise<ShopLinkContext>{
  const [setup,items,categories]=await Promise.all([db.setup(),db.items.toArray(),db.categories.toArray()]);if(!setup)throw new Error('Set up your shop first.');return {setup,items,categories};
}
export async function generateDatabaseShopLink(db:MiseDatabase,input:ShopLinkInput,review:ShopLinkReview,base:string):Promise<AuditEvent>{
  return db.transaction('rw',[db.businesses,db.outlets,db.members,db.items,db.categories,db.events],async()=>{
    const change=generateShopLinkCommand(input,await context(db),review,base);await db.outlets.put(change.outlet);await db.events.add(change.event);return change.event;
  });
}
export async function undoDatabaseShopLink(db:MiseDatabase,id:string):Promise<void>{
  await db.transaction('rw',db.businesses,db.outlets,db.members,db.events,async()=>{
    const [setup,source]=await Promise.all([db.setup(),db.events.get(id)]);if(!setup||!source)throw new Error('The link change could not be found.');
    if(await db.events.where('command').equals('shopLink.undo').filter(event=>event.undoOf===id).first())throw new Error('This link change has already been undone.');
    const change=undoShopLinkCommand(source,setup);await db.outlets.put(change.outlet);await db.events.add(change.event);
  });
}
