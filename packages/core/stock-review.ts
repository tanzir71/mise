import {parseStockCommand,parseStockCommandReceipt,stockWritePlan,type StockCommand,type StockCommandReceipt} from './stock-commands';

export interface StockReviewRevision {stockItemId:string;revision:number}
export interface StockResolutionReceipt {
  id:string;type:'command.resolved';commandId:string;commandType:StockCommand['type'];outletId:string;occurredAt:number;
  commandHash:string;sourceHash:string;at:number;outcome:'withdrawn'|'replaced';
  replacement:{id:string;commandHash:string;revisions:StockReviewRevision[];receipt:StockCommandReceipt}|null;
}
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const time=(value:unknown):value is number=>integer(value)&&value<=8640000000000000;
const exact=(value:Record<string,unknown>,keys:string)=>Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');

/** Newly allocated identities; existing item/outlet/undo parents stay usable. */
export function stockReviewCreatedIds(original:StockCommand):ReadonlySet<string>{
 const c=parseStockCommand(original),plan=stockWritePlan(c);
 return new Set([c.id,...plan.rows.flatMap(row=>[row.eventId,...(row.moveId?[row.moveId]:[])]),...(plan.batchId?[plan.batchId]:[]),...(c.type==='stock.create'?[c.stockItemId]:[])]);
}

/** Every original stock, movement, batch and audit identity stays reserved. */
export function stockReviewReservedIds(original:StockCommand):ReadonlySet<string>{
  const c=parseStockCommand(original),plan=stockWritePlan(c);
  return new Set([c.id,c.outletId,...plan.rows.flatMap(row=>[row.itemId,row.eventId,...(row.moveId?[row.moveId]:[])]),
    ...(plan.batchId?[plan.batchId]:[]),...(plan.undoMoveId?[plan.undoMoveId]:[]),...(plan.supplierId?[plan.supplierId]:[])]);
}
export function parseStockReviewRevisions(value:unknown,original:StockCommand):StockReviewRevision[]{
  const c=parseStockCommand(original),rows=stockWritePlan(c).rows;
  if(!Array.isArray(value)||value.length!==rows.length)throw Error('Review every original stock line together.');
  return value.map((item,index)=>{
    const planned=rows[index];
    if(!object(item)||!exact(item,'stockItemId,revision')||item.stockItemId!==planned.itemId||!integer(item.revision)||item.revision>=Number.MAX_SAFE_INTEGER||
      (c.type==='stock.create'?item.revision!==0:item.revision<1))throw Error('Keep the original stock identities and checked current revisions.');
    return {stockItemId:item.stockItemId as string,revision:item.revision};
  });
}
/** Constructs an intent only. Admission still needs the source-bound current
 * comparison and an explicit choice. Earlier withdrawals may leave its actual
 * predecessor below the device's original revision. Quantities/units/time stay. */
export function reviewedStockProposal(original:StockCommand,replacementId:string,revisions:readonly StockReviewRevision[]):StockCommand{
  const c=parseStockCommand(original),selected=parseStockReviewRevisions(revisions,c);
  if(!id(replacementId)||stockReviewReservedIds(c).has(replacementId))throw Error('Keep distinct original and reviewed stock identities.');
  if(c.type==='stock.create')return parseStockCommand({...c,id:replacementId});
  if(c.type==='stock.batch')return parseStockCommand({...c,id:replacementId,changes:c.changes.map((line,index)=>({...line,revision:selected[index].revision,eventId:index===0?replacementId:line.eventId}))});
  if(c.type==='stock.adjust')return parseStockCommand({...c,id:replacementId,change:{...c.change,revision:selected[0].revision}});
  return parseStockCommand({...c,id:replacementId,revision:selected[0].revision});
}
export function parseStockResolutionReceipt(value:unknown,original:StockCommand):StockResolutionReceipt{
  const c=parseStockCommand(original),reserved=stockReviewReservedIds(c);
  if(!object(value)||!exact(value,'id,type,commandId,commandType,outletId,occurredAt,commandHash,sourceHash,at,outcome,replacement')||
    !id(value.id)||reserved.has(value.id)||value.type!=='command.resolved'||value.commandId!==c.id||value.commandType!==c.type||value.outletId!==c.outletId||value.occurredAt!==c.occurredAt||
    !hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the genuine original stock resolution.');
  let replacement:StockResolutionReceipt['replacement']=null;
  if(value.outcome==='withdrawn'){
    if(value.replacement!==null)throw Error('A withdrawal has no substitute stock movement.');
  }else{
    const r=value.replacement;
    if(!object(r)||!exact(r,'id,commandHash,revisions,receipt')||!id(r.id)||r.id===value.id||!hash(r.commandHash))throw Error('Keep the reviewed stock action and actual receipt.');
    const revisions=parseStockReviewRevisions(r.revisions,c),proposal=reviewedStockProposal(c,r.id,revisions),receipt=parseStockCommandReceipt(r.receipt,proposal);
    // Ordinary additive receipts allow later revisions; a deliberate comparison
    // must prove the exact predecessor the operator selected, for every line.
    if(receipt.at>value.at||receipt.results.some((row,index)=>row.revision!==revisions[index].revision+1||row.updatedAt<receipt.at))throw Error('Keep the exact checked stock revisions and server clocks.');
    replacement={id:proposal.id,commandHash:r.commandHash,revisions,receipt};
  }
  return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,
    commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as StockResolutionReceipt['outcome'],replacement};
}
