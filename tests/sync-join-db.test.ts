import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {joinCanonicalDevice} from '../apps/web/src/data/cloud-sync-join';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {selectCloudOperator,lockLocalOperator} from '../apps/web/src/data/operator-state';
import {deliverLocalOutbox,beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {syncImagesFixture} from './sync-images-fixture';
import {backupToken} from '../packages/core/backup';
import {parseSyncScope} from '../packages/core/sync-read';
import {parseLocalCloudState,localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import {canonicalSnapshotHash} from '../packages/core/sync-canonical';
import {newInboxId} from '../packages/core/inbox';
import type {OperatorContext} from '../packages/core/operators';
import {cloudUploadFixture} from './cloud-upload-fixture';

const databases:Dexie[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(){
 const fixture=await syncImagesFixture(),db=new MiseDatabase('mise-join-'+newInboxId());databases.push(db);await db.open();
 const context:OperatorContext={...parseSyncScope(fixture.window),version:1,businessName:null,outletName:null,actorName:null},authKey='mise.cloud.auth.'+'c'.repeat(64),refresh=vi.fn(async()=>structuredClone(context));
 const operator=await selectCloudOperator(db,context,{authKey,targetHash:fixture.target.targetHash},null,refresh);
 await prepareSyncDownload(db,{id:fixture.window.id,target:fixture.target,previousCursor:null});await runSyncDownload(db,fixture.window.id,fixture.target,{begin:async()=>fixture.window,page:async(_w,i)=>fixture.pages[i]});
 await downloadSyncImages(db,fixture.window.id,fixture.target,{get:async source=>new Blob([new Uint8Array(fixture.imageBytes).buffer],{type:source.image.type})});
 const input={readId:fixture.window.id,target:fixture.target,authKey,expectedOperatorRevision:operator.revision};return {...fixture,db,input,context,refresh};
}
it('atomically joins a real empty IndexedDB with original images, a canonical base and no upload receipt or echo',async()=>{
 const f=await boot(),result=await joinCanonicalDevice(f.db,f.input,f.refresh),binding=parseLocalCloudState(await f.db.cloudState.get('binding')),base=(await f.db.syncCanonical.get('active'))!;
 expect(binding).toMatchObject({version:2,phase:'ready',sequence:0,receipt:null,ownerId:f.target.actorId,join:{kind:'join',readId:f.window.id,cursor:'synthetic-received-cursor'}});expect(result.canonicalHash).toBe(await canonicalSnapshotHash(base.snapshot));expect(backupToken(await f.db.readBackup())).toBe(backupToken(f.backup));expect(await f.db.outbox.count()).toBe(0);expect((await f.db.setup())?.owner.id).toBe(f.target.actorId);expect(f.db.verno).toBe(localSchemaVersion);expect(f.db.tables).toHaveLength(localTableNames.length);expect(JSON.stringify(base)).not.toMatch(/apiUrl|publishableKey|auth_user_id|Authorization|mise\.cloud\.auth/);
 await f.db.recordSale({expression:'37',method:'cash'});const queued=await f.db.outbox.toArray();expect(queued).toHaveLength(1);expect(queued[0]).toMatchObject({status:'pending',sequence:1,receipts:[]});expect(queued[0].commands).toHaveLength(1);expect(queued[0].changes.some(c=>c.table==='sales'&&(c.after as {amount:number})?.amount===3700)).toBe(true);
});
it('a lost join response replays its admission after reopen without overwriting subsequent offline cash or original queue',async()=>{
 const f=await boot(),first=await joinCanonicalDevice(f.db,f.input,f.refresh);await f.db.recordSale({expression:'19',method:'cash'});const before=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray();f.db.close();await f.db.open();expect(await joinCanonicalDevice(f.db,f.input,f.refresh)).toEqual(first);expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.toArray()).toEqual(queue);expect((await f.db.cloudState.get('binding'))?.sequence).toBe(1);
});
it('canonical quota failure rolls back domain rows, operator activation, fence and cursor while preserving complete staging',async()=>{
 const f=await boot(),original=await f.db.operatorState.toArray(),reads=await f.db.syncReads.toArray(),reject=()=>{throw new DOMException('Storage is full','QuotaExceededError');};f.db.syncCanonical.hook('creating',reject);
 try{await expect(joinCanonicalDevice(f.db,f.input,f.refresh)).rejects.toThrow();}finally{f.db.syncCanonical.hook('creating').unsubscribe(reject);}
 expect(await f.db.businesses.count()).toBe(0);expect(await f.db.events.count()).toBe(0);expect(await f.db.inboxItems.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);expect(await f.db.syncCanonical.count()).toBe(0);expect(await f.db.operatorState.toArray()).toEqual(original);expect(await f.db.syncReads.toArray()).toEqual(reads);expect(await f.db.syncImages.count()).toBe(2);await joinCanonicalDevice(f.db,f.input,f.refresh);
});
it.each(['accountHash','actorId','epoch','scopeVersion','role'] as const)('fresh %s changes refuse all join writes',async field=>{
 const f=await boot(),changed={...f.context,[field]:field==='role'?'manager':field==='actorId'?newInboxId():field==='accountHash'?'d'.repeat(64):'00000000-0000-4000-8000-000000000099'};
 await expect(joinCanonicalDevice(f.db,f.input,async()=>changed)).rejects.toThrow();expect(await f.db.businesses.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);expect((await f.db.operatorState.get('active'))?.phase).toBe('pending');
});
it('a local share arriving during the fresh access check is retained beside canonical original images',async()=>{
 const f=await boot();let localId='';await joinCanonicalDevice(f.db,f.input,async()=>{localId=(await f.db.captureInbox({text:'Keep this unsorted local list'})).id;return f.context;});expect((await f.db.inboxItems.get(localId))?.outletId).toBeNull();expect(await f.db.inboxItems.count()).toBe(f.backup.tables.inboxItems.length+1);expect(await f.db.outbox.count()).toBe(0);
});
it('a concurrent operator lock aborts join and never unlocks the cached selection',async()=>{
 const f=await boot();await expect(joinCanonicalDevice(f.db,f.input,async()=>{await lockLocalOperator(f.db,f.input.expectedOperatorRevision);return f.context;})).rejects.toThrow();expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');expect(await f.db.businesses.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);
});
it('two independent database connections commit one join and can recover the competing exact retry',async()=>{
 const f=await boot(),other=new MiseDatabase(f.db.name);databases.push(other);await other.open();const results=await Promise.allSettled([joinCanonicalDevice(f.db,f.input,f.refresh),joinCanonicalDevice(other,f.input,f.refresh)]);expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(await f.db.syncCanonical.count()).toBe(1);expect(await f.db.outbox.count()).toBe(0);expect(await joinCanonicalDevice(other,f.input,f.refresh)).toMatchObject({readId:f.window.id});expect(backupToken(await f.db.readBackup())).toBe(backupToken(f.backup));other.close();databases.splice(databases.indexOf(other),1);
});
it('a nonempty local shop is preserved rather than replaced by a remote join',async()=>{
 const f=await boot();await f.db.businesses.add(cloudUploadFixture().tables.businesses[0]);const before=await f.db.businesses.toArray();await expect(joinCanonicalDevice(f.db,f.input,f.refresh)).rejects.toThrow();expect(await f.db.businesses.toArray()).toEqual(before);expect(await f.db.syncCanonical.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);
});
it('locked admission replay and a damaged canonical journal cannot replace or unlock local work',async()=>{
 const f=await boot(),result=await joinCanonicalDevice(f.db,f.input,f.refresh);await lockLocalOperator(f.db,result.operatorRevision);await expect(joinCanonicalDevice(f.db,f.input,f.refresh)).rejects.toThrow();expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');const base=(await f.db.syncCanonical.get('active'))!;await f.db.syncCanonical.put({...base,hash:'f'.repeat(64)});await expect(joinCanonicalDevice(f.db,f.input,f.refresh)).rejects.toThrow();expect((await f.db.syncCanonical.get('active'))?.hash).toBe('f'.repeat(64));
});
it('joined devices deliver genuine typed offline commands without an invented owner-upload receipt',async()=>{
 const f=await boot();await joinCanonicalDevice(f.db,f.input,f.refresh);await f.db.recordSale({expression:'9',method:'cash'});const send=vi.fn(async()=>{throw new Error('Network unavailable');});await expect(deliverLocalOutbox(f.db,f.target.targetHash,send)).rejects.toThrow('Network unavailable');expect(send).toHaveBeenCalledOnce();expect((await f.db.outbox.toArray())[0].receipts).toEqual([]);
 // An upload plan can never reinterpret this joined admission as its receipt.
 await expect(beginLocalUpload(f.db,{manifest:{id:f.window.id}} as never,f.target.targetHash)).rejects.toThrow();expect((await f.db.cloudState.get('binding'))?.receipt).toBeNull();
});
it('a joined operator lock stops network delivery while preserving the original queued command',async()=>{
 const f=await boot(),joined=await joinCanonicalDevice(f.db,f.input,f.refresh);await f.db.recordSale({expression:'8',method:'cash'});const queue=await f.db.outbox.toArray();await lockLocalOperator(f.db,joined.operatorRevision);const send=vi.fn(async()=>{throw Error('Must not send');});await expect(deliverLocalOutbox(f.db,f.target.targetHash,send)).rejects.toThrow(/joined operator/);expect(send).not.toHaveBeenCalled();expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('schema 15 upgrades staged original images and pending operator without inventing a join',async()=>{
 const f=await boot(),name='mise-join-legacy-'+newInboxId(),old=new Dexie(name);databases.push(old);old.version(15).stores(Object.fromEntries(f.db.tables.filter(t=>t.name!=='scopeRecoveries'&&t.name!=='syncCanonical'&&t.name!=='syncApplications'&&t.name!=='syncAdmissions'&&t.name!=='syncSessions'&&t.name!=='joinSessions').map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(const table of old.tables)await old.table(table.name).bulkPut(await f.db.table(table.name).toArray());old.close();const upgraded=new MiseDatabase(name);databases.push(upgraded);expect(await upgraded.syncCanonical.count()).toBe(0);expect(await upgraded.cloudState.count()).toBe(0);expect(await upgraded.operatorState.toArray()).toEqual(await f.db.operatorState.toArray());expect(await upgraded.syncImages.count()).toBe(2);await joinCanonicalDevice(upgraded,f.input,f.refresh);expect(backupToken(await upgraded.readBackup())).toBe(backupToken(f.backup));old.close();databases.splice(databases.indexOf(old),1);
});
it('an unexpected domain write from a native hook aborts every join write instead of escaping capture',async()=>{
 const f=await boot(),unexpected={...f.backup.tables.items[0],id:newInboxId(),name:'Unexpected local item'};let mutation:Promise<unknown>|undefined;
 const inject=()=>{mutation=f.db.items.add(unexpected);};f.db.cloudState.hook('creating',inject);
 try{await expect(joinCanonicalDevice(f.db,f.input,f.refresh)).rejects.toThrow();await mutation;}finally{f.db.cloudState.hook('creating').unsubscribe(inject);}
 expect(await f.db.businesses.count()).toBe(0);expect(await f.db.items.count()).toBe(0);expect(await f.db.syncCanonical.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);expect((await f.db.operatorState.get('active'))?.phase).toBe('pending');expect(await f.db.syncImages.count()).toBe(2);
});
