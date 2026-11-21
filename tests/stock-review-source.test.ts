import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import Dexie from 'dexie';
import {stockFixture,stockInput,STOCK_AT} from './stock-fixture';
import {adjustStockCommand,stockBatchCommand,saveStockItemCommand,saveStockCountCommand,type StockChange,type StockContext} from '../packages/core/stock';
import {stockAdjustmentIntent,stockBatchIntent,stockSaveIntent} from '../apps/web/src/data/outbox-intents';
import {prepareStockReviewSource} from '../apps/web/src/data/stock-review-source';
import {parseStockReviewRequest,parseStockReviewSource,stockReviewSourceAudits,stockReviewSourceLimit,stockReviewBodyLimit,type StockReviewRequest} from '../packages/core/stock-review-source';
import {stockWritePlan,stockBatchBodyLimit,type StockCommand} from '../packages/core/stock-commands';
import {stockNameKey} from '../packages/core/stock-quantity';
import {nativeRowHash} from '../apps/web/src/data/canonical-writes';
import type {LocalOutboxEntry,LocalRowChange} from '../packages/core/local-outbox';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal} from '../apps/web/src/data/cloud-upload';
import {beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {cloudUploadFixture,uploadId} from './cloud-upload-fixture';
import {backupToken} from '../packages/core/backup';
const id=(n:number)=>String(n).padStart(26,'0'),literal='Original note · বাংলা\0\ud800',databases:Dexie[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
function setup(){const f=stockFixture(),change=adjustStockCommand({id:f.items[0].id,revision:1,reason:'received',quantity:1.125,source:'quick_update',note:literal},f,STOCK_AT+1000),command=stockAdjustmentIntent(change);return {f,change,command};}
function packet(command:StockCommand,change:StockChange):StockReviewRequest{return {id:id(90000),replacementId:id(90001),command,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,entryId:id(90002),sequence:1,commandIndex:0,at:STOCK_AT+1000,events:stockReviewSourceAudits(command,change.events)})};}
function changes(f:StockContext,change:StockChange):LocalRowChange[]{return [
 ...change.items.map(after=>({table:'stockItems' as const,key:after.id,before:f.items.find(x=>x.id===after.id)??null,after})),
 ...change.moves.map(after=>({table:'stockMoves' as const,key:after.id,before:null,after})),
 ...change.events.map(after=>({table:'events' as const,key:after.id,before:null,after})),
];}
function row(f:StockContext,commands:StockCommand[],records:LocalRowChange[]):LocalOutboxEntry{return {id:id(90002),version:1,uploadId:id(90003),businessId:f.setup.business.id,outletId:f.setup.outlet.id,sequence:1,at:STOCK_AT+1000,status:'pending',commands,receipts:[],changes:records};}
it('retains the original immediate quantity, unit, movement, member and literal source without duplicating notes on the wire',async()=>{
 const {f,change,command}=setup(),original=row(f,[command],changes(f,change)),saved=structuredClone(original),p=await prepareStockReviewSource(original,0,id(90000),id(90001)),source=parseStockReviewSource(p);
 expect(parseStockReviewRequest(p,false)).toEqual(p);expect(source.events[0]).toMatchObject({id:command.id,actorId:f.setup.owner.id,at:command.occurredAt,before:{onHand:20,unit:'kg',revision:1},after:{item:{onHand:21.125,unit:'kg',revision:2},move:{id:change.moves[0].id,delta:1.125,before:20,after:21.125}}});
 expect(p.command.type==='stock.adjust'&&p.command.change.note).toBe(literal);expect(p.sourceJson).not.toContain('Original note');expect(original).toEqual(saved);
});
it.each(['quantity','unit','scope','item','revision','event','actor','movement','delta','reason','source','time','count','archive','authority'])('rejects a changed original %s fact before a comparison can be used',kind=>{
 const {change,command}=setup(),p=packet(command,change),s=JSON.parse(p.sourceJson),e=s.events[0];
 if(kind==='quantity')e.after.item.onHand=22;else if(kind==='unit')e.after.item.unit='L';else if(kind==='scope')e.before.outletId=id(80000);else if(kind==='item')e.stockItemId=id(80000);else if(kind==='revision')e.before.revision++;else if(kind==='event')e.after.item.eventId=id(80000);else if(kind==='actor')e.actorId=id(80000);else if(kind==='movement')e.after.move.id=id(80000);else if(kind==='delta')e.after.move.delta=2;else if(kind==='reason')e.after.move.reason='count';else if(kind==='source')e.after.move.source='manual';else if(kind==='time')e.at++;else if(kind==='count')e.after.item.lastCountedAt++;else if(kind==='archive')e.after.item.archivedAt=command.occurredAt;else e.auth_user_id='authority';
 expect(()=>parseStockReviewRequest({...p,sourceJson:JSON.stringify(s)},false)).toThrow();
});
it('checks the full original input and note before projecting a selective source capsule',()=>{
 const f=stockFixture(),change=saveStockItemCommand({...stockInput,name:'Recorded rice',nameLocal:'চাল',aliases:[literal],onHand:2.125},f,null,0,STOCK_AT+1000),c=stockSaveIntent(change,null);
 expect(stockReviewSourceAudits(c,change.events)[0].after.item.name).toBe('Recorded rice');
 for(const patch of [{aliases:['Changed']},{target:99},{packSize:9},{lowAt:1},{category:'Changed'},{nameLocal:'Changed'},{supplierId:id(80000)},{activeKey:'Changed'}]){const bad=structuredClone(change.events);Object.assign((bad[0].after as {item:unknown}).item as object,patch);expect(()=>stockReviewSourceAudits(c,bad)).toThrow();}
 const bad=structuredClone(change.events);(bad[0].after as {move:{note:string}}).move.note='Changed';expect(()=>stockReviewSourceAudits(c,bad)).toThrow();
});
it('preserves a real backwards device clock without inventing a later original occurrence',()=>{
 const f=stockFixture(),change=adjustStockCommand({id:f.items[0].id,revision:1,reason:'received',quantity:1},f,STOCK_AT-100),c=stockAdjustmentIntent(change),source=parseStockReviewSource(packet(c,change));
 expect(source.events[0].before!.createdAt).toBe(STOCK_AT);expect(source.events[0].after.item.updatedAt).toBe(STOCK_AT-100);expect(source.events[0].at).toBe(c.occurredAt);
});
it('distinguishes an explicit same-quantity physical count from an ordinary metadata edit in its retained audit',()=>{
 const f=stockFixture(),before=f.items[0],counted=saveStockCountCommand({...before},before,f,STOCK_AT+1000),count=stockSaveIntent(counted,before),source=parseStockReviewSource(packet(count,counted));
 expect(source.events[0].after).toMatchObject({item:{onHand:20,lastCountedAt:count.occurredAt},move:{before:20,after:20,delta:0,reason:'count'}});
 const metadata=saveStockItemCommand({...before,target:40},f,before,before.revision,STOCK_AT+1000),edit=stockSaveIntent(metadata,before);expect(parseStockReviewSource(packet(edit,metadata)).events[0].after).toMatchObject({item:{onHand:20,lastCountedAt:before.lastCountedAt},move:null});
});
it('matches the selected later action audit when a grouped entry contains only the final collapsed stock row',async()=>{
 const f=stockFixture(),created=saveStockItemCommand({...stockInput,name:'Grouped original'},f,null,0,STOCK_AT),create=stockSaveIntent(created,null);f.items.push(...created.items);f.moves.push(...created.moves);
 const added=adjustStockCommand({id:created.items[0].id,revision:1,reason:'received',quantity:1.125,note:literal},f,STOCK_AT+1000),command=stockAdjustmentIntent(added),records=[...changes(f,created).filter(c=>c.table!=='stockItems'),...changes(f,added).filter(c=>c.table!=='stockItems'),{table:'stockItems' as const,key:created.items[0].id,before:null,after:added.items[0]}],original=row(f,[create,command],records);
 original.receipts=[{id:create.id,type:create.type,outletId:create.outletId,occurredAt:create.occurredAt,at:STOCK_AT+500,batchId:null,undoOf:null,results:[{stockItemId:created.items[0].id,eventId:create.id,moveId:created.moves[0].id,revision:1,onHand:20,updatedAt:STOCK_AT+500}]}];
 const saved=structuredClone(original),p=await prepareStockReviewSource(original,1,id(90000),id(90001)),source=parseStockReviewSource(p);expect(source.commandIndex).toBe(1);expect(source.events[0]).toMatchObject({before:{id:created.items[0].id,onHand:20,revision:1},after:{item:{onHand:21.125,revision:2}}});expect(original).toEqual(saved);
 await expect(prepareStockReviewSource(original,0,id(90000),id(90001))).rejects.toThrow();const bad=structuredClone(original);bad.receipts[0].id=id(80000);await expect(prepareStockReviewSource(bad,1,id(90000),id(90001))).rejects.toThrow();
});
it('keeps complete original image bytes in the source fingerprint without putting them or unrelated fields in the capsule',async()=>{
 const {f,change,command}=setup(),original=row(f,[command],changes(f,change));original.changes.push({table:'inboxItems',key:id(80000),before:null,after:{id:id(80000),images:[{id:id(80001),data:new Blob([new Uint8Array([0,1,2,255])],{type:'image/png'})}],privateContext:'not on the wire'}});
 const before=await nativeRowHash(original),a=await prepareStockReviewSource(original,0,id(90000),id(90001));expect(await nativeRowHash(original)).toBe(before);expect(a.sourceJson).not.toContain('images');expect(a.sourceJson).not.toContain('privateContext');
 const changed=structuredClone(original);(changed.changes.at(-1)!.after as {images:{data:Blob}[]}).images[0].data=new Blob([new Uint8Array([0,1,3,255])],{type:'image/png'});const b=await prepareStockReviewSource(changed,0,id(90000),id(90001));expect(b.sourceHash).not.toBe(a.sourceHash);expect(b.sourceJson).toBe(a.sourceJson);
});
it('rejects missing, duplicated or rewritten audit rows instead of borrowing the current working item',async()=>{
 const {f,change,command}=setup(),original=row(f,[command],changes(f,change)),audit=original.changes.find(c=>c.table==='events')!;
 const missing={...original,changes:original.changes.filter(c=>c.table!=='events')};await expect(prepareStockReviewSource(missing,0,id(90000),id(90001))).rejects.toThrow();
 await expect(prepareStockReviewSource({...original,changes:[...original.changes,audit]},0,id(90000),id(90001))).rejects.toThrow();await expect(prepareStockReviewSource({...original,changes:original.changes.map(c=>c===audit?{...c,before:c.after}:c)},0,id(90000),id(90001))).rejects.toThrow();
});
it('keeps all 1,000 maximally escaped count notes and source facts inside explicit review budgets',()=>{
 const f=stockFixture(),base=f.items[0],surrogate=String.fromCharCode(0xd800);f.items=Array.from({length:1000},(_,i)=>{const name=String(i).padStart(4,'0')+surrogate.repeat(116);return {...base,id:id(1000+i),eventId:id(5000+i),name,activeKey:stockNameKey(name),unit:surrogate.repeat(24),onHand:999999999.999};});f.moves=[];
 const indexes=new Map(f.items.map((item,i)=>[item.id,i])),change=stockBatchCommand(f.items.map(item=>({id:item.id,revision:1,reason:'count',quantity:999999998.998,source:'count',note:surrogate.repeat(1000)})),f,STOCK_AT+1000,true,(kind,itemId)=>kind==='batch'?id(50000):id((kind==='event'?30000:40000)+indexes.get(itemId!)!)),c=stockBatchIntent(change,true),p=packet(c,change),checked=parseStockReviewRequest(p,false);
 expect(stockWritePlan(checked.command).rows).toHaveLength(1000);expect(parseStockReviewSource(checked).events).toHaveLength(1000);expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThan(stockBatchBodyLimit);expect(new TextEncoder().encode(p.sourceJson).length).toBeLessThan(stockReviewSourceLimit);expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(stockReviewBodyLimit);if(checked.command.type!=='stock.batch')throw Error();expect(checked.command.changes.every(x=>x.note===surrogate.repeat(1000))).toBe(true);
});
it('keeps request fields, source bounds and review identities closed, including historical audit identities',()=>{
 const {change,command}=setup(),p=packet(command,change),source=parseStockReviewSource(p);
 for(const patch of [{id:command.id},{replacementId:p.id},{id:source.events[0].actorId},{replacementId:source.events[0].before!.eventId},{sourceHash:''},{sourceJson:p.sourceJson+' '.repeat(stockReviewSourceLimit)},{authority:true}])expect(()=>parseStockReviewRequest({...p,...patch},false)).toThrow();
 expect(parseStockReviewRequest({...p,token:'x'.repeat(43),outcome:'withdrawn'},true).outcome).toBe('withdrawn');expect(()=>parseStockReviewRequest({...p,token:'x'.repeat(43),outcome:'replaced',confirmCredit:false},true)).toThrow();
});
it('keeps derived source encoding unambiguous without normalizing original literal code units',()=>{
 const {change,command}=setup(),p=packet(command,change);
 for(const sourceJson of [' '+p.sourceJson,p.sourceJson.replace('"v":1','"v":1,"v":1'),p.sourceJson.replace('"name":"Chicken"','"name":"\\u0043hicken"')])expect(()=>parseStockReviewRequest({...p,sourceJson},false)).toThrow();
 const f=stockFixture(),created=saveStockItemCommand({...stockInput,name:'Literal '+String.fromCharCode(0xd800)},f,null,0,STOCK_AT),c=stockSaveIntent(created,null),good=packet(c,created);expect(parseStockReviewSource(good).events[0].after.item.name).toBe('Literal '+String.fromCharCode(0xd800));
 expect(()=>parseStockReviewRequest({...good,sourceJson:good.sourceJson.replaceAll('\\ud800',String.fromCharCode(0xd800))},false)).toThrow();
});
it('does not accept a coherent zero-valued relative movement as a retained native action',()=>{
 const {change,command}=setup(),p=packet(command,change),s=JSON.parse(p.sourceJson);if(command.type!=='stock.adjust')throw Error();
 const c={...command,change:{...command.change,quantity:0}},e=s.events[0];e.after.item.onHand=e.before.onHand;e.after.move.after=e.before.onHand;e.after.move.delta=0;
 expect(()=>parseStockReviewRequest({...p,command:c,sourceJson:JSON.stringify(s)},false)).toThrow();
});
it('extracts sources for actual native creates, metadata/count edits, relative movements, undo, archives and both batch kinds without changing the database',async()=>{
 const db=new MiseDatabase('mise-stock-review-source-'+randomUUID()),journal=new CloudUploadJournal('mise-stock-review-source-upload-'+randomUUID());databases.push(db,journal);const portable=cloudUploadFixture();await db.restoreBackup(portable,await db.previewRestore(portable));await beginLocalUpload(db,await journal.prepare(db,uploadId()),'a'.repeat(64));
 let item=await db.saveStockItem({...stockInput,name:'Native review rice',onHand:12.125});item=await db.saveStockItem({...stockInput,name:item.name,onHand:item.onHand,target:40},{id:item.id,revision:item.revision});item=await db.saveStockItem({...stockInput,name:item.name,onHand:11.005},{id:item.id,revision:item.revision});item=await db.adjustStock({id:item.id,revision:item.revision,reason:'used',quantity:0.125,source:'quick_update',note:literal});const used=(await db.stockMoves.where('stockItemId').equals(item.id).toArray()).find(m=>m.reason==='used')!;
 item=await db.undoStockMove(used.id,item.revision);item=await db.archiveStockItem(item.id,true,item.revision);item=await db.archiveStockItem(item.id,false,item.revision);[item]=await db.applyStockBatch([{id:item.id,revision:item.revision,reason:'received',quantity:0.125,note:literal}],false);await db.applyStockBatch([{id:item.id,revision:item.revision,reason:'count',quantity:0,note:literal}],true);
 const queue=await db.outbox.orderBy('[uploadId+sequence]').toArray(),saved=await nativeRowHash(queue),backup=backupToken(await db.readBackup()),types:string[]=[];
 for(const [i,entry] of queue.entries()){const p=await prepareStockReviewSource(entry,0,id(100000+i*2),id(100001+i*2));types.push(p.command.type);expect(parseStockReviewSource(p).events[0].id).toBe(p.command.id);}
 expect(types).toEqual(['stock.create','stock.update','stock.update','stock.adjust','stock.undo','stock.archive','stock.restore','stock.batch','stock.batch']);expect(await nativeRowHash(await db.outbox.orderBy('[uploadId+sequence]').toArray())).toBe(saved);expect(backupToken(await db.readBackup())).toBe(backup);
});
it('uses real per-action audits from one native transaction whose stock row was collapsed across two commands',async()=>{
 const db=new MiseDatabase('mise-stock-review-grouped-'+randomUUID()),journal=new CloudUploadJournal('mise-stock-review-grouped-upload-'+randomUUID());databases.push(db,journal);const portable=cloudUploadFixture();await db.restoreBackup(portable,await db.previewRestore(portable));await beginLocalUpload(db,await journal.prepare(db,uploadId()),'a'.repeat(64));
 await db.transaction('rw',db.tables,async()=>{const item=await db.saveStockItem({...stockInput,name:'Native grouped review rice',onHand:12.125});await db.adjustStock({id:item.id,revision:item.revision,reason:'received',quantity:1.125,note:literal});});
 const queue=await db.outbox.toArray();expect(queue).toHaveLength(1);const entry=queue[0];expect(entry.commands.map(c=>c.type)).toEqual(['stock.create','stock.adjust']);const itemChange=entry.changes.find(c=>c.table==='stockItems')!;expect(itemChange.before).toBeNull();expect(itemChange.after).toMatchObject({onHand:13.25,revision:2});
 const saved=await nativeRowHash(queue),first=await prepareStockReviewSource(entry,0,id(90000),id(90001)),firstFacts=parseStockReviewSource(first);expect(firstFacts.events[0]).toMatchObject({before:null,after:{item:{onHand:12.125,revision:1}}});
 const prefix=structuredClone(entry),c=first.command,plan=stockWritePlan(c);prefix.receipts=[{id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:c.occurredAt+1,batchId:plan.batchId,undoOf:plan.undoMoveId,results:plan.rows.map((p,i)=>({stockItemId:p.itemId,eventId:p.eventId,moveId:p.moveId,revision:p.revision+1,onHand:firstFacts.events[i].after.item.onHand,updatedAt:c.occurredAt+1}))}];
 const second=await prepareStockReviewSource(prefix,1,id(90002),id(90003));expect(parseStockReviewSource(second).events[0]).toMatchObject({before:{onHand:12.125,revision:1},after:{item:{onHand:13.25,revision:2}}});expect(second.sourceHash).toBe(first.sourceHash);expect(await nativeRowHash(await db.outbox.toArray())).toBe(saved);
});
