import {parseStockCommand,stockWritePlan,stockBatchBodyLimit,type StockCommand} from './stock-commands';
import {stockReviewReservedIds} from './stock-review';
import {stockAtoms,stockNumber,stockUnit,stockNameKey} from './stock-quantity';
import type {StockItem,StockMove} from './models';

export const stockReviewBodyLimit=16_000_000;
export const stockReviewSourceLimit=4_000_000;
export const stockReviewResponseLimit=4_000_000;
export interface StockReviewRequest {id:string;replacementId:string;command:StockCommand;sourceHash:string;sourceJson:string}
export interface StockReviewDecision extends StockReviewRequest {token:string;outcome:'withdrawn'|'replaced'}
export interface StockSourceItem {
 id:string;outletId:string;revision:number;name:string;unit:string;onHand:number;eventId:string;
 createdAt:number;updatedAt:number;lastCountedAt:number|null;archivedAt:number|null;
}
export interface StockSourceMove {
 id:string;outletId:string;stockItemId:string;revision:number;unit:string;before:number;after:number;delta:number;
 reason:'used'|'received'|'count'|'waste'|'undo';source:'manual'|'quick_update'|'count';createdBy:string;eventId:string;
 createdAt:number;updatedAt:number;countBatchId:string|null;undoOf:string|null;
}
export interface StockSourceAudit {
 id:string;outletId:string;actorId:string;command:string;at:number;stockItemId:string;stockRevision:number;undoOf:string|null;
 before:StockSourceItem|null;after:{item:StockSourceItem;move:StockSourceMove|null};
}
export interface StockReviewSource {v:1;entryId:string;sequence:number;commandIndex:number;at:number;events:StockSourceAudit[]}
export interface StockReviewUnitFact {itemId:string;unitKey:string;createdAt:number;undoEventId:string|null;undoDelta:number|null}
/** Scalar SQL assertions use JSON-encoded unit text. Literal NUL and surrogate
 * code units stay in the opaque source rather than being cast to JSONB. */
export function stockReviewUnitFacts(input:StockReviewRequest):StockReviewUnitFact[]{
 return parseStockReviewSource(input).events.map(e=>({itemId:e.stockItemId,unitKey:JSON.stringify(e.after.item.unit),createdAt:e.before?.createdAt??e.after.item.createdAt,undoEventId:e.undoOf,undoDelta:e.after.move?.reason==='undo'?e.after.move.delta:null}));
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const time=(v:unknown):v is number=>integer(v)&&v<=8640000000000000;
const nullableTime=(v:unknown)=>v===null||time(v);
const nullableId=(v:unknown)=>v===null||id(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!!v.trim()&&!/[\r\n]/.test(v);
function quantity(v:unknown,signed=false):v is number{if(typeof v!=='number'||!Number.isFinite(v))return false;try{stockAtoms(v,signed);return true;}catch{return false;}}
function item(value:unknown):StockSourceItem {
 if(!object(value)||!exact(value,'id,outletId,revision,name,unit,onHand,eventId,createdAt,updatedAt,lastCountedAt,archivedAt')||
  !id(value.id)||!id(value.outletId)||!integer(value.revision,1)||value.revision>Number.MAX_SAFE_INTEGER||!text(value.name,120)||!text(value.unit,24)||!quantity(value.onHand)||!id(value.eventId)||
  !time(value.createdAt)||!time(value.updatedAt)||!nullableTime(value.lastCountedAt)||!nullableTime(value.archivedAt))throw Error('Keep the original stock quantity, unit and identity.');
 return {...value} as unknown as StockSourceItem;
}
function move(value:unknown):StockSourceMove {
 if(!object(value)||!exact(value,'id,outletId,stockItemId,revision,unit,before,after,delta,reason,source,createdBy,eventId,createdAt,updatedAt,countBatchId,undoOf')||
  ![value.id,value.outletId,value.stockItemId,value.createdBy,value.eventId].every(id)||!integer(value.revision,1)||!text(value.unit,24)||!quantity(value.before)||!quantity(value.after)||!quantity(value.delta,true)||
  !['used','received','count','waste','undo'].includes(value.reason as string)||!['manual','quick_update','count'].includes(value.source as string)||!time(value.createdAt)||!time(value.updatedAt)||!nullableId(value.countBatchId)||!nullableId(value.undoOf)||
  stockAtoms(value.after)-stockAtoms(value.before)!==stockAtoms(value.delta,true))throw Error('Keep the original complete stock movement facts.');
 return {...value} as unknown as StockSourceMove;
}
export const parseStockReviewItem=(value:unknown):StockSourceItem=>item(value);
export const parseStockReviewMove=(value:unknown):StockSourceMove=>move(value);
export function stockReviewItem(value:StockItem):StockSourceItem{
 return item(Object.fromEntries(['id','outletId','revision','name','unit','onHand','eventId','createdAt','updatedAt','lastCountedAt','archivedAt'].map(k=>[k,(value as unknown as Record<string,unknown>)[k]??null])));
}
export function stockReviewMove(value:StockMove):StockSourceMove{
 return move(Object.fromEntries(['id','outletId','stockItemId','revision','unit','before','after','delta','reason','source','createdBy','eventId','createdAt','updatedAt','countBatchId','undoOf'].map(k=>[k,(value as unknown as Record<string,unknown>)[k]??null])));
}
function audits(value:unknown,c:StockCommand):StockSourceAudit[]{
 const plan=stockWritePlan(c);
 if(!Array.isArray(value)||value.length!==plan.rows.length)throw Error('Keep one original audit for every stock line.');
 return value.map((raw,index)=>{
  const p=plan.rows[index];
  if(!object(raw)||!exact(raw,'id,outletId,actorId,command,at,stockItemId,stockRevision,undoOf,before,after')||raw.id!==p.eventId||raw.outletId!==c.outletId||!id(raw.actorId)||raw.at!==c.occurredAt||raw.stockItemId!==p.itemId||raw.stockRevision!==p.revision+1||!nullableId(raw.undoOf)||!object(raw.after)||!exact(raw.after,'item,move'))throw Error('Keep the exact original stock audit and occurrence time.');
  const before=raw.before===null?null:item(raw.before),after=item(raw.after.item),movement=raw.after.move===null?null:move(raw.after.move),opening=c.type==='stock.create';
  if((before===null)!==opening||before&&(before.id!==p.itemId||before.outletId!==c.outletId||before.revision!==p.revision)||after.id!==p.itemId||after.outletId!==c.outletId||after.revision!==p.revision+1||after.eventId!==p.eventId||after.createdAt!==(before?.createdAt??c.occurredAt)||after.updatedAt!==c.occurredAt||before&&before.unit!==after.unit)throw Error('Keep the immediate original stock before and after this action.');
  const expectedCommand=c.type==='stock.create'?'stock.item-create':c.type==='stock.update'?'stock.item-update':c.type==='stock.archive'||c.type==='stock.restore'||c.type==='stock.undo'?c.type:'stock.'+p.reason;
  const archive=c.type==='stock.archive'?c.occurredAt:c.type==='stock.restore'?null:before?.archivedAt??null;
  if(raw.command!==expectedCommand||after.archivedAt!==archive||c.type!=='stock.undo'&&raw.undoOf!==null||c.type==='stock.undo'&&!id(raw.undoOf)||
    before&&before.archivedAt!==null&&!['stock.archive','stock.restore'].includes(c.type)&&!(c.type==='stock.update'&&c.moveId===null))throw Error('Keep the original stock action and archive state.');
  if('input'in c){if(after.name!==c.input.name.trim()||after.unit!==stockUnit(c.input.unit)||after.onHand!==c.input.onHand)throw Error('Keep the original item input and unit.');}
  else if(before&&after.name!==before.name)throw Error('A stock movement cannot rename its original item.');
  const beforeAtoms=stockAtoms(before?.onHand??0),afterAtoms=stockAtoms(after.onHand),expected=p.reason==='count'?stockAtoms(p.quantity!):p.reason==='received'?beforeAtoms+stockAtoms(p.quantity!):p.reason==='used'||p.reason==='waste'?beforeAtoms-stockAtoms(p.quantity!):p.reason==='undo'?afterAtoms:beforeAtoms;
  if(afterAtoms!==expected||['received','used','waste'].includes(p.reason??'')&&p.quantity===0||
    c.type!=='stock.undo'&&after.lastCountedAt!==(p.reason==='count'?c.occurredAt:before?.lastCountedAt??null))throw Error('Keep the original absolute count, relative quantity and count history.');
  if((movement===null)!==(p.moveId===null))throw Error('Keep the original movement identity.');
  if(movement&&(movement.id!==p.moveId||movement.stockItemId!==p.itemId||movement.outletId!==c.outletId||movement.revision!==after.revision||movement.unit!==after.unit||movement.before!==(before?.onHand??0)||movement.after!==after.onHand||movement.createdBy!==raw.actorId||movement.eventId!==p.eventId||movement.createdAt!==c.occurredAt||movement.updatedAt!==c.occurredAt||movement.reason!==p.reason||movement.source!==(c.type==='stock.undo'?'manual':p.source)||movement.undoOf!==plan.undoMoveId||c.type!=='stock.undo'&&movement.countBatchId!==plan.batchId))throw Error('Keep the same original stock movement and actor.');
  return {id:p.eventId,outletId:c.outletId,actorId:raw.actorId,command:expectedCommand,at:c.occurredAt,stockItemId:p.itemId,stockRevision:after.revision,undoOf:raw.undoOf as string|null,before,after:{item:after,move:movement}};
 });
}
/** The capsule is selective. The durable source hash still covers complete
 * original audits, row changes, commands and image bytes on the device. */
export function stockReviewSourceAudits(original:StockCommand,events:readonly unknown[]):StockSourceAudit[]{
 const c=parseStockCommand(original),plan=stockWritePlan(c),facts=events.map((raw,index)=>{
  if(!object(raw)||!object(raw.actor)||raw.actor.type!=='member'||!id(raw.actor.id))throw Error('Keep the original stock member and audit.');
  const payload=raw.after,fullItem=c.type==='stock.archive'||c.type==='stock.restore'?payload:object(payload)?payload.item:null,fullMove=object(payload)&&'move'in payload?payload.move:null;
  const pickItem=(v:unknown)=>v===null?null:object(v)?Object.fromEntries(['id','outletId','revision','name','unit','onHand','eventId','createdAt','updatedAt','lastCountedAt','archivedAt'].map(k=>[k,v[k]??null])):undefined;
  const pickMove=(v:unknown)=>v===null||v===undefined?null:object(v)?Object.fromEntries(['id','outletId','stockItemId','revision','unit','before','after','delta','reason','source','createdBy','eventId','createdAt','updatedAt','countBatchId','undoOf'].map(k=>[k,v[k]??null])):undefined;
  if(object(fullMove)){
   const note=c.type==='stock.adjust'?c.change.note.trim():c.type==='stock.batch'?c.changes[index]?.note.trim():c.type==='stock.create'?'Opening physical count':c.type==='stock.update'?'On hand edited by owner':null;
   if(!object(fullItem)||fullMove.name!==fullItem.name||note!==null&&fullMove.note!==note||c.type==='stock.undo'&&(typeof fullMove.note!=='string'||!/^Undo (used|received|count|waste)$/.test(fullMove.note)))throw Error('Keep the original movement name and literal note.');
  }
  if('input'in c){
   const v=c.input,expected={nameLocal:v.nameLocal.trim(),category:v.category.trim(),aliases:[...new Set(v.aliases.map(a=>a.trim()).filter(Boolean))],target:v.target,packSize:v.packSize,lowAt:v.lowAt??stockNumber(stockAtoms(v.target)/2n),supplierId:v.supplierId};
   if(!object(fullItem)||Object.entries(expected).some(([k,v])=>JSON.stringify(fullItem[k]??null)!==JSON.stringify(v))||
     (fullItem.activeKey??null)!==(fullItem.archivedAt===undefined?stockNameKey(v.name):null))throw Error('Keep all original stock input fields, including metadata.');
  }
  return {id:raw.id,outletId:raw.outletId,actorId:raw.actor.id,command:raw.command,at:raw.at,stockItemId:raw.stockItemId,stockRevision:raw.stockRevision,undoOf:raw.undoOf??null,before:pickItem(raw.before),after:{item:pickItem(fullItem),move:pickMove(fullMove)}};
 });
 if(events.length!==plan.rows.length)throw Error('Keep the full original stock audit set.');return audits(facts,c);
}
export function parseStockReviewSource(input:Pick<StockReviewRequest,'command'|'sourceJson'>):StockReviewSource{
 let value:unknown;try{value=JSON.parse(input.sourceJson);}catch{throw Error('Keep the original stock source.');}
 // Native capsules are emitted with JSON.stringify. Requiring its exact form
 // excludes duplicate keys and raw lone surrogates before UTF-8 hashing/RPC.
 if(JSON.stringify(value)!==input.sourceJson)throw Error('Keep the exact derived stock source encoding.');
 if(!object(value)||!exact(value,'v,entryId,sequence,commandIndex,at,events')||value.v!==1||!id(value.entryId)||!integer(value.sequence,1)||!integer(value.commandIndex)||!time(value.at))throw Error('Keep the complete original stock source selection.');
 return {v:1,entryId:value.entryId,sequence:value.sequence,commandIndex:value.commandIndex,at:value.at,events:audits(value.events,parseStockCommand(input.command))};
}
export function parseStockReviewRequest(value:unknown,decision:false):StockReviewRequest;
export function parseStockReviewRequest(value:unknown,decision:true):StockReviewDecision;
export function parseStockReviewRequest(value:unknown,decision:boolean):StockReviewRequest|StockReviewDecision{
 if(!object(value)||!exact(value,decision?'id,replacementId,command,sourceHash,sourceJson,token,outcome':'id,replacementId,command,sourceHash,sourceJson')||!id(value.id)||!id(value.replacementId)||value.id===value.replacementId||typeof value.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceHash)||typeof value.sourceJson!=='string'||new TextEncoder().encode(value.sourceJson).length>stockReviewSourceLimit)throw Error('Keep the complete original stock action and source.');
 const command=parseStockCommand(value.command);if(new TextEncoder().encode(JSON.stringify(command)).length>stockBatchBodyLimit)throw Error('Keep the original bounded stock command.');
 const packet:StockReviewRequest={id:value.id,replacementId:value.replacementId,command,sourceHash:value.sourceHash,sourceJson:value.sourceJson},source=parseStockReviewSource(packet),reserved=new Set(stockReviewReservedIds(command));
 reserved.add(source.entryId);for(const e of source.events){reserved.add(e.actorId);if(e.before)reserved.add(e.before.eventId);if(e.undoOf)reserved.add(e.undoOf);}
 if(reserved.has(value.id)||reserved.has(value.replacementId))throw Error('Keep distinct original, review and replacement identities.');
 if(!decision)return packet;if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Choose the current stock comparison.');
 return {...packet,token:value.token,outcome:value.outcome as StockReviewDecision['outcome']};
}
