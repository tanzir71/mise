import {stockAtoms,stockNameKey} from './stock-quantity';
import type {StockAdjustment} from './stock';
export const stockBatchHeader='X-Mise-Stock-Batch';
export const stockBatchBodyLimit=8_000_000;
export interface StockSaveInput {name:string;nameLocal:string;unit:string;category:string;aliases:string[];onHand:number;target:number;packSize:number;lowAt:number|null;supplierId:string|null}
export interface StockDelta extends StockAdjustment {source:'manual'|'quick_update'|'count';note:string}
type Base={id:string;outletId:string;occurredAt:number};
export type StockCommand=Base&(
 |{type:'stock.create';stockItemId:string;input:StockSaveInput;moveId:string}
 |{type:'stock.update';stockItemId:string;revision:number;input:StockSaveInput;moveId:string|null}
 |{type:'stock.archive'|'stock.restore';stockItemId:string;revision:number}
 |{type:'stock.adjust';change:StockDelta;moveId:string}
 |{type:'stock.undo';stockItemId:string;revision:number;undoMoveId:string;moveId:string}
 |{type:'stock.batch';count:boolean;batchId:string|null;changes:(StockDelta&{eventId:string;moveId:string})[]});
export interface StockResult {stockItemId:string;eventId:string;moveId:string|null;revision:number;onHand:number;updatedAt:number}
export interface StockCommandReceipt {id:string;type:StockCommand['type'];outletId:string;occurredAt:number;at:number;batchId:string|null;undoOf:string|null;results:StockResult[]}
export function isStockMetadataIntent(c:StockCommand):boolean{return c.type==='stock.update'&&c.moveId===null||c.type==='stock.archive'||c.type==='stock.restore';}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
const text=(v:unknown,max:number,line=true):v is string=>typeof v==='string'&&v.trim().length<=max&&(!line||!/[\r\n]/.test(v));
function quantity(v:unknown):v is number{if(typeof v!=='number'||!Number.isFinite(v))return false;try{stockAtoms(v);return true;}catch{return false;}}
function input(v:unknown):StockSaveInput{
 if(!object(v)||!exact(v,'aliases,category,lowAt,name,nameLocal,onHand,packSize,supplierId,target,unit')||!text(v.name,120)||!v.name.trim()||!text(v.nameLocal,120)||!text(v.unit,80)||!v.unit.trim()||!text(v.category,80)||!Array.isArray(v.aliases)||!v.aliases.every(a=>text(a,120))||!quantity(v.onHand)||!quantity(v.target)||!quantity(v.packSize)||(v.lowAt!==null&&!quantity(v.lowAt))||(v.supplierId!==null&&!id(v.supplierId)))throw new Error('Check the stock item details.');
 const aliases=[...new Set((v.aliases as string[]).map(a=>a.trim()).filter(Boolean))];if(aliases.length>10)throw new Error('Use at most ten distinct aliases.');
 return {name:v.name,nameLocal:v.nameLocal,unit:v.unit,category:v.category,aliases,onHand:v.onHand,target:v.target,packSize:v.packSize,lowAt:v.lowAt as number|null,supplierId:v.supplierId as string|null};
}
function delta(v:unknown,batch=false):StockDelta{
 if(!object(v)||!exact(v,batch?'eventId,id,moveId,note,quantity,reason,revision,source':'id,note,quantity,reason,revision,source')||!id(v.id)||!integer(v.revision,1,Number.MAX_SAFE_INTEGER-1)||!['used','received','count','waste'].includes(v.reason as string)||!['manual','quick_update','count'].includes(v.source as string)||!text(v.note,1000,false)||!quantity(v.quantity))throw new Error('Check the reviewed stock movement.');
 return {id:v.id,revision:v.revision,reason:v.reason as StockDelta['reason'],source:v.source as StockDelta['source'],quantity:v.quantity,note:v.note};
}
export function isStockCommandType(v:unknown):v is StockCommand['type']{return typeof v==='string'&&['stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch'].includes(v);}
export function parseStockCommand(v:unknown):StockCommand{
 if(!object(v)||!id(v.id)||!id(v.outletId)||!integer(v.occurredAt,0,8640000000000000))throw new Error('Check the stock command identity.');
 const base={id:v.id,outletId:v.outletId,occurredAt:v.occurredAt};let c:StockCommand;
 if(v.type==='stock.create'&&exact(v,'id,input,moveId,occurredAt,outletId,stockItemId,type')&&id(v.stockItemId)&&id(v.moveId))c={...base,type:v.type,stockItemId:v.stockItemId,moveId:v.moveId,input:input(v.input)};
 else if(v.type==='stock.update'&&exact(v,'id,input,moveId,occurredAt,outletId,revision,stockItemId,type')&&id(v.stockItemId)&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1)&&(v.moveId===null||id(v.moveId)))c={...base,type:v.type,stockItemId:v.stockItemId,revision:v.revision,moveId:v.moveId,input:input(v.input)};
 else if((v.type==='stock.archive'||v.type==='stock.restore')&&exact(v,'id,occurredAt,outletId,revision,stockItemId,type')&&id(v.stockItemId)&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))c={...base,type:v.type,stockItemId:v.stockItemId,revision:v.revision};
 else if(v.type==='stock.adjust'&&exact(v,'change,id,moveId,occurredAt,outletId,type')&&id(v.moveId))c={...base,type:v.type,change:delta(v.change),moveId:v.moveId};
 else if(v.type==='stock.undo'&&exact(v,'id,moveId,occurredAt,outletId,revision,stockItemId,type,undoMoveId')&&id(v.stockItemId)&&id(v.moveId)&&id(v.undoMoveId)&&integer(v.revision,1,Number.MAX_SAFE_INTEGER-1))c={...base,type:v.type,stockItemId:v.stockItemId,revision:v.revision,moveId:v.moveId,undoMoveId:v.undoMoveId};
 else if(v.type==='stock.batch'&&exact(v,'batchId,changes,count,id,occurredAt,outletId,type')&&typeof v.count==='boolean'&&(v.batchId===null||id(v.batchId))&&((v.batchId!==null)===v.count)&&Array.isArray(v.changes)&&v.changes.length>=1&&v.changes.length<=1000){
  const changes=v.changes.map(x=>{const d=delta(x,true);if(!id(x.eventId)||!id(x.moveId)||v.count&&d.reason!=='count')throw new Error('Check the batch IDs and count lines.');return {...d,eventId:x.eventId,moveId:x.moveId};});
  if(changes[0].eventId!==v.id||new Set(changes.map(x=>x.id)).size!==changes.length)throw new Error('Each batch item needs one reviewed change.');c={...base,type:v.type,count:v.count,batchId:v.batchId as string|null,changes};
 }else throw new Error('Choose a supported stock action and its exact fields.');
 const plan=stockWritePlan(c),created=[...plan.rows.map(r=>r.eventId),...plan.rows.flatMap(r=>r.moveId?[r.moveId]:[]),...(c.type==='stock.batch'&&c.batchId?[c.batchId]:[])];
 if(new Set(created).size!==created.length||created.some(value=>plan.rows.some(r=>r.itemId===value))||c.type==='stock.undo'&&created.includes(c.undoMoveId))throw new Error('Use distinct stock, movement and audit IDs.');return c;
}
export function stockWritePlan(c:StockCommand){
 const rows=c.type==='stock.batch'?c.changes.map(x=>({itemId:x.id,revision:x.revision,eventId:x.eventId,moveId:x.moveId,reason:x.reason,quantity:x.quantity,source:c.count?'count':x.source})):c.type==='stock.adjust'?[{itemId:c.change.id,revision:c.change.revision,eventId:c.id,moveId:c.moveId,reason:c.change.reason,quantity:c.change.quantity,source:c.change.source}]:[{itemId:c.stockItemId,revision:c.type==='stock.create'?0:c.revision,eventId:c.id,moveId:'moveId'in c?c.moveId:null,reason:c.type==='stock.undo'?'undo':'moveId'in c&&c.moveId?'count':null,quantity:'input'in c&&c.moveId?c.input.onHand:null,source:'moveId'in c&&c.moveId?'manual':null}];
 return {rows,batchId:c.type==='stock.batch'?c.batchId:null,undoMoveId:c.type==='stock.undo'?c.undoMoveId:null,supplierId:'input'in c?c.input.supplierId:null,nameKey:'input'in c?JSON.stringify(stockNameKey(c.input.name)):null};
}
export function parseStockCommandReceipt(v:unknown,c:StockCommand):StockCommandReceipt{
 const plan=stockWritePlan(c);if(!object(v)||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||v.batchId!==plan.batchId||v.undoOf!==plan.undoMoveId||!integer(v.at,0,8640000000000000)||!Array.isArray(v.results)||v.results.length!==plan.rows.length)throw new Error('Invalid stock receipt.');
 const results:StockResult[]=v.results.map((r,i)=>{const p=plan.rows[i],rebased=isStockMetadataIntent(c)||c.type==='stock.undo'||c.type==='stock.adjust'&&c.change.reason!=='count'||c.type==='stock.batch'&&c.changes[i].reason!=='count';if(!object(r)||r.stockItemId!==p.itemId||r.eventId!==p.eventId||r.moveId!==p.moveId||!integer(r.revision,p.revision+1)||!rebased&&r.revision!==p.revision+1||!quantity(r.onHand)||!integer(r.updatedAt,0,8640000000000000))throw new Error('Stock receipt does not match the reviewed IDs and revision.');return {stockItemId:p.itemId,eventId:p.eventId,moveId:p.moveId,revision:r.revision,onHand:r.onHand,updatedAt:r.updatedAt};});
 return {id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:v.at,batchId:plan.batchId,undoOf:plan.undoMoveId,results};
}
