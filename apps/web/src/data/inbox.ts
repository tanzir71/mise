import type { MiseDatabase } from './db';
import { newInboxId, captureInboxCommand, changeInboxCommand, claimInboxCommand, inboxImageBase64, inboxImageBytes, validateInboxContent, validateInboxImageBytes, type InboxBackupItem, type InboxContent, type InboxImage, type InboxImageType, type InboxItem, type InboxKind } from '@mise/core/inbox';

export interface StoredInboxImage extends InboxImage { blob:Blob }
export type StoredInboxItem = InboxItem<StoredInboxImage>;
export interface SharedInboxInput { title?:string;text?:string;url?:string;files?:readonly File[] }

/** Validate sizes before allocating buffers; never fetch a shared URL or interpret text. */
export async function prepareInboxContent(input:SharedInboxInput):Promise<InboxContent<StoredInboxImage>> {
  const images=(input.files??[]).map(file=>({id:newInboxId(),name:file.name,type:file.type as InboxImageType,size:file.size,blob:file.slice(0,file.size,file.type)}));
  const content={title:input.title??'',text:input.text??'',url:input.url??'',images};validateInboxContent(content);
  await Promise.all(images.map(async image=>validateInboxImageBytes(image.type,new Uint8Array(await image.blob.slice(0,12).arrayBuffer()))));
  return content;
}
export async function captureDatabaseInbox(db:MiseDatabase,input:SharedInboxInput):Promise<StoredInboxItem> {
  const content=await prepareInboxContent(input);
  return db.transaction('rw',db.inboxItems,db.businesses,db.outlets,db.members,db.events,async()=>{
    const command=captureInboxCommand(content,await db.setup());
    await db.inboxItems.add(command.item);if(command.event)await db.events.add(command.event);return command.item;
  });
}
export async function claimDatabaseInbox(db:MiseDatabase):Promise<void> {
  const setup=await db.setup();if(!setup)return;
  const pending=(await db.inboxItems.toArray()).filter(item=>item.outletId===null);
  for(const before of pending){const command=claimInboxCommand(before,setup);await db.inboxItems.put(command.item);await db.events.add(command.event);}
}
export async function changeDatabaseInbox(db:MiseDatabase,id:string,revision:number,change:{kind:InboxKind}|{archived:boolean}):Promise<StoredInboxItem> {
  return db.transaction('rw',db.inboxItems,db.businesses,db.outlets,db.members,db.events,async()=>{
    const setup=await db.setup(),before=await db.inboxItems.get(id);if(!setup||!before)throw new Error('Shared item not found.');
    const command=changeInboxCommand(before,setup,revision,change);if(!command)return before;
    await db.inboxItems.put(command.item);await db.events.add(command.event);return command.item;
  });
}
/** Blob reads are asynchronous; callers inside a transaction must use Dexie.waitFor. */
export async function portableInboxItems(items:StoredInboxItem[]):Promise<InboxBackupItem[]> {
  return Promise.all(items.map(async item=>({...item,images:await Promise.all(item.images.map(async({blob,...image})=>({ ...image,data:inboxImageBase64(new Uint8Array(await blob.arrayBuffer())) })))})));
}
/** Decode and validate before opening the replacement transaction. */
export function storedInboxItems(items:InboxBackupItem[]):StoredInboxItem[] {
  return items.map(item=>({...item,images:item.images.map(({data,...image})=>({...image,blob:new Blob([inboxImageBytes({...image,data}) as Uint8Array<ArrayBuffer>],{type:image.type})}))}));
}
