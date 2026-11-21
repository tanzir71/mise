import {validateBackupRow} from './backup-schema';
import {closingSummaryWithOverage} from './closing';
import {parseClosingCommand,type ClosingCommand} from './closing-commands';
import {closingReviewReservedIds} from './closing-review-identities';
import {dayKey,safeTotal} from './today';
import {moneyInputValue} from './money';
import {syncDownloadToken} from './sync-download';
import type {DayClosing,Sale} from './models';

export const closingReviewCommandLimit=32_000;
// Two undo images retain full imported text, including multi-byte Bengali and
// the original member name. These bounds never reduce the ordinary command cap.
export const closingReviewSourceLimit=16_000_000;
export const closingReviewBodyLimit=48_000_000;
export interface ClosingReviewRequest {id:string;replacementId:string;command:ClosingCommand;sourceHash:string;sourceJson:string}
export interface ClosingReviewDecision extends ClosingReviewRequest {token:string;outcome:'withdrawn'|'replaced'}
interface ClosingAuditBase {id:string;outletId:string;closingId:string;actorId:string;command:string;at:number;undoOf:string|null}
export type ClosingSourceAudit=
 |ClosingAuditBase&{kind:'closing';before:DayClosing|null;after:DayClosing}
 |ClosingAuditBase&{kind:'sale';before:Sale|null;after:Sale};
export type ClosingSourceEvents=[Extract<ClosingSourceAudit,{kind:'closing'}>,...Extract<ClosingSourceAudit,{kind:'sale'}>[]];
export interface ClosingReviewSource {v:1;businessId:string;entryId:string;sequence:number;commandIndex:number;at:number;events:ClosingSourceEvents}
export interface ClosingReviewFacts {
 businessId:string;actorId:string;at:number;currency:string;timezone:string;day:string;
 countedCash:number;expectedCash:number;difference:number;addedWalkIn:number;
 closingCreatedAt:number;closingEventId:string;saleCreatedAt:number|null;saleEventId:string|null;
 /** Encoded literals bind a replacement without SQL parsing unrelated text. */
 reviewJson:string|null;inputNoteJson:string|null;noteJson:string|null;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const time=(v:unknown):v is number=>integer(v)&&v<=8640000000000000;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
/** Ignore property order while preserving every literal value and array order. */
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
function closing(value:unknown,c:ClosingCommand):DayClosing{
 validateBackupRow('dayClosings',value,'original closing');const row=value as DayClosing;
 if(row.id!==c.closingId||row.outletId!==c.outletId||row.summary.day!==row.day||row.summary.currency!==row.currency||row.summary.timezone!==row.timezone||dayKey(row.createdAt,row.timezone)!==row.day||
  row.difference!==safeTotal([row.countedCash,-row.expectedCash])||row.addedWalkIn!==0&&row.addedWalkIn!==row.difference||
  (row.addedSaleId!==undefined)!==(row.addedWalkIn>0)||row.activeKey!==(row.voidedAt===undefined?`${row.currency}:${row.day}`:undefined))throw Error('Keep the complete original closing count, day and cash receipt.');
 // An imported undo source can contain the full supported 1m-character fields.
 // Its old snapshot is not a newly entered 16KB ordinary closing review.
 let preview:unknown;try{preview=JSON.parse(row.previewFingerprint);}catch{throw Error('Keep the original closing calculation.');}
 if(JSON.stringify(preview)!==row.previewFingerprint)throw Error('Keep the literal original closing calculation.');
 validateBackupRow('dayClosings',{...row,summary:preview},'original closing review');
 const summary=preview as DayClosing['summary'];
 if(summary.day!==row.day||summary.currency!==row.currency||summary.timezone!==row.timezone||summary.expectedCash!==row.expectedCash||!same(row.summary,row.addedWalkIn?closingSummaryWithOverage(summary,row.addedWalkIn):summary))throw Error('Keep all original financial and operational totals.');
 return structuredClone(row);
}
function sale(value:unknown,c:ClosingCommand,record:DayClosing):Sale{
 validateBackupRow('sales',value,'original closing cash');const row=value as Sale;
 if(row.id!==c.saleId||row.outletId!==c.outletId||row.closingId!==c.closingId||row.currency!==record.currency||row.timezone!==record.timezone||row.amount!==record.addedWalkIn||row.method!=='cash'||row.methodName!=='Cash'||row.who!=='Walk-in'||row.items.length!==0||row.createdBy!==record.createdBy||row.createdAt!==record.createdAt||
  row.given!==row.amount||row.change!==0||['orderId','orderNumber','customerId','creditAccountId','deliveryFee','discount'].some(k=>(row as unknown as Record<string,unknown>)[k]!==undefined)||row.expression!==moneyInputValue(row.amount,row.currency).replace(',','.'))throw Error('Keep only the original linked cash surplus receipt.');
 return structuredClone(row);
}
function audits(value:unknown,c:ClosingCommand):ClosingSourceEvents{
 if(!Array.isArray(value)||value.length!==(c.saleId?2:1))throw Error('Keep every original closing and cash audit.');
 const events=value.map((raw):ClosingSourceAudit=>{
  if(!object(raw)||!exact(raw,'kind,id,outletId,closingId,actorId,command,at,undoOf,before,after')||!id(raw.id)||raw.outletId!==c.outletId||raw.closingId!==c.closingId||!id(raw.actorId)||raw.at!==c.occurredAt||!(raw.undoOf===null||id(raw.undoOf))||typeof raw.command!=='string')throw Error('Keep the original closing member, scope and physical time.');
  const base={id:raw.id,outletId:c.outletId,closingId:c.closingId,actorId:raw.actorId,command:raw.command,at:c.occurredAt,undoOf:raw.undoOf};
  if(raw.kind==='closing')return {...base,kind:'closing',before:raw.before===null?null:closing(raw.before,c),after:closing(raw.after,c)};
  // The companion is validated after its original closing is known below.
  if(raw.kind==='sale')return {...base,kind:'sale',before:raw.before as Sale|null,after:raw.after as Sale};
  throw Error('Keep the original closing audit kind.');
 });
 const primary=events[0],cash=events[1];
 if(primary.kind!=='closing'||primary.id!==c.id||primary.command!==c.type||new Set(events.map(e=>e.id)).size!==events.length||events.some(e=>e.actorId!==primary.actorId)||cash&&(cash.kind!=='sale'||cash.id!==c.saleEventId))throw Error('Keep the exact closing action and companion identities.');
 const before=primary.before,after=primary.after,undo=c.type==='closing.undo';
 if(undo){
  if(!before||before.voidedAt!==undefined||before.eventId===c.id||primary.undoOf!==before.eventId||c.occurredAt<before.createdAt||dayKey(c.occurredAt,before.timezone)!==before.day||
   !same(after,{...before,activeKey:undefined,voidedAt:c.occurredAt,updatedAt:c.occurredAt}))throw Error('Keep the once-only original-day closing undo and immutable snapshot.');
 }else{
  if(before!==null||primary.undoOf!==null||after.voidedAt!==undefined||after.eventId!==c.id||after.createdBy!==primary.actorId||after.createdAt!==c.occurredAt||after.updatedAt!==c.occurredAt||after.previewFingerprint!==c.input.fingerprint||after.day!==c.input.day||after.countedCash!==c.input.countedCash||after.note!==c.input.note.trim()||after.addedWalkIn!==(c.input.addDifference?after.difference:0))throw Error('Keep every original counted value and surplus choice.');
 }
 if((after.addedSaleId??null)!==c.saleId)throw Error('Keep the original closing cash identity.');
 if(cash?.kind==='sale'){
  const original=undo?before!:after,prior=cash.before===null?null:sale(cash.before,c,original),next=sale(cash.after,c,original);
  cash.before=prior;cash.after=next;
  if(undo){
   if(!prior||prior.voidedAt!==undefined||cash.command!=='sale.closing-undo'||cash.undoOf!==prior.eventId||!same(next,{...prior,voidedAt:c.occurredAt,voidReason:'undo',updatedAt:c.occurredAt}))throw Error('Keep the original cash receipt and its exact undo.');
  }else if(prior!==null||next.voidedAt!==undefined||next.voidReason!==undefined||next.eventId!==c.saleEventId||next.updatedAt!==c.occurredAt||cash.command!=='sale.record'||cash.undoOf!==null)throw Error('Keep the original new cash receipt audit.');
 }
 return events as ClosingSourceEvents;
}
/** Derive immediate before/after facts from append-only audits. Grouped final
 * rows may already contain a later undo and cannot replace these snapshots. */
export function closingReviewSourceAudits(original:ClosingCommand,values:readonly unknown[]):ClosingSourceEvents{
 const c=parseClosingCommand(original),wanted=[c.id,...(c.saleEventId?[c.saleEventId]:[])];
 if(values.length!==wanted.length)throw Error('Keep all original closing audits.');
 const projected=values.map(raw=>{
  if(!object(raw)||!object(raw.actor)||!exact(raw.actor,'type,id')||raw.actor.type!=='member'||!id(raw.actor.id)||
   !exact(Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==undefined)),`id,outletId,closingId,actor,command,before,after,at${raw.undoOf!==undefined?',undoOf':''}`))throw Error('Keep only the original append-only closing member audit.');
  return {kind:raw.id===c.id?'closing':'sale',id:raw.id,outletId:raw.outletId,closingId:raw.closingId,actorId:raw.actor.id,command:raw.command,at:raw.at,undoOf:raw.undoOf??null,before:raw.before,after:raw.after};
 });
 if(new Set(projected.map(e=>e.id)).size!==projected.length||projected.some(e=>!wanted.includes(e.id as string)))throw Error('Keep distinct original closing audit identities.');
 return audits(wanted.map(key=>projected.find(e=>e.id===key)),c);
}
export function parseClosingReviewSource(input:Pick<ClosingReviewRequest,'command'|'sourceJson'>):ClosingReviewSource{
 if(typeof input.sourceJson!=='string'||new TextEncoder().encode(input.sourceJson).length>closingReviewSourceLimit)throw Error('Keep the complete bounded closing source.');
 let v:unknown;try{v=JSON.parse(input.sourceJson);}catch{throw Error('Keep the original closing source.');}
 if(JSON.stringify(v)!==input.sourceJson||!object(v)||!exact(v,'v,businessId,entryId,sequence,commandIndex,at,events')||v.v!==1||!id(v.businessId)||!id(v.entryId)||!integer(v.sequence,1)||!integer(v.commandIndex)||!time(v.at))throw Error('Keep the complete original closing source selection.');
 const c=parseClosingCommand(input.command),events=audits(v.events,c);
 if(v.at!==c.occurredAt)throw Error('Keep the count’s original physical time.');
 return {v:1,businessId:v.businessId,entryId:v.entryId,sequence:v.sequence,commandIndex:v.commandIndex,at:v.at,events};
}
/** Safe scalar facts. SQL must keep the entire source as opaque TEXT rather
 * than casting literal NUL/surrogate fields to JSON or JSONB. */
export function closingReviewFacts(input:Pick<ClosingReviewRequest,'command'|'sourceJson'>):ClosingReviewFacts{
 const source=parseClosingReviewSource(input),event=source.events[0],record=event.after,cash=source.events[1];
 const command=parseClosingCommand(input.command);
 return {businessId:source.businessId,actorId:event.actorId,at:source.at,currency:record.currency,timezone:record.timezone,day:record.day,countedCash:record.countedCash,expectedCash:record.expectedCash,difference:record.difference,addedWalkIn:record.addedWalkIn,closingCreatedAt:record.createdAt,closingEventId:record.eventId,saleCreatedAt:cash?.after.createdAt??null,saleEventId:cash?.after.eventId??null,reviewJson:command.type==='closing.record'?command.input.fingerprint:null,inputNoteJson:command.type==='closing.record'?JSON.stringify(command.input.note):null,noteJson:command.type==='closing.record'?JSON.stringify(command.input.note.trim()):null};
}
/** Only actually created rows, not existing closing/sale parents during undo. */
export function closingReviewCreatedIds(source:ClosingReviewSource):ReadonlySet<string>{
 return new Set(source.events.flatMap(event=>[event.id,...(event.before===null?[event.after.id]:[])]));
}
export function parseClosingReviewRequest(value:unknown,decision:false):ClosingReviewRequest;
export function parseClosingReviewRequest(value:unknown,decision:true):ClosingReviewDecision;
export function parseClosingReviewRequest(value:unknown,decision:boolean):ClosingReviewRequest|ClosingReviewDecision{
 if(!object(value)||!exact(value,decision?'id,replacementId,command,sourceHash,sourceJson,token,outcome':'id,replacementId,command,sourceHash,sourceJson')||!id(value.id)||!id(value.replacementId)||value.id===value.replacementId||typeof value.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceHash)||typeof value.sourceJson!=='string')throw Error('Keep the complete original closing action and source.');
 const command=parseClosingCommand(value.command);
 if(new TextEncoder().encode(JSON.stringify(command)).length>closingReviewCommandLimit)throw Error('Keep the original bounded closing command.');
 const input={id:value.id,replacementId:value.replacementId,command,sourceHash:value.sourceHash,sourceJson:value.sourceJson},source=parseClosingReviewSource(input),reserved=new Set(closingReviewReservedIds(command));
 reserved.add(source.entryId);reserved.add(source.businessId);for(const e of source.events){reserved.add(e.actorId);reserved.add(e.after.eventId);reserved.add(e.after.createdBy);if(e.undoOf)reserved.add(e.undoOf);}
 if(reserved.has(input.id)||reserved.has(input.replacementId))throw Error('Keep distinct source, review and replacement identities.');
 if(!decision)return input;
 if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Choose the checked current closing comparison.');
 return {...input,token:value.token,outcome:value.outcome as ClosingReviewDecision['outcome']};
}
