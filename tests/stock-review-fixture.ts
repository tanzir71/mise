import {adjustStockCommand,activeStockMoves,type StockChange,type StockContext} from '../packages/core/stock';
import {stockAdjustmentIntent} from '../apps/web/src/data/outbox-intents';
import {stockWritePlan,type StockCommand} from '../packages/core/stock-commands';
import {reviewedStockProposal} from '../packages/core/stock-review';
import {parseStockReviewRequest,stockReviewItem,stockReviewMove,stockReviewSourceAudits,type StockReviewRequest} from '../packages/core/stock-review-source';
import {stockReviewInput,stockReviewProjection,type PreparedStockReview} from '../packages/core/stock-review-view';
import {replayStockRecords} from '../packages/core/stock-replay';
import {cloudRecordMap,decodeProposedCommandRecord,encodeCommandRecord} from '../packages/core/cloud-records';
import {stockFixture,STOCK_AT} from './stock-fixture';
import type {BackupTable} from '../packages/core/backup-tables';
import type {StockItem} from '../packages/core/models';
export const id=(n:number)=>String(n).padStart(26,'0'),literal='Original · বাংলা\0\ud800';
export function packet(command:StockCommand,change:StockChange):StockReviewRequest {
 return parseStockReviewRequest({id:id(90000),replacementId:id(90001),command,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,entryId:id(90002),sequence:1,commandIndex:0,at:command.occurredAt,events:stockReviewSourceAudits(command,change.events)})},false);
}
export function apply(f:StockContext,change:StockChange){for(const item of change.items){const index=f.items.findIndex(x=>x.id===item.id);if(index<0)f.items.push(item);else f.items[index]=item;}f.moves.push(...change.moves);}
export function context(f:StockContext,c:StockCommand,at:number){
 const businessId=f.setup.business.id,raw=(table:BackupTable,row:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,row,businessId).values).map(([key,value])=>[key,value!==null&&(cloudRecordMap(table).fields as Record<string,string>)[key]?.startsWith('j:')?JSON.parse(value as string):value]));
 return {businessId,outletId:c.outletId,actorId:f.setup.owner.id,at,contextJson:JSON.stringify({business:raw('businesses',f.setup.business),outlet:raw('outlets',f.setup.outlet),items:f.items.map(x=>raw('stockItems',x)),moves:f.moves.filter(x=>stockWritePlan(c).rows.some(row=>row.itemId===x.stockItemId)).map(x=>raw('stockMoves',x)),suppliers:f.suppliers.filter(row=>row.id===stockWritePlan(c).supplierId).map(row=>raw('suppliers',row))})};
}
export function view(f:StockContext,p:StockReviewRequest,at=STOCK_AT+10000,enabled=true):PreparedStockReview {
 const c=p.command,plan=stockWritePlan(c),items=plan.rows.map(row=>({stockItemId:row.itemId,item:f.items.some(x=>x.id===row.itemId)?stockReviewItem(f.items.find(x=>x.id===row.itemId)!):null})),selected=items.map(row=>({stockItemId:row.stockItemId,revision:row.item?.revision??0}));
 let undo:PreparedStockReview['current']['undo']=null;
 if(c.type==='stock.undo'){
  const move=f.moves.find(m=>m.id===c.undoMoveId);if(move){const active=activeStockMoves(f.moves);undo={move:stockReviewMove(move),reversed:f.moves.some(m=>m.undoOf===move.id),laterCount:active.some(m=>m.stockItemId===move.stockItemId&&m.reason==='count'&&m.revision>move.revision),restoredCountAt:active.filter(m=>m.id!==move.id&&m.stockItemId===move.stockItemId&&m.reason==='count').sort((a,b)=>b.revision-a.revision)[0]?.createdAt??null};}
 }
 const first=f.items.find(x=>x.id===plan.rows[0].itemId),supplier=(id:string|null|undefined)=>{const row=f.suppliers.find(row=>row.id===id);return row?{id:row.id,name:row.name,archived:row.archivedAt!==undefined}:null;},current={stateHash:'c'.repeat(64),timezone:f.setup.outlet.timezone,items,input:'input'in c&&first?stockReviewInput(first):null,suppliers:{saved:'input'in c?supplier(c.input.supplierId):null,current:'input'in c?supplier(first?.supplierId):null},undo};
 let proposal:PreparedStockReview['proposal']={enabled:false,reason:'unavailable'};
 if(enabled){const replacement=reviewedStockProposal(c,p.replacementId,selected),records=replayStockRecords(context(f,replacement,at),replacement),after=plan.rows.map(row=>decodeProposedCommandRecord('stockItems',records.find(r=>r.table==='stock_items'&&r.values.id===row.itemId)!) as unknown as StockItem);proposal={enabled:true,revisions:selected,items:after.map(row=>stockReviewProjection(stockReviewItem(row))),input:'input'in c?stockReviewInput(after[0]):null};}
 return {v:1,id:p.id,replacementId:p.replacementId,commandId:c.id,commandHash:'b'.repeat(64),sourceHash:p.sourceHash,businessId:f.setup.business.id,outletId:c.outletId,actorId:f.setup.owner.id,token:'x'.repeat(43),at,expiresAt:at+120000,current,proposal};
}
export function adjusted(reason:'count'|'received'|'used'|'waste'='received'){
 const f=stockFixture(),change=adjustStockCommand({id:f.items[0].id,revision:1,reason,quantity:2.125,source:'quick_update',note:literal},f,STOCK_AT+1000),p=packet(stockAdjustmentIntent(change),change);return {f,change,p};
}
