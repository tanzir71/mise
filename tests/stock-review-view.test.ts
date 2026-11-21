import {expect,it} from 'vitest';
import {adjustStockCommand,archiveStockItemCommand,saveStockCountCommand,saveStockItemCommand,saveStockMetadataCommand,saveSupplierCommand,stockBatchCommand,undoStockMoveCommand} from '../packages/core/stock';
import {stockAdjustmentIntent,stockBatchIntent,stockSaveIntent} from '../apps/web/src/data/outbox-intents';
import {parseStockCommand} from '../packages/core/stock-commands';
import {parsePreparedStockReview} from '../packages/core/stock-review-view';
import {stockFixture,stockInput,STOCK_AT} from './stock-fixture';
import {id,literal,packet,apply,view,adjusted} from './stock-review-fixture';
it.each(['received','used','waste','count'] as const)('compares the original %s against a real newer physical count',reason=>{
 const {f,p}=adjusted(reason);apply(f,adjustStockCommand({id:f.items[0].id,revision:1,reason:'count',quantity:10},f,STOCK_AT+2000));const before=structuredClone(f),v=view(f,p);
 expect(parsePreparedStockReview(v,p)).toEqual(v);expect(v.current.items[0].item?.onHand).toBe(10);expect(v.proposal.enabled&&v.proposal.items[0]).toMatchObject({revision:3,onHand:reason==='count'?2.125:reason==='received'?12.125:7.875,lastCountedAt:reason==='count'?p.command.occurredAt:STOCK_AT+2000});expect(f).toEqual(before);
});
it('retains a zero-delta physical count, and includes every original metadata field',()=>{
 const f=stockFixture(),original=saveStockCountCommand({...f.items[0],name:' Saved name ',nameLocal:literal,aliases:[' A ','A',literal],target:30.125,lowAt:undefined},f.items[0],f,STOCK_AT+1000),p=packet(stockSaveIntent(original,f.items[0]),original),v=view(f,p);
 expect(parsePreparedStockReview(v,p)).toEqual(v);expect(v.proposal.enabled&&v.proposal.items[0]).toMatchObject({onHand:20,lastCountedAt:p.command.occurredAt});expect(v.proposal.enabled&&v.proposal.input).toMatchObject({name:'Saved name',nameLocal:literal,aliases:['A',literal],lowAt:15.062});
});
it('accepts structurally identical metadata regardless of JSON object insertion order',()=>{
 const f=stockFixture(),change=saveStockMetadataCommand({...f.items[0],nameLocal:literal},f.items[0],f,STOCK_AT+1000),p=packet(stockSaveIntent(change,f.items[0]),change),v=view(f,p);
 if(!v.proposal.enabled)throw Error();v.proposal.input=Object.fromEntries(Object.entries(v.proposal.input!).reverse()) as unknown as typeof v.proposal.input;expect(parsePreparedStockReview(v,p)).toEqual(v);
});
it('uses the actual lower predecessor after earlier offline dependencies were withdrawn',()=>{
 const f=stockFixture(),branch=structuredClone(f);apply(branch,adjustStockCommand({id:branch.items[0].id,revision:1,reason:'count',quantity:12},branch,STOCK_AT+500));const change=adjustStockCommand({id:branch.items[0].id,revision:2,reason:'used',quantity:1},branch,STOCK_AT+1000),p=packet(stockAdjustmentIntent(change),change),v=view(f,p);
 expect(parsePreparedStockReview(v,p).proposal).toMatchObject({enabled:true,revisions:[{revision:1}],items:[{onHand:19,revision:2}]});
});
it('keeps metadata-only changes separate from physical counts, including archived items',()=>{
 const {f}=adjusted(),change=saveStockMetadataCommand({...f.items[0],name:'Recorded name',target:40},f.items[0],f,STOCK_AT+1000),p=packet(stockSaveIntent(change,f.items[0]),change);apply(f,adjustStockCommand({id:f.items[0].id,revision:1,reason:'received',quantity:3},f,STOCK_AT+2000));apply(f,archiveStockItemCommand(f.items[0],true,2,f,STOCK_AT+3000));const v=view(f,p);
 expect(parsePreparedStockReview(v,p).proposal).toMatchObject({enabled:true,input:{onHand:23,name:'Recorded name',target:40},items:[{onHand:23,lastCountedAt:STOCK_AT,archivedAt:STOCK_AT+3000}]});
});
it('represents an original create, archive and restore through their actual domain projections',()=>{
 const f=stockFixture(),created=saveStockItemCommand({...stockInput,name:'New item'},f,null,0,STOCK_AT+1000),create=packet(stockSaveIntent(created,null),created);expect(parsePreparedStockReview(view(f,create),create).proposal).toMatchObject({enabled:true,revisions:[{revision:0}],items:[{revision:1,onHand:20,createdAt:create.command.occurredAt}]});
 const archived=archiveStockItemCommand(f.items[0],true,1,f,STOCK_AT+1000),archive=packet(parseStockCommand({id:archived.events[0].id,type:'stock.archive',outletId:f.setup.outlet.id,stockItemId:f.items[0].id,revision:1,occurredAt:STOCK_AT+1000}),archived);expect(parsePreparedStockReview(view(f,archive),archive).proposal).toMatchObject({enabled:true,items:[{archivedAt:STOCK_AT+1000,onHand:20}]});apply(f,archived);
 const restored=archiveStockItemCommand(f.items[0],false,2,f,STOCK_AT+2000),restore=packet(parseStockCommand({id:restored.events[0].id,type:'stock.restore',outletId:f.setup.outlet.id,stockItemId:f.items[0].id,revision:2,occurredAt:STOCK_AT+2000}),restored);expect(parsePreparedStockReview(view(f,restore),restore).proposal).toMatchObject({enabled:true,items:[{archivedAt:null,onHand:20}]});
});
it('requires every ordered line of a complete 1,000-item comparison with the original secondary audit IDs',()=>{
 const f=stockFixture(),base=f.items[0];f.items=Array.from({length:1000},(_,i)=>({...base,id:id(1000+i),eventId:id(2000+i),name:'Item '+i,activeKey:'item '+i}));f.moves=[];const change=stockBatchCommand(f.items.map(item=>({id:item.id,revision:1,reason:'count',quantity:0.125,note:literal})),f,STOCK_AT+1000,true),p=packet(stockBatchIntent(change,true),change),v=view(f,p);
 expect(parsePreparedStockReview(v,p).current.items).toHaveLength(1000);if(!v.proposal.enabled||p.command.type!=='stock.batch')throw Error();expect(v.proposal.items[0].eventId).toBe(p.replacementId);expect(v.proposal.items[999].eventId).toBe(p.command.changes[999].eventId);expect(v.proposal.items.every(item=>item.onHand===0.125)).toBe(true);
 const missing=structuredClone(v);if(!missing.proposal.enabled)throw Error();missing.proposal.items.pop();expect(()=>parsePreparedStockReview(missing,p)).toThrow();const reordered=structuredClone(v);reordered.current.items.reverse();expect(()=>parsePreparedStockReview(reordered,p)).toThrow();
});
it('undo shows the actual movement, restored count time and original 24-hour limit',()=>{
 const {f,change}=adjusted('used');apply(f,change);const movement=change.moves[0],undone=undoStockMoveCommand(movement,2,f,STOCK_AT+2000),c=parseStockCommand({id:undone.events[0].id,type:'stock.undo',outletId:f.setup.outlet.id,stockItemId:f.items[0].id,revision:2,undoMoveId:movement.id,moveId:undone.moves[0].id,occurredAt:STOCK_AT+2000}),p=packet(c,undone),v=view(f,p,movement.createdAt+86400000);
 expect(parsePreparedStockReview(v,p).proposal).toMatchObject({enabled:true,items:[{onHand:20,lastCountedAt:STOCK_AT}]});
 for(const patch of [{reversed:true},{laterCount:true},{move:{...v.current.undo!.move,eventId:id(40000)}},{move:{...v.current.undo!.move,delta:-1,before:20,after:19}}])expect(()=>parsePreparedStockReview({...v,current:{...v.current,undo:{...v.current.undo,...patch}}},p)).toThrow();expect(()=>parsePreparedStockReview({...v,at:v.at+1},p)).toThrow();
});
it.each(['unit','birth','identity','scope','revision','quantity','archive','count','event'] as const)('rejects a reviewed proposal after its %s facts were changed',field=>{
 const {f,p}=adjusted(),v=view(f,p);if(!v.proposal.enabled)throw Error();const next=v.proposal.items[0],current=v.current.items[0].item!;
 if(field==='unit'){current.unit='g';next.unit='g';}else if(field==='birth'){current.createdAt++;next.createdAt++;}else if(field==='identity')next.id=id(40000);else if(field==='scope')next.outletId=id(40000);else if(field==='revision')next.revision++;else if(field==='quantity')next.onHand++;else if(field==='archive')next.archivedAt=STOCK_AT;else if(field==='count')next.lastCountedAt=STOCK_AT+1;else next.eventId=id(40000);
 expect(()=>parsePreparedStockReview(v,p)).toThrow();
});
it('keeps withdrawal available for a missing item, changed unit or expired undo without claiming a replacement',()=>{
 const {f,p}=adjusted();for(const missing of [false,true]){const current=structuredClone(f);if(missing)current.items=[];else current.items[0].unit='g';const v=view(current,p,STOCK_AT+10000,false);expect(parsePreparedStockReview(v,p).proposal).toEqual({enabled:false,reason:'unavailable'});}
 for(const reason of ['unit','unavailable','clock','expired','count'] as const){const v=view(f,p,STOCK_AT+10000,false);v.proposal={enabled:false,reason};expect(parsePreparedStockReview(v,p).proposal).toEqual(v.proposal);}
});
it('does not make an unchanged proposal depend on the token or refreshed admission clock',()=>{
 const {f,p}=adjusted(),a=view(f,p),b=view(f,p,STOCK_AT+11000);b.token='y'.repeat(43);expect(parsePreparedStockReview(a,p).proposal).toEqual(parsePreparedStockReview(b,p).proposal);expect(a.current).toEqual(b.current);
});
it('rejects extra authority and changed original comparison bindings',()=>{
 const {f,p}=adjusted(),v=view(f,p);for(const patch of [{commandId:id(40000)},{sourceHash:'d'.repeat(64)},{outletId:id(40000)},{replacementId:id(40000)},{actorId:id(40000)},{commandHash:'bad'},{token:'bad'},{expiresAt:v.at},{expiresAt:v.at+300001},{authority:true}])expect(()=>parsePreparedStockReview({...v,...patch},p)).toThrow();
 expect(()=>parsePreparedStockReview({...v,current:{...v.current,session:'hidden'}},p)).toThrow();expect(()=>parsePreparedStockReview({...v,current:{...v.current,timezone:'Invalid/Zone'}},p)).toThrow();
});
it('shows the saved and current supplier selections under their actual checked names',()=>{
 const f=stockFixture(),saved=saveSupplierCommand({name:'Saved supplier · বাংলা\0\ud800',phone:'',note:''},f.setup,null,0,STOCK_AT).supplier,current=saveSupplierCommand({name:'Current supplier',phone:'',note:''},f.setup,null,0,STOCK_AT).supplier;f.suppliers.push(saved,current);const original=saveStockMetadataCommand({...f.items[0],supplierId:saved.id},f.items[0],f,STOCK_AT+1000),p=packet(stockSaveIntent(original,f.items[0]),original);apply(f,saveStockMetadataCommand({...f.items[0],supplierId:current.id},f.items[0],f,STOCK_AT+2000));const v=view(f,p);
 expect(parsePreparedStockReview(v,p).current.suppliers).toEqual({saved:{id:saved.id,name:saved.name,archived:false},current:{id:current.id,name:current.name,archived:false}});expect(v.proposal).toMatchObject({enabled:true,input:{supplierId:saved.id}});expect(()=>parsePreparedStockReview({...v,current:{...v.current,suppliers:{...v.current.suppliers,saved:{...v.current.suppliers.saved,id:current.id}}}},p)).toThrow();
});
