import {handoffTopic,normaliseHandoffDraft,type HandoffCompletion,type HandoffDraft} from './handoff';
import type {HandoffChoice,HandoffProgress} from './handoff-progress';
import {supplierMessageName} from './supplier-drafts';
export const handoffBodyHeader='X-Mise-Handoff-Write',handoffBodyLimit=256000;
export interface HandoffRelatedIds {recordId:string;eventId:string}
export type HandoffCommand=
 |{id:string;type:'handoff.prepare';outletId:string;occurredAt:number;draft:HandoffDraft}
 |{id:string;type:'handoff.change';outletId:string;occurredAt:number;handoffId:string;revision:number;choice:HandoffChoice;completion:HandoffCompletion|null;related:HandoffRelatedIds|null}
 |{id:string;type:'supplier-message.undo';outletId:string;occurredAt:number;messageId:string};
export interface HandoffCommandReceipt {id:string;type:HandoffCommand['type'];outletId:string;occurredAt:number;at:number;actionAt:number;handoffId:string|null;generation:number|null;revision:number|null;status:HandoffProgress['status']|null;sentAt:number|null;sentEventId:string|null;companionId:string|null;companionEventId:string|null;orderRevision:number|null;entrySequence:number|null;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
function completion(v:unknown):HandoffCompletion|null {
 if(v===null)return null;if(!object(v))throw new Error('Keep the reviewed message completion.');
 if(v.kind==='credit'&&exact(v,'kind'))return {kind:v.kind};
 if(v.kind==='order'&&exact(v,'kind,revision')&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))return {kind:v.kind,revision:v.revision};
 if(v.kind==='supplier'&&exact(v,'kind,supplierName,stockItemIds')&&typeof v.supplierName==='string'&&supplierMessageName(v.supplierName).length>0&&supplierMessageName(v.supplierName).length<=120&&Array.isArray(v.stockItemIds)&&v.stockItemIds.length>0&&v.stockItemIds.length<=1000&&v.stockItemIds.every(id))return {kind:v.kind,supplierName:supplierMessageName(v.supplierName),stockItemIds:[...new Set(v.stockItemIds)]};
 throw new Error('Review the exact credit, order or supplier completion.');
}
function choice(v:unknown):HandoffChoice {
 if(!object(v)||!['open','copy','copy-failed','failed','sent','undo-sent'].includes(v.type as string)||(v.type==='open'?!exact(v,'type,channel')||!['whatsapp','call','share'].includes(v.channel as string):!exact(v,'type')))throw new Error('Choose a supported manual message action.');
 return v.type==='open'?{type:v.type,channel:v.channel as 'whatsapp'|'call'|'share'}:{type:v.type as HandoffChoice['type']};
}
export function isHandoffCommandType(v:unknown):v is HandoffCommand['type'] {return v==='handoff.prepare'||v==='handoff.change'||v==='supplier-message.undo';}
export function parseHandoffCommand(v:unknown):HandoffCommand {
 if(!object(v)||!id(v.id)||!id(v.outletId)||!integer(v.occurredAt,0,253402300799999))throw new Error('Keep the message command, outlet and occurrence time.');
 const b={id:v.id,outletId:v.outletId,occurredAt:v.occurredAt};
 if(v.type==='handoff.prepare'&&exact(v,'id,type,outletId,occurredAt,draft')){const draft=normaliseHandoffDraft(v.draft);if(draft.source.id===b.id)throw new Error('Use a new message attempt identity.');return {...b,type:v.type,draft};}
 if(v.type==='supplier-message.undo'&&exact(v,'id,type,outletId,occurredAt,messageId')&&id(v.messageId)&&v.messageId!==b.id)return {...b,type:v.type,messageId:v.messageId};
 if(v.type!=='handoff.change'||!exact(v,'id,type,outletId,occurredAt,handoffId,revision,choice,completion,related')||!id(v.handoffId)||v.handoffId===v.id||!integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))throw new Error('Keep the message attempt and reviewed revision.');
 const action=choice(v.choice),done=completion(v.completion);let related:HandoffRelatedIds|null=null;
 if(v.related!==null){if(!object(v.related)||!exact(v.related,'recordId,eventId')||!id(v.related.recordId)||!id(v.related.eventId))throw new Error('Keep the companion record and audit identities.');related={recordId:v.related.recordId,eventId:v.related.eventId};}
 if(action.type!=='sent'&&(done!==null||related!==null)||(done===null)!==(related===null))throw new Error('Only explicit Sent completes a business message.');
 if(related&&(new Set([b.id,v.handoffId,related.eventId]).size!==3||related.recordId===b.id||related.recordId===related.eventId||(done?.kind==='supplier'?related.recordId!==v.handoffId:related.recordId===v.handoffId)))throw new Error('Keep distinct planned message and companion identities.');
 return {...b,type:v.type,handoffId:v.handoffId,revision:v.revision,choice:action,completion:done,related};
}
export function handoffWritePlan(command:HandoffCommand){
 const c=parseHandoffCommand(command),d=c.type==='handoff.prepare'?c.draft:null;
 return {handoffId:c.type==='handoff.prepare'?c.id:c.type==='handoff.change'?c.handoffId:null,messageId:c.type==='supplier-message.undo'?c.messageId:null,revision:c.type==='handoff.change'?c.revision:null,choice:c.type==='handoff.change'?c.choice.type:null,channel:c.type==='handoff.change'?c.choice.channel??null:null,sourceKind:d?.source.kind??null,sourceId:d?.source.id??null,topic:d?handoffTopic(d):null,draftJson:d?JSON.stringify(d):null,completion:c.type==='handoff.change'&&c.completion?.kind==='supplier'?{kind:'supplier',supplierNameJson:JSON.stringify(c.completion.supplierName),stockItemIds:c.completion.stockItemIds}:c.type==='handoff.change'?c.completion:null,related:c.type==='handoff.change'?c.related:null,intentJson:JSON.stringify(c)};
}
export function parseHandoffCommandReceipt(v:unknown,c:HandoffCommand):HandoffCommandReceipt {
 if(!object(v)||!exact(v,'id,type,outletId,occurredAt,at,actionAt,handoffId,generation,revision,status,sentAt,sentEventId,companionId,companionEventId,orderRevision,entrySequence,undoOf')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!integer(v.at,0,253402300799999)||!integer(v.actionAt,c.occurredAt,253402300799999)||!['handoffId','sentEventId','companionId','companionEventId','undoOf'].every(k=>v[k]===null||id(v[k]))||!['generation','revision','orderRevision','entrySequence'].every(k=>v[k]===null||integer(v[k],1))||!(v.sentAt===null||integer(v.sentAt,0,v.actionAt))||!([null,'ready','opened','copied','failed','sent'] as unknown[]).includes(v.status))throw new Error('Invalid message receipt.');
 if(c.type==='supplier-message.undo'){if(['handoffId','generation','revision','status','sentAt','sentEventId','orderRevision','entrySequence'].some(k=>v[k]!==null)||v.companionId!==c.messageId||v.companionEventId!==c.id||v.undoOf!==c.messageId)throw new Error('Invalid supplier correction receipt.');}
 else{
  if(v.handoffId!==(c.type==='handoff.prepare'?c.id:c.handoffId)||!integer(v.generation,1)||v.revision!==(c.type==='handoff.prepare'?1:c.revision+1)||(v.status==='sent')!==(v.sentAt!==null)||(v.sentAt===null)!==(v.sentEventId===null))throw new Error('The message receipt does not match this attempt.');
  if(c.type==='handoff.prepare'){if(v.status!=='ready'||['sentAt','sentEventId','companionId','companionEventId','orderRevision','entrySequence','undoOf'].some(k=>v[k]!==null))throw new Error('A prepared message is not sent.');}
  else if(c.choice.type==='sent'){
   if(v.status!=='sent'||v.sentAt!==v.actionAt||v.sentEventId!==c.id||v.undoOf!==null||v.companionId!==(c.related?.recordId??null)||v.companionEventId!==(c.related?.eventId??null)&&!(c.completion?.kind==='supplier'&&v.companionEventId===null)||(c.completion?.kind==='order'?!integer(v.orderRevision,c.completion.revision+1):v.orderRevision!==null)||(c.completion?.kind==='credit'?!integer(v.entrySequence,1):v.entrySequence!==null))throw new Error('The complete Sent transaction is unconfirmed.');
  }else if(['companionId','companionEventId','orderRevision','entrySequence'].some(k=>v[k]!==null)||v.sentEventId===c.id||v.undoOf!==(c.choice.type==='undo-sent'?c.handoffId:null)||c.choice.type==='undo-sent'&&(v.sentAt!==null||v.sentEventId!==null))throw new Error('This choice cannot complete another business record.');
 }
 return {id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:v.at,actionAt:v.actionAt,handoffId:v.handoffId as string|null,generation:v.generation as number|null,revision:v.revision as number|null,status:v.status as HandoffProgress['status']|null,sentAt:v.sentAt as number|null,sentEventId:v.sentEventId as string|null,companionId:v.companionId as string|null,companionEventId:v.companionEventId as string|null,orderRevision:v.orderRevision as number|null,entrySequence:v.entrySequence as number|null,undoOf:v.undoOf as string|null};
}
