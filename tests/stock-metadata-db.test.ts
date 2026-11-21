import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {joinedApplyFixture,coverageFacts} from './sync-apply-fixture';
import {applyCanonicalDownload} from '../apps/web/src/data/cloud-sync-apply';
import {backupToken} from '../packages/core/backup';
import {backupTableNames,type BackupTable} from '../packages/core/backup-tables';
import {adjustStockCommand,archiveStockItemCommand,saveStockItemCommand,type StockChange,type StockContext} from '../packages/core/stock';
import {syncHash} from '../packages/core/sync-read';
import type {StockItem} from '../packages/core/models';
import type {MiseDatabase} from '../apps/web/src/data/db';
import {newInboxId} from '../packages/core/inbox';
import {stockAdjustmentIntent} from '../apps/web/src/data/outbox-intents';
import {stockReviewSourceAudits} from '../packages/core/stock-review-source';
import {stockResolutionEvent} from './stock-resolution-fixture';
import type {LocalStockReview} from '../packages/core/stock-review-journal';

const databases:MiseDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.delete();});
async function boot(){const f=await joinedApplyFixture();databases.push(f.db);return f;}
function input(item:StockItem,name=item.name){return {name,nameLocal:item.nameLocal,unit:item.unit,category:item.category,aliases:[...item.aliases],onHand:item.onHand,target:item.target,packSize:item.packSize,lowAt:item.lowAt,supplierId:item.supplierId};}
async function context(f:Awaited<ReturnType<typeof boot>>):Promise<StockContext>{return {setup:(await f.db.setup())!,items:await f.db.stockItems.toArray(),moves:await f.db.stockMoves.toArray(),suppliers:await f.db.suppliers.toArray()};}
function changes(value:StockChange):{table:BackupTable;row:unknown}[]{return [...value.items.map(row=>({table:'stockItems' as const,row})),...value.moves.map(row=>({table:'stockMoves' as const,row})),...value.events.map(row=>({table:'events' as const,row}))];}
async function images(db:MiseDatabase){return Promise.all((await db.inboxItems.toArray()).flatMap(row=>row.images.map(async image=>({id:image.id,size:image.size,type:image.type,sha256:await syncHash(new Uint8Array(await image.blob.arrayBuffer()))}))));}
async function apply(f:Awaited<ReturnType<typeof boot>>,updates:Parameters<typeof f.stage>[0]){const staged=await f.stage(updates);return applyCanonicalDownload(f.db,staged,{get:async source=>coverageFacts(source)},f.refresh);}

it.each(['received','count'] as const)('a pending metadata edit keeps the actual canonical %s quantity, count history, original queue and complete images',async reason=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!;
 await f.db.saveStockItem({...input(before,'Original local description · বাংলা'),aliases:['Saved literal\0\ud800']},{id:before.id,revision:before.revision});
 const queue=await f.db.outbox.toArray(),saved=await f.db.readBackup(),originalImages=await images(f.db),command=queue[0].commands[0];
 expect(command).toMatchObject({type:'stock.update',moveId:null,input:{onHand:before.onHand}});
 const remote=saveStockItemCommand(input(before,'Remote canonical description'),ctx,before,before.revision),remoteContext={...ctx,items:ctx.items.map(item=>item.id===before.id?remote.items[0]:item)},movement=adjustStockCommand({id:before.id,revision:remote.items[0].revision,reason,quantity:reason==='count'?before.onHand+3:3,source:reason==='count'?'count':'manual',note:'Actual canonical movement'},remoteContext);
 const current=movement.items[0],result=await apply(f,[...changes(movement),...remote.events.map(row=>({table:'events' as const,row}))]);
 expect(result).toMatchObject({pending:1,covered:0});expect(await f.db.outbox.toArray()).toEqual(queue);expect(await images(f.db)).toEqual(originalImages);
 const actual=(await f.db.stockItems.get(before.id))!,audit=(await f.db.events.get(command.id))!;
 expect(actual).toMatchObject({name:'Original local description · বাংলা',aliases:['Saved literal\0\ud800'],onHand:current.onHand,lastCountedAt:current.lastCountedAt,revision:current.revision+1,eventId:command.id});
 expect(audit.before).toEqual(current);expect(audit.after).toEqual({item:actual});expect(await f.db.stockMoves.count()).toBe(ctx.moves.length+1);
 const after=await f.db.readBackup();for(const table of backupTableNames)if(!['stockItems','stockMoves','events'].includes(table))expect(after.tables[table],table).toEqual(saved.tables[table]);
});

it('a pending description change preserves a canonical archive without creating a movement or restoring the item',async()=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!;
 await f.db.saveStockItem(input(before,'Original retained metadata'),{id:before.id,revision:before.revision});const queue=await f.db.outbox.toArray(),remote=archiveStockItemCommand(before,true,before.revision,ctx),result=await apply(f,changes(remote));
 expect(result.pending).toBe(1);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.stockItems.get(before.id)).toMatchObject({name:'Original retained metadata',onHand:before.onHand,archivedAt:remote.items[0].archivedAt,revision:remote.items[0].revision+1});expect((await f.db.stockItems.get(before.id))?.activeKey).toBeUndefined();expect(await f.db.stockMoves.count()).toBe(ctx.moves.length);
});

it.each([false,true])('a pending archive set replays its actual same-state canonical predecessor (restore: %s)',async restore=>{
 const f=await boot();let ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!;
 if(restore){await apply(f,changes(archiveStockItemCommand(before,true,before.revision,ctx)));ctx=await context(f);before=ctx.items.find(item=>item.id===before.id)!;}
 await f.db.archiveStockItem(before.id,!restore,before.revision);const queue=await f.db.outbox.toArray(),command=queue[0].commands[0],remote=archiveStockItemCommand(before,!restore,before.revision,ctx);await apply(f,changes(remote));
 const saved=(await f.db.stockItems.get(before.id))!,audit=(await f.db.events.get(command.id))!;expect(saved.archivedAt===undefined).toBe(restore);expect(saved.onHand).toBe(before.onHand);expect(saved.revision).toBe(remote.items[0].revision+1);expect(audit.before).toEqual(remote.items[0]);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.stockMoves.count()).toBe(ctx.moves.length);
});

it('a pending physical count remains a conflict after a canonical movement and retains every original domain row and cursor',async()=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!;
 await f.db.saveStockItem({...input(before),onHand:before.onHand+2},{id:before.id,revision:before.revision});
 const queue=await f.db.outbox.toArray(),saved=backupToken(await f.db.readBackup()),canonical=await f.db.syncCanonical.get('active'),remote=adjustStockCommand({id:before.id,revision:before.revision,reason:'received',quantity:3},ctx);
 await expect(apply(f,changes(remote))).rejects.toMatchObject({kind:'conflict'});expect(await f.db.outbox.toArray()).toEqual(queue);expect(backupToken(await f.db.readBackup())).toBe(saved);expect(await f.db.syncCanonical.get('active')).toEqual(canonical);expect(await f.db.syncApplications.count()).toBe(0);
});
async function withdrawal(ctx:StockContext,item:StockItem){const change=adjustStockCommand({id:item.id,revision:item.revision,reason:'count',quantity:item.onHand+1},ctx),command=stockAdjustmentIntent(change),p={id:newInboxId(),replacementId:newInboxId(),command,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,entryId:newInboxId(),sequence:1,commandIndex:0,at:command.occurredAt,events:stockReviewSourceAudits(command,change.events)})};return stockResolutionEvent(ctx,p);}
it('a canonical movement withdrawal blocks a coincidentally matching pending count and preserves every native row and cursor',async()=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!,event=await withdrawal(ctx,before);await f.db.saveStockItem({...input(before),onHand:before.onHand+2},{id:before.id,revision:before.revision});const queue=await f.db.outbox.toArray(),saved=backupToken(await f.db.readBackup()),canonical=await f.db.syncCanonical.get('active'),originalImages=await images(f.db);
 await expect(apply(f,[{table:'events',row:event}])).rejects.toMatchObject({kind:'conflict'});expect(await f.db.outbox.toArray()).toEqual(queue);expect(backupToken(await f.db.readBackup())).toBe(saved);expect(await f.db.syncCanonical.get('active')).toEqual(canonical);expect(await images(f.db)).toEqual(originalImages);expect(await f.db.syncApplications.count()).toBe(0);
});
it('a canonical movement withdrawal still allows a retained description while keeping quantities and original queue',async()=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!,event=await withdrawal(ctx,before);await f.db.saveStockItem(input(before,'Description remains usable'),{id:before.id,revision:before.revision});const queue=await f.db.outbox.toArray(),result=await apply(f,[{table:'events',row:event}]);expect(result.pending).toBe(1);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.stockItems.get(before.id)).toMatchObject({name:'Description remains usable',onHand:before.onHand,lastCountedAt:before.lastCountedAt});
});
it('the finite canonical writer rejects an unexpected stock journal write and rolls every native change back',async()=>{
 const f=await boot(),ctx=await context(f),before=ctx.items.find(item=>item.archivedAt===undefined)!,remote=adjustStockCommand({id:before.id,revision:before.revision,reason:'received',quantity:1},ctx),saved=backupToken(await f.db.readBackup()),canonical=await f.db.syncCanonical.get('active'),queue=await f.db.outbox.toArray();let attempted=false;
 const mutate=()=>{attempted=true;void f.db.stockReviews.put({id:'a'.repeat(64),marker:'unexpected native write'} as unknown as LocalStockReview).catch(()=>{});};f.db.stockItems.hook('creating',mutate);
 try{await expect(apply(f,changes(remote))).rejects.toThrow();expect(attempted).toBe(true);expect(backupToken(await f.db.readBackup())).toBe(saved);expect(await f.db.syncCanonical.get('active')).toEqual(canonical);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.stockReviews.count()).toBe(0);}finally{f.db.stockItems.hook('creating').unsubscribe(mutate);}
});
