import {expect,it} from 'vitest';
import {stockReviewBoundary} from '../packages/core/stock-review-boundary';
import {parseStockCommand} from '../packages/core/stock-commands';
import {adjustStockCommand,saveStockMetadataCommand} from '../packages/core/stock';
import {stockAdjustmentIntent,stockSaveIntent} from '../apps/web/src/data/outbox-intents';
import {adjusted,packet,id} from './stock-review-fixture';
import {STOCK_AT} from './stock-fixture';
import {stockResolutionEvent} from './stock-resolution-fixture';
it('blocks a dependent physical count even when its old revision exactly matches the current item',async()=>{
 const {f,p}=adjusted('count'),event=await stockResolutionEvent(f,p),boundary=await stockReviewBoundary([event],p.command.outletId),next=parseStockCommand({...p.command,id:id(80000),moveId:id(80001)});expect(()=>boundary.assert(next)).toThrow(/withdrawn/);expect(f.items[0].revision).toBe(1);
});
it('keeps metadata and unrelated items usable after a movement withdrawal',async()=>{
 const {f,p}=adjusted('count'),event=await stockResolutionEvent(f,p),boundary=await stockReviewBoundary([event],p.command.outletId),metadata=saveStockMetadataCommand({...f.items[0],target:40},f.items[0],f,STOCK_AT+2000),other=adjustStockCommand({id:f.items[1].id,revision:1,reason:'received',quantity:1},f,STOCK_AT+2000);expect(()=>boundary.assert(stockSaveIntent(metadata,f.items[0]))).not.toThrow();expect(()=>boundary.assert(stockAdjustmentIntent(other))).not.toThrow();
});
it('uses actual admitted positions when server milliseconds tie and the incoming rows are unordered',async()=>{
 const {f,p}=adjusted('count'),withdrawn=await stockResolutionEvent(f,p,'withdrawn','9'),change=adjustStockCommand({id:f.items[0].id,revision:1,reason:'count',quantity:2},f,STOCK_AT+2000),nextPacket={...packet(stockAdjustmentIntent(change),change),id:id(90010),replacementId:id(90011)},replacement=await stockResolutionEvent(f,nextPacket,'replaced','10');replacement.at=withdrawn.at;(replacement.after as {receipt:{at:number;replacement:{receipt:{at:number;results:{updatedAt:number}[]}}}}).receipt.at=withdrawn.at;const receipt=(replacement.after as {receipt:{replacement:{receipt:{at:number;results:{updatedAt:number}[]}}}}).receipt.replacement.receipt;receipt.at=withdrawn.at;receipt.results[0].updatedAt=withdrawn.at;
 const boundary=await stockReviewBoundary([replacement,withdrawn],p.command.outletId),pending=parseStockCommand({...p.command,id:id(80000),moveId:id(80001)});expect(()=>boundary.assert(pending)).not.toThrow();
 const later=structuredClone(withdrawn);(later.after as {stockResolutionPosition:string}).stockResolutionPosition='11';const blocked=await stockReviewBoundary([later,replacement],p.command.outletId);expect(()=>blocked.assert(pending)).toThrow(/withdrawn/);
});
it('a metadata review does not clear an unresolved quantity withdrawal',async()=>{
 const {f,p}=adjusted('count'),withdrawn=await stockResolutionEvent(f,p),change=saveStockMetadataCommand({...f.items[0],target:40},f.items[0],f,STOCK_AT+2000),metadata={...packet(stockSaveIntent(change,f.items[0]),change),id:id(90010),replacementId:id(90011)},replacement=await stockResolutionEvent(f,metadata,'replaced','2'),boundary=await stockReviewBoundary([withdrawn,replacement],p.command.outletId);expect(()=>boundary.assert(parseStockCommand({...p.command,id:id(80000),moveId:id(80001)}))).toThrow(/withdrawn/);
});
it('keeps every original movement identity reserved even after an accepted replacement',async()=>{
 const {f,p}=adjusted('count'),event=await stockResolutionEvent(f,p,'replaced'),boundary=await stockReviewBoundary([event],p.command.outletId);expect(()=>boundary.assert(p.command)).toThrow();expect(()=>boundary.assert(parseStockCommand({...p.command,id:id(80000)}))).toThrow();
});
it.each(['position','duplicate','source','hash','actor','scope','outcome','time','resolution','missing kind','missing before','missing after','missing position'] as const)('rejects a damaged canonical %s proof instead of dropping the boundary',async kind=>{
 const {f,p}=adjusted('count'),event=await stockResolutionEvent(f,p),before=event.before as Record<string,unknown>,after=event.after as Record<string,unknown>;
 if(kind==='position')after.stockResolutionPosition='0';if(kind==='source')before.sourceJson='{}';if(kind==='hash')before.commandHash='f'.repeat(64);if(kind==='actor')event.actor.id=id(80000);if(kind==='scope')(after.receipt as {outletId:string}).outletId=id(80000);if(kind==='outcome')after.outcome='replaced';if(kind==='time')event.at++;if(kind==='resolution')before.resolutionId=id(80000);if(kind==='missing kind')delete before.commandType;if(kind==='missing before')event.before=null;if(kind==='missing after')event.after=null;if(kind==='missing position')delete after.stockResolutionPosition;await expect(stockReviewBoundary(kind==='duplicate'?[event,event]:[event],p.command.outletId)).rejects.toMatchObject({kind:'integrity'});
});
