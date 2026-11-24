import type { LocalStore } from './local-store';
import { newInboxId, captureInboxCommand, changeInboxCommand, claimInboxCommand, inboxImageBase64, inboxImageBytes, validateInboxContent, validateInboxImageBytes, type InboxBackupItem, type InboxContent, type InboxImage, type InboxImageType, type InboxItem, type InboxKind } from '@mise/core/inbox';
import {inboxCaptureIntent,inboxChangeIntent} from '@mise/core/inbox-intent';
import {withOutboxIntent} from './outbox-capture';
import Dexie from 'dexie';
import {OperatorContextError,resolveOperator,parseLocalOperatorState} from '@mise/core/operators';
import {syncDownloadToken} from '@mise/core/sync-download';
import type {LocalCloudState} from '@mise/core/local-outbox';

export interface StoredInboxImage extends InboxImage { blob:Blob }
export type StoredInboxItem = InboxItem<StoredInboxImage>;
export interface SharedInboxInput { title?:string;text?:string;url?:string;files?:readonly File[] }
export interface InboxDestination {businessId:string;outletId:string;actorId:string;selectionToken?:string;bindingToken?:string}
/** Identity/authority fields only; normal delivery progress does not retarget a
 * saved-image review or force its unsaved edits to restart. */
export function captureBindingToken(state:LocalCloudState|undefined):string{return syncDownloadToken(state?{uploadId:state.uploadId,businessId:state.businessId,outletId:state.outletId,actorId:state.ownerId,targetHash:state.targetHash,manifestHash:state.manifestHash,accountHash:state.join?.accountHash??null,role:state.join?.role??null,epoch:state.join?.epoch??null,scopeVersion:state.join?.scopeVersion??null,recovery:state.recovery?.scope??null}:null);}

/** Validate sizes before allocating buffers; never fetch a shared URL or interpret text. */
export async function prepareInboxContent(input:SharedInboxInput):Promise<InboxContent<StoredInboxImage>> {
  const images=(input.files??[]).map(file=>({id:newInboxId(),name:file.name,type:file.type as InboxImageType,size:file.size,blob:file.slice(0,file.size,file.type)}));
  const content={title:input.title??'',text:input.text??'',url:input.url??'',images};validateInboxContent(content);
  await Promise.all(images.map(async image=>validateInboxImageBytes(image.type,new Uint8Array(await image.blob.slice(0,12).arrayBuffer()))));
  return content;
}
/** Hash full immutable blobs before opening the writer, including in the share worker. */
async function captureImageHashes(images:readonly StoredInboxImage[]):Promise<string[]|null> {
  if(!images.length)return [];
  const subtle=globalThis.crypto?.subtle;if(!subtle)return null;
  return Promise.all(images.map(async image=>{
    const bytes=await image.blob.arrayBuffer();if(bytes.byteLength!==image.size)throw new Error('Keep the complete original shared image.');
    return Array.from(new Uint8Array(await subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  }));
}
export async function captureDatabaseInbox(db:LocalStore,input:SharedInboxInput,destination?:InboxDestination):Promise<StoredInboxItem> {
  input={...input,files:input.files?[...input.files]:undefined};destination=destination?structuredClone(destination):undefined;
  const selection=destination?await db.transaction('r',db.tables,async()=>{const setup=await db.setup(),token=syncDownloadToken(await db.operatorState.get('active')??null),binding=captureBindingToken(await db.cloudState.get('binding'));if(!setup||setup.business.id!==destination!.businessId||setup.outlet.id!==destination!.outletId||setup.owner.id!==destination!.actorId||destination!.selectionToken!==undefined&&destination!.selectionToken!==token||destination!.bindingToken!==undefined&&destination!.bindingToken!==binding)throw new Error('The selected outlet or member changed. Review this image again.');return {token,binding};}):undefined;
  const content=await prepareInboxContent(input),hashes=await captureImageHashes(content.images);
  return db.transaction('rw',[db.inboxItems,db.businesses,db.outlets,db.members,db.events,db.cloudState],async()=>{
    // A pending cloud selection on an empty device grants no shop authority.
    // Keep incoming shares unassigned while its canonical join is in flight.
    let setup:Awaited<ReturnType<LocalStore['setup']>>=null;
    const [businesses,outlets,members,saved]=await Promise.all([db.businesses.toArray(),db.outlets.toArray(),db.members.toArray(),db.operatorState.get('active')]);
    // Catch the pure selection error here: a rejected nested Dexie transaction
    // would abort this receiving writer even when its caller handles the error.
    try{setup=resolveOperator(businesses,outlets,members,saved===undefined?null:parseLocalOperatorState(saved));}catch(error){if(!(error instanceof OperatorContextError))throw error;}
    if(destination&&(!setup||setup.business.id!==destination.businessId||setup.outlet.id!==destination.outletId||setup.owner.id!==destination.actorId||syncDownloadToken(saved??null)!==selection!.token||captureBindingToken(await db.cloudState.get('binding'))!==selection!.binding))throw new Error('The selected outlet, member or connection changed. Review this image again.');
    const command=captureInboxCommand(content,setup);
    const write=async()=>{await db.inboxItems.add(command.item);if(command.event)await db.events.add(command.event);return command.item;};
    return command.event&&hashes!==null?withOutboxIntent(db,inboxCaptureIntent(command.item,command.event,hashes),write):write();
  });
}
export async function claimDatabaseInbox(db:LocalStore):Promise<void> {
  const setup=await db.setup();if(!setup)return;
  const pending=(await db.inboxItems.toArray()).filter(item=>item.outletId===null);
  for(const before of pending){const command=claimInboxCommand(before,setup);await db.inboxItems.put(command.item);await db.events.add(command.event);}
}
/** The destination is the explicit review shown to the person. A later operator
 * selection cannot silently claim the original source for a different outlet. */
export async function claimDatabaseInboxItem(db:LocalStore,id:string,destination:{businessId:string;outletId:string;actorId:string}):Promise<StoredInboxItem> {
 destination=structuredClone(destination);
 const before=await db.inboxItems.get(id);if(!before||before.outletId!==null)throw new Error('This saved share was already assigned. Open its current Inbox item.');
 const original=syncDownloadToken((await portableInboxItems([before]))[0]);
 for(const image of before.images){if(!(image.blob instanceof Blob)||image.blob.size!==image.size||image.blob.type!==image.type)throw new Error('Keep the complete original shared image.');validateInboxImageBytes(image.type,new Uint8Array(await image.blob.slice(0,12).arrayBuffer()));}
 const hashes=await captureImageHashes(before.images);
 return db.transaction('rw',db.inboxItems,db.businesses,db.outlets,db.members,db.events,async()=>{
  const setup=await db.setup(),current=await db.inboxItems.get(id);
  if(!setup||setup.business.id!==destination.businessId||setup.outlet.id!==destination.outletId||setup.owner.id!==destination.actorId)throw new Error('The selected outlet or member changed. Review this share again.');
  if(!current||syncDownloadToken((await Dexie.waitFor(portableInboxItems([current])))[0])!==original)throw new Error('This saved share changed. Open its current Inbox item.');
  const command=claimInboxCommand(current,setup),write=async()=>{await db.inboxItems.put(command.item);await db.events.add(command.event);return command.item;};
  return hashes!==null?withOutboxIntent(db,inboxCaptureIntent(command.item,command.event,hashes),write):write();
 });
}
export async function changeDatabaseInbox(db:LocalStore,id:string,revision:number,change:{kind:InboxKind}|{archived:boolean}):Promise<StoredInboxItem> {
  return db.transaction('rw',db.inboxItems,db.businesses,db.outlets,db.members,db.events,async()=>{
    const setup=await db.setup(),before=await db.inboxItems.get(id);if(!setup||!before)throw new Error('Shared item not found.');
    const command=changeInboxCommand(before,setup,revision,change);if(!command)return before;
    return withOutboxIntent(db,inboxChangeIntent(before,command.event,change),async()=>{await db.inboxItems.put(command.item);await db.events.add(command.event);return command.item;});
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
