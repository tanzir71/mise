import {validateInboxItem,inboxImageBytes,type InboxItem,type InboxBackupImage} from './inbox';
import type {LocalOutboxEntry} from './local-outbox';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string)=>Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
/** A device-only source has no shop actor, command or server receipt. This narrow
 * exemption never acknowledges it, changes its queue record or permits raw writes. */
export function isLocalInboxRetention(group:LocalOutboxEntry):boolean {
 if(!group||group.status!=='retained'||!Array.isArray(group.commands)||!Array.isArray(group.receipts)||!Array.isArray(group.changes)||group.commands.length||group.receipts.length||!group.changes.length)return false;
 const ids=new Set<string>();
 try{for(const change of group.changes){
  const row=change.after;
  if(change.table!=='inboxItems'||change.before!==null||!object(row)||row.id!==change.key||row.outletId!==null||ids.has(change.key)||!exact(row,'id,outletId,revision,title,text,url,images,kind,archived,createdAt,updatedAt')||row.createdAt!==row.updatedAt)return false;
  ids.add(change.key);validateInboxItem(row as unknown as InboxItem);
  for(const image of row.images as Record<string,unknown>[]){
   if(exact(image,'id,name,type,size,data'))inboxImageBytes(image as unknown as InboxBackupImage);
   else if(!exact(image,'id,name,type,size,blob')||typeof Blob==='undefined'||!(image.blob instanceof Blob)||image.blob.size!==image.size||image.blob.type!==image.type)return false;
  }
 }}catch{return false;}return true;
}
