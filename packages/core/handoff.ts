import { ulid } from 'ulid';
import type { AuditEvent } from './models';
import { validateShop,type ShopSetup } from './shop-access';
import { publicRecord,publicText,e164Pattern } from './public-shop';
import { assertHandoffProgress,changeHandoffProgress,newHandoffProgress,type HandoffChoice,type HandoffProgress } from './handoff-progress';

export type HandoffSource = 'credit'|'customer'|'order'|'supplier'|'sale'|'closing'|'shop';
export type HandoffPurpose = 'reminder'|'receipt'|'quote'|'supplier-order'|'win-back'|'summary'|'shop-link'|'call';
export const handoffSourceTables={credit:'creditAccounts',customer:'customers',order:'orders',supplier:'suppliers',sale:'sales',closing:'dayClosings',shop:'outlets'} as const;
export interface HandoffDraft {source:{kind:HandoffSource;id:string};purpose:HandoffPurpose;text:string;template?:string;target:'whatsapp'|'call'|'share'|'copy';phone?:string;part:number;parts:number}
export interface HandoffSession {v:1|2;id:string;outletId:string;eventId:string;generation:number;createdAt:number;draft:HandoffDraft;progress:HandoffProgress;sentEventId?:string}
export type HandoffCompletion = {kind:'credit'}|{kind:'order';revision:number}|{kind:'supplier';supplierName:string;stockItemIds:string[]};
const purposes:Record<HandoffSource,readonly HandoffPurpose[]>={credit:['reminder','receipt','call'],customer:['win-back','call'],order:['quote','call'],supplier:['supplier-order','call'],sale:['receipt'],closing:['summary'],shop:['shop-link','supplier-order']};
const idPattern=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const validId=(value:unknown):value is string=>typeof value==='string'&&idPattern.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=253402300799999;
export const newHandoffActionId=()=>ulid();
export function normaliseHandoffDraft(value:unknown):HandoffDraft {
  const row=publicRecord(value,['source','purpose','text','template','target','phone','part','parts']),source=publicRecord(row.source,['kind','id']);
  if(typeof source.kind!=='string'||!Object.hasOwn(purposes,source.kind)||!validId(source.id)||!purposes[source.kind as HandoffSource].includes(row.purpose as HandoffPurpose))throw new Error('Choose a supported message source and purpose.');
  if(!['whatsapp','call','share','copy'].includes(row.target as string)||(row.phone!==undefined&&(typeof row.phone!=='string'||!e164Pattern.test(row.phone)))||(['whatsapp','call'].includes(row.target as string)&&row.phone===undefined)||(row.target==='call'&&row.purpose!=='call'))throw new Error('Choose a valid message destination.');
  if(!positive(row.part)||!positive(row.parts)||row.parts>100||row.part>row.parts)throw new Error('Choose a valid message part.');
  return {source:{kind:source.kind as HandoffSource,id:source.id},purpose:row.purpose as HandoffPurpose,text:publicText(row.text,12000,true,true),...(row.template===undefined?{}:{template:publicText(row.template,12000,true,true)}),target:row.target as HandoffDraft['target'],...(row.phone===undefined?{}:{phone:row.phone as string}),part:row.part,parts:row.parts};
}
export function handoffTopic(draft:HandoffDraft):string {const d=normaliseHandoffDraft(draft);return `${d.source.kind}:${d.source.id}:${d.purpose}:${d.part}/${d.parts}`;}
export function handoffDraftToken(draft:HandoffDraft):string{return JSON.stringify(normaliseHandoffDraft(draft));}
export function handoffTemplateToken(draft:HandoffDraft):string {const d=normaliseHandoffDraft(draft);return JSON.stringify([d.source,d.purpose,d.target,d.phone??null,d.part,d.parts,d.template??d.text]);}
function progressToken(p:HandoffProgress):string{return JSON.stringify([p.revision,p.status,p.lastAttempt,p.channel,p.updatedAt,p.openedAt??null,p.copiedAt??null,p.failedAt??null,p.sentAt??null,p.sentChannel??null]);}
function session(value:unknown):HandoffSession {
  const row=publicRecord(value,['v','id','outletId','eventId','generation','createdAt','draft','progress','sentEventId']);
  if(![1,2].includes(row.v as number)||!validId(row.id)||!validId(row.outletId)||!validId(row.eventId)||!positive(row.generation)||!time(row.createdAt))throw new Error('This message attempt is unsupported.');
  const draft=normaliseHandoffDraft(row.draft);assertHandoffProgress(row.progress);
  if((row.v===2)!==(draft.template!==undefined))throw new Error('This message attempt has an unsupported template format.');
  if(row.createdAt>row.progress.updatedAt||(row.progress.sentAt!==undefined)!==(row.sentEventId!==undefined)||(row.sentEventId!==undefined&&!validId(row.sentEventId)))throw new Error('This message attempt has an invalid confirmation.');
  return {...row,draft} as unknown as HandoffSession;
}
export function handoffSessionToken(s:HandoffSession):string {const row=session(s);return JSON.stringify([row.v,row.id,row.outletId,row.eventId,row.generation,row.createdAt,handoffDraftToken(row.draft),progressToken(row.progress),row.sentEventId??null]);}
export function prepareHandoffCommand(draft:HandoffDraft,setup:ShopSetup,generation=1,at=Date.now(),newId:()=>string=()=>ulid(at)):{session:HandoffSession;event:AuditEvent} {
  validateShop(setup);if(!positive(generation)||!time(at))throw new Error('Use a valid message attempt and time.');
  const id=newId(),input=normaliseHandoffDraft(draft);if(!validId(id))throw new Error('Keep the original message attempt identity.');
  const state:HandoffSession={v:input.template===undefined?1:2,id,outletId:setup.outlet.id,eventId:id,generation,createdAt:at,draft:input,progress:newHandoffProgress(at)};
  return {session:state,event:{id,outletId:state.outletId,handoffId:id,handoffRevision:1,handoffTopic:handoffTopic(state.draft),actor:{type:'member',id:setup.owner.id},command:'handoff.prepare',before:null,after:state,at}};
}
export function changeHandoffCommand(previous:HandoffSession,choice:HandoffChoice,setup:ShopSetup,expectedRevision:number,id=ulid(),at=Date.now()):{session:HandoffSession;event:AuditEvent} {
  validateShop(setup);const before=session(previous);
  if(before.outletId!==setup.outlet.id||expectedRevision!==before.progress.revision||!validId(id))throw new Error('This message changed. Reopen it before recording another choice.');
  const after:HandoffSession={...before,eventId:id,draft:normaliseHandoffDraft(before.draft),progress:changeHandoffProgress(before.progress,choice,at)};
  if(choice.type==='sent')after.sentEventId=id;else if(choice.type==='undo-sent')delete after.sentEventId;
  return {session:after,event:{id,outletId:after.outletId,handoffId:after.id,handoffRevision:after.progress.revision,handoffTopic:handoffTopic(after.draft),actor:{type:'member',id:setup.owner.id},command:`handoff.${choice.type}`,before,after,at,...(choice.type==='undo-sent'?{undoOf:before.sentEventId}:{})}};
}
/** Validates one snapshot and its transition; the complete history also checks its predecessor. */
export function handoffEventSession(event:AuditEvent):HandoffSession {
  const after=session(event.after),topic=handoffTopic(after.draft);
  if(event.actor.type!=='member'||!validId(event.actor.id)||event.handoffId!==after.id||event.id!==after.eventId||event.outletId!==after.outletId||event.handoffRevision!==after.progress.revision||event.handoffTopic!==topic||event.at!==after.progress.updatedAt)throw new Error('This message event has inconsistent metadata.');
  if(event.command==='handoff.prepare'){
    if(event.before!==null||event.id!==after.id||after.createdAt!==event.at||after.sentEventId!==undefined||progressToken(after.progress)!==progressToken(newHandoffProgress(event.at))||event.undoOf!==undefined)throw new Error('This message preparation is invalid.');
  }else{
    const before=session(event.before),type=event.command.slice('handoff.'.length) as HandoffChoice['type'];
    if(!event.command.startsWith('handoff.')||before.v!==after.v||before.id!==after.id||before.outletId!==after.outletId||before.generation!==after.generation||before.createdAt!==after.createdAt||handoffDraftToken(before.draft)!==handoffDraftToken(after.draft))throw new Error('This message event changed its original request.');
    const expected=changeHandoffProgress(before.progress,{type,...(type==='open'?{channel:after.progress.channel as Exclude<HandoffProgress['channel'],'manual'>}:{})},event.at);
    const sentEventId=type==='sent'?event.id:type==='undo-sent'?undefined:before.sentEventId;
    if(progressToken(expected)!==progressToken(after.progress)||after.sentEventId!==sentEventId||event.undoOf!==(type==='undo-sent'?before.sentEventId:undefined))throw new Error('This message event has an invalid transition.');
  }
  return after;
}
export function validateHandoffHistory(events:AuditEvent[]):void {
  const parsed=new Map<string,{event:AuditEvent;state:HandoffSession}>(),revisions=new Set<string>(),generations=new Map<string,Set<number>>();
  for(const event of events){
    if(!event.command.startsWith('handoff.')&&event.handoffId===undefined&&event.handoffRevision===undefined&&event.handoffTopic===undefined)continue;
    const state=handoffEventSession(event),key=JSON.stringify([state.id,state.progress.revision]);if(revisions.has(key))throw new Error('Duplicate message revision.');revisions.add(key);parsed.set(event.id,{event,state});
    if(event.command==='handoff.prepare'){const key=JSON.stringify([state.outletId,handoffTopic(state.draft)]),seen=generations.get(key)||new Set<number>();if(seen.has(state.generation))throw new Error('Duplicate message generation.');seen.add(state.generation);generations.set(key,seen);}
  }
  for(const seen of generations.values()){let max=0;for(const generation of seen)max=Math.max(max,generation);if(max!==seen.size)throw new Error('This message is missing an earlier attempt.');}
  for(const {event,state} of parsed.values()){
    const root=parsed.get(state.id);if(!root||root.event.command!=='handoff.prepare'||root.state.outletId!==state.outletId)throw new Error('This message is missing its original preparation.');
    if(event.command!=='handoff.prepare'){const before=session(event.before),previous=parsed.get(before.eventId);if(!previous||handoffSessionToken(previous.state)!==handoffSessionToken(before))throw new Error('This message is missing its previous action.');}
  }
}
