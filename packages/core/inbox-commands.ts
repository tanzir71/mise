import {captureInboxCommand,claimInboxCommand,changeInboxCommand,validateInboxContent,inboxKinds,type InboxContent,type InboxImage,type InboxItem,type InboxKind} from './inbox';
import {validateShop,type ShopSetup} from './shop-access';
import type {AuditEvent} from './models';
export const inboxBodyHeader='X-Mise-Inbox-Write',inboxBodyLimit=256000;
export interface InboxCaptureImage extends InboxImage {sha256:string}
export type InboxCommand=
 |{id:string;type:'inbox.capture';itemId:string;outletId:string;occurredAt:number;createdAt:number;input:InboxContent<InboxCaptureImage>}
 |{id:string;type:'inbox.change';itemId:string;outletId:string;occurredAt:number;revision:number;change:{kind:InboxKind}|{archived:boolean}};
export interface InboxCommandReceipt {id:string;type:InboxCommand['type'];itemId:string;outletId:string;occurredAt:number;at:number;createdAt:number;updatedAt:number;revision:number;kind:InboxKind;archived:boolean;imageCount:number;imageBytes:number;eventId:string|null;changed:boolean}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const time=(v:unknown):v is number=>integer(v,0,253402300799999);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function isInboxCommandType(v:unknown):v is InboxCommand['type']{return v==='inbox.capture'||v==='inbox.change';}
export function parseInboxCommand(v:unknown):InboxCommand {
 if(!object(v)||!id(v.id)||!id(v.itemId)||v.id===v.itemId||!id(v.outletId)||!time(v.occurredAt))throw new Error('Keep the Inbox command, source, outlet and occurrence time.');
 const b={id:v.id,itemId:v.itemId,outletId:v.outletId,occurredAt:v.occurredAt};
 if(v.type==='inbox.capture'&&exact(v,'id,type,itemId,outletId,occurredAt,createdAt,input')&&time(v.createdAt)&&object(v.input)&&exact(v.input,'title,text,url,images')&&Array.isArray(v.input.images)){
  const images=v.input.images.map(image=>{if(!object(image)||!exact(image,'id,name,type,size,sha256')||!id(image.id)||image.id===b.id||image.id===b.itemId||typeof image.name!=='string'||typeof image.type!=='string'||!integer(image.size,1)||typeof image.sha256!=='string'||!/^[0-9a-f]{64}$/.test(image.sha256))throw new Error('Keep every original image identity, type, size and hash.');return {id:image.id,name:image.name,type:image.type as InboxImage['type'],size:image.size,sha256:image.sha256};});
  const input={title:v.input.title,text:v.input.text,url:v.input.url,images} as InboxContent<InboxCaptureImage>;validateInboxContent(input);return {...b,type:v.type,createdAt:v.createdAt,input};
 }
 if(v.type==='inbox.change'&&exact(v,'id,type,itemId,outletId,occurredAt,revision,change')&&integer(v.revision,1)&&object(v.change)){
  if(exact(v.change,'kind')&&inboxKinds.includes(v.change.kind as InboxKind))return {...b,type:v.type,revision:v.revision,change:{kind:v.change.kind as InboxKind}};
  if(exact(v.change,'archived')&&typeof v.change.archived==='boolean')return {...b,type:v.type,revision:v.revision,change:{archived:v.change.archived}};
 }
 throw new Error('Choose an exact original capture or a single reviewed Inbox action.');
}
export function inboxWritePlan(command:InboxCommand){const c=parseInboxCommand(command);return {itemId:c.itemId,createdAt:c.type==='inbox.capture'?c.createdAt:null,revision:c.type==='inbox.change'?c.revision:null,change:c.type==='inbox.change'?c.change:null,input:c.type==='inbox.capture'?{titleJson:JSON.stringify(c.input.title),textJson:JSON.stringify(c.input.text),urlJson:JSON.stringify(c.input.url),images:c.input.images.map(({name,...image})=>({...image,nameJson:JSON.stringify(name)}))}:null,intentJson:JSON.stringify(c)};}
/** The metadata-only capture and manual sorting use the exact local mutation. */
export function inboxCommandMutation(command:InboxCommand,setup:ShopSetup,before:InboxItem|null):{item:InboxItem;event?:AuditEvent} {
 const c=parseInboxCommand(command);validateShop(setup);if(setup.outlet.id!==c.outletId)throw new Error('Use the original source outlet.');
 if(c.type==='inbox.capture'){
  if(before)throw new Error('This source identity already exists.');
  const input={...c.input,images:c.input.images.map(({id,name,type,size})=>({id,name,type,size}))};
  const pending=captureInboxCommand(input,null,c.createdAt,c.itemId).item;return claimInboxCommand(pending,setup,c.occurredAt,()=>c.id);
 }
 if(!before||before.id!==c.itemId)throw new Error('The original shared source is missing.');
 return changeInboxCommand(before,setup,c.revision,c.change,c.occurredAt,()=>c.id)??{item:before};
}
export function parseInboxCommandReceipt(v:unknown,c:InboxCommand):InboxCommandReceipt {
 if(!object(v)||!exact(v,'id,type,itemId,outletId,occurredAt,at,createdAt,updatedAt,revision,kind,archived,imageCount,imageBytes,eventId,changed')||v.id!==c.id||v.type!==c.type||v.itemId!==c.itemId||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!time(v.at)||!time(v.createdAt)||!time(v.updatedAt)||v.updatedAt<v.createdAt||!integer(v.revision,1)||!inboxKinds.includes(v.kind as InboxKind)||typeof v.archived!=='boolean'||!integer(v.imageCount,0,4)||!integer(v.imageBytes,0,10485760)||(v.imageCount===0)!==(v.imageBytes===0)||typeof v.changed!=='boolean'||v.eventId!==(v.changed?c.id:null))throw new Error('Invalid Inbox receipt.');
 if(c.type==='inbox.capture'){
  if(!v.changed||v.revision!==1||v.createdAt!==c.createdAt||v.updatedAt!==Math.max(c.createdAt,c.occurredAt)||v.kind!=='unclassified'||v.archived||v.imageCount!==c.input.images.length||v.imageBytes!==c.input.images.reduce((n,i)=>n+i.size,0))throw new Error('The original capture is unconfirmed.');
 }else if(v.revision<c.revision+(v.changed?1:0)||v.changed&&v.updatedAt<c.occurredAt||('kind' in c.change?v.kind!==c.change.kind:v.archived!==c.change.archived))throw new Error('The reviewed Inbox action is unconfirmed.');
 return {...v} as unknown as InboxCommandReceipt;
}
