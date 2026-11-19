import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {parseStockCommand,stockWritePlan,type StockCommand} from './stock-commands';
import {activeStockMoves,adjustStockCommand,archiveStockItemCommand,saveStockItemCommand,stockBatchCommand,undoStockMoveCommand,type StockChange,type StockIds,type StockWriteContext} from './stock';
import type {Business,Outlet,StockItem,StockMove,Supplier} from './models';
export class StockMutationInvalid extends Error {}
export class StockMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function stockFingerprint(c:StockCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseStockCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
export function replayStockRecords(value:unknown,c:StockCommand):CloudRecord[]{
 if(!object(value)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid stock context.');
 const raw:unknown=JSON.parse(value.contextJson);if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!Array.isArray(raw.items)||!raw.items.every(object)||!Array.isArray(raw.moves)||!raw.moves.every(object)||!Array.isArray(raw.suppliers)||!raw.suppliers.every(object))throw new Error('Invalid stock records.');
 const plan=stockWritePlan(c),business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 const items=raw.items.map(r=>decodeCommandRecord('stockItems',r) as unknown as StockItem),moves=raw.moves.map(r=>decodeCommandRecord('stockMoves',r) as unknown as StockMove),suppliers=raw.suppliers.map(r=>decodeCommandRecord('suppliers',r) as unknown as Supplier);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||[...items,...moves,...suppliers].some(r=>r.outletId!==outlet.id)||moves.some(m=>!plan.rows.some(p=>p.itemId===m.stockItemId)))throw new Error('Invalid stock scope.');
 const context:StockWriteContext={setup:{business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}},items,moves,suppliers};
 const newId:StockIds=(kind,itemId)=>{if(kind==='item'&&c.type==='stock.create')return c.stockItemId;if(kind==='batch'&&plan.batchId)return plan.batchId;const p=plan.rows.find(r=>r.itemId===itemId);if(p&&kind==='event')return p.eventId;if(p&&kind==='move'&&p.moveId)return p.moveId;throw new Error('Missing planned stock ID.');};
 const reviewed=(itemId:string,revision:number,additive=false)=>{const before=items.find(i=>i.id===itemId);if(!before)throw new StockMutationConflict('The stock item is unavailable. Keep the retained intent.');if(before.revision<revision||!additive&&before.revision!==revision||additive&&activeStockMoves(moves).some(m=>m.stockItemId===itemId&&m.reason==='count'&&m.revision>revision))throw new StockMutationConflict('Review the latest stock and physical count before retrying.');return before;};
 let change:StockChange;
 try{
  if(c.occurredAt>value.at+300000)throw new Error('Check the device clock.');
  if(c.type==='stock.create'||c.type==='stock.update'){
   const before=c.type==='stock.update'?reviewed(c.stockItemId,c.revision):null;
   change=saveStockItemCommand({...c.input,lowAt:c.input.lowAt??undefined,supplierId:c.input.supplierId??undefined},context,before,before?.revision??0,c.occurredAt,newId);
  }else if(c.type==='stock.archive'||c.type==='stock.restore')change=archiveStockItemCommand(reviewed(c.stockItemId,c.revision),c.type==='stock.archive',c.revision,context,c.occurredAt,newId);
  else if(c.type==='stock.adjust'){
   const before=reviewed(c.change.id,c.change.revision,c.change.reason!=='count');change=adjustStockCommand({...c.change,revision:before.revision},context,c.occurredAt,undefined,newId);
  }else if(c.type==='stock.batch'){
   const inputs=c.changes.map(d=>({...d,revision:reviewed(d.id,d.revision,d.reason!=='count').revision}));change=stockBatchCommand(inputs,context,c.occurredAt,c.count,newId);
  }else if(c.type==='stock.undo'){
   const before=reviewed(c.stockItemId,c.revision,true),original=moves.find(m=>m.id===c.undoMoveId);if(!original||original.stockItemId!==before.id||c.occurredAt<original.createdAt)throw new Error('Choose the original movement.');
   change=undoStockMoveCommand(original,before.revision,context,value.at,newId);
  }else throw new Error('Unsupported stock action');
 }catch(error){if(error instanceof StockMutationConflict)throw error;throw new StockMutationInvalid('Check the stock details, quantity, supplier, original movement or device time.');}
 if(change.items.length!==plan.rows.length||change.events.length!==plan.rows.length)throw new Error('Invalid stock mutation shape.');
 for(const item of change.items){item.updatedAt=Math.max(value.at,item.createdAt,c.occurredAt);if(c.type==='stock.archive')item.archivedAt=c.occurredAt;}
 for(const move of change.moves){move.createdAt=c.occurredAt;move.updatedAt=Math.max(value.at,c.occurredAt);}
 for(const e of change.events)e.at=value.at;
 for(const p of plan.rows){const item=change.items.find(i=>i.id===p.itemId),move=change.moves.find(m=>m.stockItemId===p.itemId),e=change.events.find(e=>e.stockItemId===p.itemId);if(!item||e?.id!==p.eventId||item.eventId!==p.eventId||(move?.id??null)!==p.moveId)throw new StockMutationInvalid('Keep the reviewed stock and movement IDs.');}
 const records:CloudRecord[]=[...change.items.map(i=>encodeCommandRecord('stockItems',i,business.id)),...change.moves.map(m=>encodeCommandRecord('stockMoves',m,business.id)),...change.events.map(e=>encodeCommandRecord('events',e,business.id))];
 return records;
}
