import { ulid } from 'ulid';
import type { AuditEvent, SetupSnapshot } from './models';
import {inboxImageTypes,validateInboxImageBytes,type InboxImageType} from './inbox-image';
export {inboxImageTypes,validateInboxImageBytes,type InboxImageType} from './inbox-image';

export const inboxLimits = { title:200, text:12000, url:2400, files:4, imageBytes:5*1024*1024, totalBytes:10*1024*1024 } as const;
export const inboxKinds = ['unclassified','order','payment','stock','question','other'] as const;
export type InboxKind = typeof inboxKinds[number];
export interface InboxImage { id:string; name:string; type:InboxImageType; size:number }
export interface InboxItem<Image extends InboxImage = InboxImage> {
  id:string;outletId:string|null;revision:number;title:string;text:string;url:string;images:Image[];
  kind:InboxKind;archived:boolean;createdAt:number;updatedAt:number;
}
export interface InboxContent<Image extends InboxImage = InboxImage> { title:string;text:string;url:string;images:Image[] }
export interface InboxBackupImage extends InboxImage { data:string }
export type InboxBackupItem = InboxItem<InboxBackupImage>;
export function newInboxId(at=Date.now()):string {time(at);return ulid(at);}
export function assertInboxId(id:unknown):asserts id is string {
  if(typeof id!=='string'||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))throw new Error('Invalid Inbox record ID.');
}
function time(at:number):void {if(!Number.isSafeInteger(at)||at<0||at>253402300799999)throw new Error('Invalid Inbox time.');}
export function validateInboxContent(input:InboxContent):void {
  for(const key of ['title','text','url'] as const)if(typeof input[key]!=='string'||input[key].length>inboxLimits[key])throw new Error(`Shared ${key} exceeds the ${inboxLimits[key].toLocaleString('en')} character limit.`);
  if(!Array.isArray(input.images)||input.images.length>inboxLimits.files)throw new Error('Share up to four images at a time.');
  let bytes=0;const ids=new Set<string>();
  for(const image of input.images){
    assertInboxId(image.id);if(ids.has(image.id))throw new Error('Shared images contain duplicate IDs.');ids.add(image.id);
    if(typeof image.name!=='string'||image.name.length>200||!(inboxImageTypes as readonly unknown[]).includes(image.type))throw new Error('Use JPEG, PNG or WebP images with names up to 200 characters.');
    if(!Number.isSafeInteger(image.size)||image.size<=0||image.size>inboxLimits.imageBytes)throw new Error('Each shared image must be between 1 byte and 5 MB.');
    bytes+=image.size;
  }
  if(bytes>inboxLimits.totalBytes)throw new Error('Share up to 10 MB of images at a time.');
  if(!input.title.trim()&&!input.text.trim()&&!input.url.trim()&&!input.images.length)throw new Error('Share some text, a link or an image.');
}
export function validateInboxItem(item:InboxItem):void {
  assertInboxId(item.id);if(item.outletId!==null)assertInboxId(item.outletId);
  validateInboxContent(item);time(item.createdAt);time(item.updatedAt);
  if(!Number.isSafeInteger(item.revision)||item.revision<1||!inboxKinds.includes(item.kind)||typeof item.archived!=='boolean'||item.updatedAt<item.createdAt)throw new Error('Invalid Inbox state.');
  if(item.outletId===null&&(item.revision!==1||item.kind!=='unclassified'||item.archived))throw new Error('Unassigned shares must wait for shop setup before sorting.');
}
/** Only metadata goes into audit history. The original image bytes are stored once. */
export function inboxSnapshot(item:InboxItem):InboxItem {
  return {...item,images:item.images.map(({id,name,type,size})=>({id,name,type,size}))};
}
function event(item:InboxItem,before:InboxItem|null,setup:SetupSnapshot,command:string):AuditEvent {
  return {id:ulid(item.updatedAt),outletId:setup.outlet.id,inboxId:item.id,inboxRevision:item.revision,actor:{type:'member',id:setup.owner.id},command,before:before?inboxSnapshot(before):null,after:inboxSnapshot(item),at:item.updatedAt};
}
export function captureInboxCommand<Image extends InboxImage>(input:InboxContent<Image>,setup:SetupSnapshot|null,at=Date.now(),id=ulid(at)):{item:InboxItem<Image>;event?:AuditEvent} {
  validateInboxContent(input);time(at);assertInboxId(id);
  const item:InboxItem<Image>={id,outletId:setup?.outlet.id??null,revision:1,title:input.title,text:input.text,url:input.url,images:[...input.images],kind:'unclassified',archived:false,createdAt:at,updatedAt:at};
  return {item,...(setup?{event:event(item,null,setup,'inbox.capture')}:{})};
}
export function claimInboxCommand<Image extends InboxImage>(before:InboxItem<Image>,setup:SetupSnapshot,at=Date.now()):{item:InboxItem<Image>;event:AuditEvent} {
  validateInboxItem(before);time(at);if(before.outletId!==null)throw new Error('This shared item already belongs to a shop.');
  const item={...before,outletId:setup.outlet.id,updatedAt:Math.max(at,before.updatedAt)};
  return {item,event:event(item,null,setup,'inbox.capture')};
}
export function changeInboxCommand<Image extends InboxImage>(before:InboxItem<Image>,setup:SetupSnapshot,revision:number,change:{kind:InboxKind}|{archived:boolean},at=Date.now()):{item:InboxItem<Image>;event:AuditEvent}|null {
  validateInboxItem(before);time(at);
  if(before.outletId!==setup.outlet.id)throw new Error('Shared item not found in this shop.');
  if(before.revision!==revision)throw new Error('This shared item changed. Reload it before sorting.');
  if(Object.keys(change).length!==1||('kind' in change? !inboxKinds.includes(change.kind):typeof change.archived!=='boolean'))throw new Error('Choose a supported Inbox action.');
  if('kind' in change?before.kind===change.kind:before.archived===change.archived)return null;
  const item={...before,...change,revision:before.revision+1,updatedAt:Math.max(at,before.updatedAt)};
  return {item,event:event(item,before,setup,'kind' in change?'inbox.classify':change.archived?'inbox.archive':'inbox.reopen')};
}
export function inboxImageBase64(bytes:Uint8Array):string {
  let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(binary);
}
export function inboxImageBytes(image:InboxBackupImage):Uint8Array {
  if(typeof image.data!=='string'||image.data.length!==4*Math.ceil(image.size/3)||/[^A-Za-z0-9+/=]/.test(image.data))throw new Error('Invalid Inbox image data in the backup.');
  const binary=atob(image.data);if(binary.length!==image.size||btoa(binary)!==image.data)throw new Error('The Inbox image size or encoding is inconsistent.');
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));validateInboxImageBytes(image.type,bytes);return bytes;
}
