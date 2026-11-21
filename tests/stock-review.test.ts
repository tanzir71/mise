import {expect,it} from 'vitest';
import {parseStockCommand,stockWritePlan,stockBatchBodyLimit,type StockCommand} from '../packages/core/stock-commands';
import {parseStockReviewRevisions,parseStockResolutionReceipt,reviewedStockProposal,stockReviewReservedIds} from '../packages/core/stock-review';
import {adjustStockCommand,saveStockMetadataCommand,saveStockItemCommand} from '../packages/core/stock';
import {stockSaveIntent} from '../apps/web/src/data/outbox-intents';
import {replayStockRecords} from '../packages/core/stock-replay';
import {cloudRecordMaps,encodeCommandRecord,decodeProposedCommandRecord} from '../packages/core/cloud-records';
import {stockFixture,STOCK_AT} from './stock-fixture';
import type {StockContext} from '../packages/core/stock';
import type {BackupTable} from '../packages/core/backup-tables';
const id=(n:number)=>String(n).padStart(26,'0'),literal='Original · বাংলা\0\ud800';
const delta=():StockCommand=>parseStockCommand({id:id(1),type:'stock.adjust',outletId:id(2),occurredAt:1000,moveId:id(3),change:{id:id(4),revision:1,reason:'received',quantity:1.125,source:'quick_update',note:literal}});
const selected=(c:StockCommand,revision=4)=>stockWritePlan(c).rows.map(row=>({stockItemId:row.itemId,revision}));
it('keeps the saved relative quantity, literal note, movement identity and occurrence time in a distinct reviewed action',()=>{
 const original=delta(),before=JSON.stringify(original),proposal=reviewedStockProposal(original,id(10),selected(original));
 expect(proposal).toEqual({...original,id:id(10),change:{...(original.type==='stock.adjust'?original.change:{}),revision:4}});expect(JSON.stringify(original)).toBe(before);
});
it('a reviewed on-hand edit retains every original quantity and metadata field instead of rescaling the recorded unit',()=>{
 const c=parseStockCommand({id:id(1),type:'stock.update',outletId:id(2),stockItemId:id(4),revision:1,occurredAt:1000,moveId:id(3),input:{name:literal,nameLocal:literal,unit:'kg',category:'Food',aliases:[literal],onHand:0.125,target:30,packSize:1.5,lowAt:5,supplierId:id(7)}}),proposal=reviewedStockProposal(c,id(10),selected(c));
 expect(proposal).toEqual({...c,id:id(10),revision:4});expect('input'in proposal&&proposal.input).toEqual('input'in c&&c.input);
});
it.each(['stock.archive','stock.restore'] as const)('a %s choice keeps its desired state and has no invented movement',type=>{
 const c=parseStockCommand({id:id(1),type,outletId:id(2),stockItemId:id(4),revision:1,occurredAt:1000});expect(reviewedStockProposal(c,id(10),selected(c))).toEqual({...c,id:id(10),revision:4});
});
it('a reviewed opening count requires the original new item identity and no existing revision',()=>{
 const c=parseStockCommand({id:id(1),type:'stock.create',outletId:id(2),stockItemId:id(4),occurredAt:1000,moveId:id(3),input:{name:'Rice',nameLocal:'চাল',unit:'kg',category:'Food',aliases:[],onHand:20.125,target:30,packSize:1,lowAt:null,supplierId:null}});
 expect(reviewedStockProposal(c,id(10),selected(c,0))).toEqual({...c,id:id(10)});expect(()=>reviewedStockProposal(c,id(10),selected(c,1))).toThrow();
});
it('an entire physical-count batch retains every reserved movement and batch ID while replacing only its first command audit identity',()=>{
 const c=parseStockCommand({id:id(1),type:'stock.batch',outletId:id(2),occurredAt:1000,count:true,batchId:id(9),changes:[{id:id(4),revision:1,eventId:id(1),moveId:id(3),reason:'count',quantity:2.125,source:'count',note:literal},{id:id(5),revision:2,eventId:id(6),moveId:id(7),reason:'count',quantity:0,source:'count',note:''}]}),before=JSON.stringify(c),revisions=[{stockItemId:id(4),revision:4},{stockItemId:id(5),revision:5}],proposal=reviewedStockProposal(c,id(10),revisions);
 expect(proposal).toEqual({...c,id:id(10),changes:c.type==='stock.batch'?c.changes.map((line,i)=>({...line,revision:i?5:4,eventId:i?line.eventId:id(10)})):[]});expect(JSON.stringify(c)).toBe(before);
 for(const invalid of [revisions.slice(0,1),[revisions[1],revisions[0]],[revisions[0],revisions[0]],[...revisions,{stockItemId:id(8),revision:4}]])expect(()=>reviewedStockProposal(c,id(10),invalid)).toThrow();
});
it('all 1,000 maximum-escaped original count lines survive the reviewed proposal without a smaller payload or batch limit',()=>{
 const c=parseStockCommand({id:id(2000),type:'stock.batch',outletId:id(2),occurredAt:1000,count:true,batchId:id(9000),changes:Array.from({length:1000},(_,i)=>({id:id(6000+i),revision:1,eventId:id(2000+i),moveId:id(4000+i),reason:'count',quantity:0.125,source:'count',note:String.fromCharCode(0xd800).repeat(1000)}))});
 const before=JSON.stringify(c),proposal=reviewedStockProposal(c,id(10000),selected(c));expect(new TextEncoder().encode(before).length).toBeLessThan(stockBatchBodyLimit);expect(JSON.stringify(c)).toBe(before);if(c.type!=='stock.batch'||proposal.type!=='stock.batch')throw Error();
 expect(proposal.changes).toHaveLength(1000);expect(proposal.batchId).toBe(c.batchId);expect(proposal.changes.map(x=>x.moveId)).toEqual(c.changes.map(x=>x.moveId));expect(proposal.changes.every(x=>x.quantity===0.125&&x.note===c.changes[0].note&&x.revision===4)).toBe(true);expect(proposal.changes[999].eventId).toBe(c.changes[999].eventId);
});
it('checked revisions cannot be missing, invented, borrowed from another item or invalid for an existing item',()=>{
 const c=delta();for(const revisions of [[],[{stockItemId:id(5),revision:4}],[{stockItemId:id(4),revision:0}],[{stockItemId:id(4),revision:1.5}],[{stockItemId:id(4),revision:Number.MAX_SAFE_INTEGER}],[{stockItemId:id(4),revision:4,authority:true}]])expect(()=>parseStockReviewRevisions(revisions,c)).toThrow();
 for(const reserved of stockReviewReservedIds(c))expect(()=>reviewedStockProposal(c,reserved,selected(c))).toThrow();
});
function context(ctx:StockContext,command:StockCommand,at:number){
 const businessId=ctx.setup.business.id,raw=(table:BackupTable,row:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,row,businessId).values).map(([key,value])=>[key,value!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[key]?.startsWith('j:')?JSON.parse(value as string):value]));
 return {businessId,outletId:ctx.setup.outlet.id,actorId:ctx.setup.owner.id,at,contextJson:JSON.stringify({business:raw('businesses',ctx.setup.business),outlet:raw('outlets',ctx.setup.outlet),items:ctx.items.map(x=>raw('stockItems',x)),moves:ctx.moves.filter(x=>stockWritePlan(command).rows.some(row=>row.itemId===x.stockItemId)).map(x=>raw('stockMoves',x)),suppliers:[]})};
}
it('a count remains strict until an explicit replacement uses its reviewed current revision, then sets the original absolute quantity',()=>{
 const f=stockFixture(),item=f.items[0],received=adjustStockCommand({id:item.id,revision:1,reason:'received',quantity:3},f,STOCK_AT+1000);f.items[0]=received.items[0];f.moves.push(...received.moves);
 const c=parseStockCommand({id:id(1),type:'stock.adjust',outletId:f.setup.outlet.id,occurredAt:STOCK_AT+500,moveId:id(3),change:{id:item.id,revision:1,reason:'count',quantity:2.125,source:'count',note:literal}});
 expect(()=>replayStockRecords(context(f,c,STOCK_AT+2000),c)).toThrow(/latest stock/);const proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:2}]),records=replayStockRecords(context(f,proposal,STOCK_AT+2000),proposal),row=records.find(x=>x.table==='stock_items')!;
 expect(row.values).toMatchObject({id:item.id,on_hand:2.125,revision:3});expect(records.find(x=>x.table==='stock_moves')!.values).toMatchObject({id:id(3),before_quantity:23,after_quantity:2.125,delta:-20.875,created_at:c.occurredAt});
 expect(decodeProposedCommandRecord('stockItems',row)).toMatchObject({name:item.name,unit:item.unit});expect(decodeProposedCommandRecord('stockMoves',records.find(x=>x.table==='stock_moves')!)).toMatchObject({note:literal,unit:item.unit});
});
it('a deliberate review can use the actual lower revision after earlier local dependencies were withdrawn, without weakening ordinary delivery',()=>{
 const f=stockFixture(),item=f.items[0],c=parseStockCommand({id:id(1),type:'stock.adjust',outletId:f.setup.outlet.id,occurredAt:STOCK_AT+1000,moveId:id(3),change:{id:item.id,revision:4,reason:'count',quantity:2.125,source:'count',note:literal}});
 expect(()=>replayStockRecords(context(f,c,STOCK_AT+2000),c)).toThrow(/latest stock/);const proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:1}]);
 expect(proposal.type==='stock.adjust'&&proposal.change).toMatchObject({revision:1,quantity:2.125,reason:'count'});expect(replayStockRecords(context(f,proposal,STOCK_AT+2000),proposal).find(x=>x.table==='stock_items')!.values).toMatchObject({on_hand:2.125,revision:2});
});
it('a reviewed on-hand edit keeps its original physical-count movement when the current quantity already equals that count',()=>{
 const f=stockFixture(),item=f.items[0],received=adjustStockCommand({id:item.id,revision:1,reason:'received',quantity:3},f,STOCK_AT+1000);f.items[0]=received.items[0];f.moves.push(...received.moves);
 const recorded=saveStockItemCommand({...f.items[0],name:'Recorded count name',onHand:20},f,f.items[0],2,STOCK_AT+1500),c=stockSaveIntent(recorded,f.items[0]);
 const used=adjustStockCommand({id:item.id,revision:2,reason:'used',quantity:3},f,STOCK_AT+2000);f.items[0]=used.items[0];f.moves.push(...used.moves);expect(f.items[0].onHand).toBe(20);
 const proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:3}]),records=replayStockRecords(context(f,proposal,STOCK_AT+3000),proposal);
 expect(records.find(x=>x.table==='stock_moves')!.values).toMatchObject({id:recorded.moves[0].id,before_quantity:20,after_quantity:20,delta:0,reason:'count',created_at:c.occurredAt});expect(decodeProposedCommandRecord('stockItems',records.find(x=>x.table==='stock_items')!)).toMatchObject({name:'Recorded count name',onHand:20,revision:4,lastCountedAt:c.occurredAt});
});
it('a reviewed relative quantity uses the current physical count without erasing its barrier for other retained actions',()=>{
 const f=stockFixture(),item=f.items[0],counted=adjustStockCommand({id:item.id,revision:1,reason:'count',quantity:10},f,STOCK_AT+1000);f.items[0]=counted.items[0];f.moves.push(...counted.moves);
 const c=parseStockCommand({id:id(1),type:'stock.adjust',outletId:f.setup.outlet.id,occurredAt:STOCK_AT+500,moveId:id(3),change:{id:item.id,revision:1,reason:'received',quantity:0.125,source:'quick_update',note:literal}}),before=JSON.stringify(f);
 expect(()=>replayStockRecords(context(f,c,STOCK_AT+2000),c)).toThrow(/physical count/);const proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:2}]),records=replayStockRecords(context(f,proposal,STOCK_AT+2000),proposal);
 expect(decodeProposedCommandRecord('stockItems',records.find(x=>x.table==='stock_items')!)).toMatchObject({onHand:10.125,lastCountedAt:STOCK_AT+1000,unit:item.unit});expect(JSON.stringify(f)).toBe(before);expect(()=>replayStockRecords(context(f,c,STOCK_AT+2000),c)).toThrow(/physical count/);
});
it('a reviewed shortage cannot silently clip the original used quantity or turn it into another stock action',()=>{
 const f=stockFixture(),item=f.items[0],counted=adjustStockCommand({id:item.id,revision:1,reason:'count',quantity:10},f,STOCK_AT+1000);f.items[0]=counted.items[0];f.moves.push(...counted.moves);
 const c=parseStockCommand({id:id(1),type:'stock.adjust',outletId:f.setup.outlet.id,occurredAt:STOCK_AT+500,moveId:id(3),change:{id:item.id,revision:1,reason:'used',quantity:12,source:'manual',note:literal}}),proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:2}]);
 expect(proposal.type==='stock.adjust'&&proposal.change).toMatchObject({quantity:12,reason:'used'});expect(()=>replayStockRecords(context(f,proposal,STOCK_AT+2000),proposal)).toThrow();
});
it('updating an undo revision cannot extend the original movement deadline or bypass a later physical count',()=>{
 const f=stockFixture(),item=f.items[0],used=adjustStockCommand({id:item.id,revision:1,reason:'used',quantity:2},f,STOCK_AT+1000);f.items[0]=used.items[0];f.moves.push(...used.moves);const movement=used.moves[0];
 const metadata=saveStockMetadataCommand({...f.items[0],target:40},f.items[0],f,STOCK_AT+2000);f.items[0]=metadata.items[0];
 const c=parseStockCommand({id:id(1),type:'stock.undo',outletId:f.setup.outlet.id,occurredAt:STOCK_AT+3000,stockItemId:item.id,revision:2,undoMoveId:movement.id,moveId:id(3)}),proposal=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:3}]);
 expect(proposal).toEqual({...c,id:id(10),revision:3});expect(replayStockRecords(context(f,proposal,STOCK_AT+4000),proposal).find(x=>x.table==='stock_items')!.values.on_hand).toBe(20);
 expect(replayStockRecords(context(f,proposal,movement.createdAt+86400000),proposal).find(x=>x.table==='stock_items')!.values.on_hand).toBe(20);
 expect(()=>replayStockRecords(context(f,proposal,movement.createdAt+86400001),proposal)).toThrow();
 const counted=adjustStockCommand({id:item.id,revision:3,reason:'count',quantity:10},f,STOCK_AT+5000);f.items[0]=counted.items[0];f.moves.push(...counted.moves);const later=reviewedStockProposal(c,id(10),[{stockItemId:item.id,revision:4}]);expect(()=>replayStockRecords(context(f,later,STOCK_AT+6000),later)).toThrow();
});
function proof(c=delta()){
 const revisions=selected(c),proposal=reviewedStockProposal(c,id(10),revisions),plan=stockWritePlan(proposal);
 return {id:id(11),type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:'a'.repeat(64),sourceHash:'b'.repeat(64),at:3000,outcome:'replaced',replacement:{id:proposal.id,commandHash:'c'.repeat(64),revisions,receipt:{id:proposal.id,type:proposal.type,outletId:proposal.outletId,occurredAt:proposal.occurredAt,at:2000,batchId:plan.batchId,undoOf:plan.undoMoveId,results:plan.rows.map((row,i)=>({stockItemId:row.itemId,eventId:row.eventId,moveId:row.moveId,revision:revisions[i].revision+1,onHand:23.125,updatedAt:2000}))}}};
}
it('a typed replacement receipt validates the exact selected stock revisions and clocks',()=>{
 const c=delta(),p=proof(c);expect(parseStockResolutionReceipt(p,c)).toEqual(p);
 const row=p.replacement.receipt.results[0];for(const patch of [{revision:6},{revision:4},{eventId:id(90)},{moveId:id(90)},{stockItemId:id(90)},{updatedAt:1999},{onHand:0.0001}])expect(()=>parseStockResolutionReceipt({...p,replacement:{...p.replacement,receipt:{...p.replacement.receipt,results:[{...row,...patch}]}}},c)).toThrow();
 expect(()=>parseStockResolutionReceipt({...p,at:1999},c)).toThrow();expect(()=>parseStockResolutionReceipt({...p,replacement:{...p.replacement,revisions:selected(c,3)}},c)).toThrow();
});
it('a resolution records a genuinely selected lower predecessor after an earlier local dependency was withdrawn',()=>{
 const original=delta();if(original.type!=='stock.adjust')throw Error();const c={...original,change:{...original.change,revision:4}},p=proof(c);p.replacement.revisions=selected(c,1);p.replacement.receipt.results[0].revision=2;
 expect(parseStockResolutionReceipt(p,c).replacement).toMatchObject({revisions:[{stockItemId:original.change.id,revision:1}],receipt:{results:[{revision:2}]}});expect(()=>parseStockResolutionReceipt({...p,replacement:{...p.replacement,receipt:{...p.replacement.receipt,results:[{...p.replacement.receipt.results[0],revision:3}]}}},c)).toThrow();
});
it('a withdrawal never masquerades as a movement and original command/scope/source bindings stay exact',()=>{
 const c=delta(),p={...proof(c),outcome:'withdrawn',replacement:null};expect(parseStockResolutionReceipt(p,c).replacement).toBeNull();
 for(const patch of [{id:c.id},{id:id(4)},{commandId:id(80)},{commandType:'stock.undo'},{outletId:id(80)},{occurredAt:1001},{sourceHash:''},{commandHash:''},{outcome:'accepted'},{replacement:proof(c).replacement},{authority:true}])expect(()=>parseStockResolutionReceipt({...p,...patch},c)).toThrow();
});
