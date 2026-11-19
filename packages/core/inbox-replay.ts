import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {inboxCommandMutation,parseInboxCommand,type InboxCommand} from './inbox-commands';
import {validateInboxItem,type InboxItem,type InboxImage} from './inbox';
import {inboxSnapshotToken,validateInboxSnapshot} from './inbox-history';
import type {AuditEvent,Business,Outlet} from './models';
import type {ShopSetup} from './shop-access';
export class InboxMutationInvalid extends Error {}
export class InboxMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
export async function inboxFingerprint(c:InboxCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseInboxCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
export function replayInboxRecords(value:unknown,command:InboxCommand):CloudRecord[] {
 const c=parseInboxCommand(command);
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid Inbox preparation.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!(raw.item===null||object(raw.item))||!(raw.latest===null||object(raw.latest))||!Array.isArray(raw.images)||!raw.images.every(object))throw new Error('Invalid Inbox source records.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id)throw new Error('Invalid Inbox shop scope.');
 const setup:ShopSetup={business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}};
 const images:InboxImage[]=raw.images.map((r,position)=>{if(r.business_id!==business.id||r.outlet_id!==outlet.id||r.inbox_item_id!==c.itemId||r.position!==position||!id(r.id)||typeof r.name!=='string'||typeof r.type!=='string'||typeof r.size!=='number'||typeof r.sha256!=='string'||!/^[0-9a-f]{64}$/.test(r.sha256))throw new Error('Invalid original image metadata.');return {id:r.id,name:r.name,type:r.type as InboxImage['type'],size:r.size};});
 const before=raw.item?{...decodeCommandRecord('inboxItems',raw.item as Record<string,unknown>),images} as unknown as InboxItem:null;
 if(before&&(before.id!==c.itemId||before.outletId!==outlet.id||raw.item&&raw.item.business_id!==business.id))throw new Error('Invalid Inbox source scope.');
 let result:{item:InboxItem;event?:AuditEvent};
 try{
  if(c.occurredAt>value.at+300000||c.type==='inbox.capture'&&c.createdAt>value.at+300000)throw new InboxMutationConflict('Check the device clock and retain the original source.');
  if(c.type==='inbox.change'){
   if(!before)throw new Error('Keep the original shared source.');validateInboxItem(before);
   if(before.revision!==c.revision)throw new InboxMutationConflict('Review the latest Inbox state before sorting.');
   if(!raw.latest)throw new Error('The source history is missing.');const latest=decodeCommandRecord('events',raw.latest as Record<string,unknown>) as unknown as AuditEvent;
   if(latest.inboxId!==c.itemId||latest.outletId!==outlet.id||latest.inboxRevision!==before.revision||latest.at!==before.updatedAt||latest.actor.type!=='member'||!['inbox.capture','inbox.classify','inbox.archive','inbox.reopen'].includes(latest.command)||inboxSnapshotToken(validateInboxSnapshot(latest.after))!==inboxSnapshotToken(before))throw new Error('Keep the complete original source history.');
  }else if(before||raw.latest||images.length)throw new InboxMutationConflict('This Inbox source identity already exists.');
  result=inboxCommandMutation(c,setup,before);
 }catch(error){if(error instanceof InboxMutationConflict)throw error;throw new InboxMutationInvalid('Review the exact original source, image metadata and manual sorting action.');}
 const records:CloudRecord[]=[];
 if(result.event){
  records.push(encodeCommandRecord('inboxItems',result.item,business.id));
  if(c.type==='inbox.capture')for(const [position,image] of c.input.images.entries())records.push({table:'inbox_images',values:{id:image.id,business_id:business.id,outlet_id:outlet.id,inbox_item_id:c.itemId,position,name:JSON.stringify(image.name),type:image.type,size:image.size,sha256:image.sha256,created_at:result.item.createdAt,updated_at:result.item.createdAt,uploaded_at:null}});
  records.push(encodeCommandRecord('events',result.event,business.id));
 }else{const metadata={type:c.type,itemId:c.itemId,revision:result.item.revision,change:c.type==='inbox.change'?c.change:null};records.push(encodeCommandRecord('events',{id:c.id,outletId:outlet.id,actor:{type:'member',id:value.actorId},command:'command.noop',before:metadata,after:metadata,at:value.at} satisfies AuditEvent,business.id));}
 return records;
}
