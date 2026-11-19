import {localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import Dexie from 'dexie';
import {MiseDatabase} from '../apps/web/src/data/db';
import {LocalStore} from '../apps/web/src/data/local-store';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages,readVerifiedSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {SyncImageError,type SyncImageSource} from '../packages/core/sync-images';
import {backupToken} from '../packages/core/backup';
import {selectLocalOperator} from '../apps/web/src/data/operator-state';
import {MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {syncImagesFixture,rewriteImagePart} from './sync-images-fixture';

const databases:Dexie[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(options:{empty?:boolean;armed?:boolean;selected?:boolean;size?:number;fixture?:Awaited<ReturnType<typeof syncImagesFixture>>;previousCursor?:string|null}={}){
 const f=options.fixture??await syncImagesFixture({size:options.size}),db=new MiseDatabase('mise-sync-images-'+randomUUID());databases.push(db);
 if(!options.empty)await db.restoreBackup(f.backup,await db.previewRestore(f.backup));else await db.open();
 if(options.selected){const setup=(await db.setup())!;await selectLocalOperator(db,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id},null);}
 if(options.armed){const journal=new CloudUploadJournal('mise-sync-images-upload-'+randomUUID());databases.push(journal);const snapshot=await journal.prepare(db,uploadId());await beginLocalUpload(db,snapshot,f.target.targetHash);await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,f.target.targetHash,new MemoryCloudUpload());}
 const request=await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:options.previousCursor??null});await runSyncDownload(db,request.id,f.target,{begin:async()=>f.window,page:async(_w,index)=>f.pages[index]});
 const get=vi.fn(async(source:SyncImageSource)=>new Blob([new Uint8Array(f.imageBytes).buffer],{type:source.image.type}));
 return {...f,db,request,get};
}
it('stages exact original images without changing shop records, the outbox, the cursor or portable tables',async()=>{
 const f=await boot(),before=backupToken(await f.db.readBackup()),read=await f.db.syncReads.get(f.request.id),result=await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get});
 expect(result.images).toHaveLength(2);expect(result.bytes).toBe(f.imageBytes.length*2);for(const image of result.images){expect(new Uint8Array(await image.blob.arrayBuffer())).toEqual(f.imageBytes);expect(image.source.target).toEqual(f.target);expect(image.source.readSeal).toBe(read?.seal);}
 expect(await f.db.syncReads.get(f.request.id)).toEqual(read);expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);expect(Object.keys((await f.db.readBackup()).tables)).toHaveLength(21);expect(f.db.verno).toBe(localSchemaVersion);expect(f.db.tables).toHaveLength(localTableNames.length);
 const names=(await f.db.syncRecords.where('readId').equals(f.request.id).toArray()).filter(r=>r.meta.table==='inbox_images').map(r=>r.row!.name);expect(names.every(n=>typeof n==='string'&&n.includes('\0\ud800'))).toBe(true);
});
it('retains the first verified image after interruption and resumes only the missing image after reload',async()=>{
 const f=await boot();let calls=0;const get=vi.fn(async(source:SyncImageSource)=>{if(++calls===2)throw new SyncImageError('retry');return f.get(source);});await expect(downloadSyncImages(f.db,f.request.id,f.target,{get})).rejects.toMatchObject({kind:'retry'});expect(await f.db.syncImages.count()).toBe(1);f.db.close();await f.db.open();const result=await downloadSyncImages(f.db,f.request.id,f.target,{get});expect(result.images).toHaveLength(2);expect(calls).toBe(3);expect((await readVerifiedSyncImages(f.db,f.request.id,f.target)).hash).toBe(result.hash);
});
it('reads cached originals offline without another network call and keeps Blob hashes bound to the original source',async()=>{
 const f=await boot(),first=await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get});const second=await readVerifiedSyncImages(f.db,f.request.id,f.target);expect(second.hash).toBe(first.hash);expect(f.get).toHaveBeenCalledTimes(2);expect(second.images.map(i=>i.sourceHash)).toEqual(first.images.map(i=>i.sourceHash));
});
it('deduplicates native concurrent writes from separate database connections',async()=>{
 const f=await boot(),other=new LocalStore(f.db.name);try{const [a,b]=await Promise.all([downloadSyncImages(f.db,f.request.id,f.target,{get:f.get}),downloadSyncImages(other,f.request.id,f.target,{get:f.get})]);expect(a.hash).toBe(b.hash);expect(await f.db.syncImages.count()).toBe(2);expect(a.images.map(i=>i.sourceHash)).toEqual(b.images.map(i=>i.sourceHash));}finally{other.close();}
});
it('rolls back a quota failure without changing the original request, pages, records, images or queue',async()=>{
 const f=await boot(),before=backupToken(await f.db.readBackup()),read=await f.db.syncReads.toArray(),pages=await f.db.syncPages.toArray(),records=await f.db.syncRecords.toArray(),fail=()=>{throw new DOMException('Quota','QuotaExceededError');};f.db.syncImages.hook('creating',fail);try{await expect(downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).rejects.toThrow();}finally{f.db.syncImages.hook('creating').unsubscribe(fail);}expect(await f.db.syncImages.count()).toBe(0);expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.syncReads.toArray()).toEqual(read);expect(await f.db.syncPages.toArray()).toEqual(pages);expect(await f.db.syncRecords.toArray()).toEqual(records);expect((await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).images).toHaveLength(2);
});
it('independently verifies a raw transport Blob before committing it',async()=>{
 const f=await boot(),changed=new Uint8Array(f.imageBytes);changed[changed.length-1]^=1;await expect(downloadSyncImages(f.db,f.request.id,f.target,{get:async()=>new Blob([changed],{type:'image/png'})})).rejects.toMatchObject({kind:'integrity'});expect(await f.db.syncImages.count()).toBe(0);
});
it('retains damaged cached bytes for recovery instead of silently replacing them',async()=>{
 const f=await boot(),result=await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get}),row=result.images[0],bad=new Uint8Array(f.imageBytes);bad[bad.length-1]^=1;await f.db.syncImages.put({...row,blob:new Blob([bad],{type:'image/png'})});const calls=f.get.mock.calls.length;await expect(downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).rejects.toMatchObject({kind:'integrity'});expect(f.get).toHaveBeenCalledTimes(calls);expect(new Uint8Array(await(await f.db.syncImages.get([row.readId,row.imageId]))!.blob.arrayBuffer())).toEqual(bad);
});
it('rejects a foreign cached source hash without reusing its bytes',async()=>{
 const f=await boot(),result=await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get}),row=result.images[0];await f.db.syncImages.put({...row,sourceHash:'d'.repeat(64)});await expect(readVerifiedSyncImages(f.db,f.request.id,f.target)).rejects.toMatchObject({kind:'integrity'});
});
it('keeps a real local cash intent and receipt fence unchanged while original images arrive',async()=>{
 const f=await boot({armed:true});let saved=false;const get=async(source:SyncImageSource)=>{if(!saved){saved=true;await f.db.recordSale({expression:'5',method:'cash'});}return f.get(source);};const result=await downloadSyncImages(f.db,f.request.id,f.target,{get});expect(result.images).toHaveLength(2);expect((await f.db.cloudState.get('binding'))?.sequence).toBe(1);expect((await f.db.cloudState.get('binding'))?.receipt).toBeTruthy();const queue=await f.db.outbox.toArray();expect(queue).toHaveLength(1);expect(queue[0].commands[0].type).toBe('sale.record');expect(queue[0].receipts).toEqual([]);expect((await f.db.sales.toArray()).some(s=>s.expression==='5')).toBe(true);
});
it('refuses a connection changed during download before adding any cache entry',async()=>{
 const f=await boot({armed:true});const get=async(source:SyncImageSource)=>{await f.db.cloudState.update('binding',{targetHash:'d'.repeat(64)});return f.get(source);};await expect(downloadSyncImages(f.db,f.request.id,f.target,{get})).rejects.toThrow();expect(await f.db.syncImages.count()).toBe(0);expect((await f.db.syncReads.get(f.request.id))?.receivedCursor).toBe(f.pages.at(-1)!.cursor);
});
it('refuses source records changed while their bytes are in flight',async()=>{
 const f=await boot(),get=async(source:SyncImageSource)=>{const row=(await f.db.syncRecords.get([f.request.id,source.changeId]))!;await f.db.syncRecords.put({...row,row:{...row.row,name:'Changed source'}});return f.get(source);};await expect(downloadSyncImages(f.db,f.request.id,f.target,{get})).rejects.toThrow();expect(await f.db.syncImages.count()).toBe(0);
});
it('does not cache a response after explicit cancellation',async()=>{
 const f=await boot(),controller=new AbortController(),get=async(source:SyncImageSource)=>{controller.abort();return f.get(source);};await expect(downloadSyncImages(f.db,f.request.id,f.target,{get},controller.signal)).rejects.toMatchObject({kind:'retry'});expect(await f.db.syncImages.count()).toBe(0);
});
it('does not accept incomplete metadata or invent original image bytes on an empty device',async()=>{
 const fixture=await syncImagesFixture(),db=new MiseDatabase('mise-sync-images-empty-'+randomUUID());databases.push(db);const request=await prepareSyncDownload(db,{id:fixture.window.id,target:fixture.target,previousCursor:null}),get=vi.fn(async()=>new Blob());await expect(downloadSyncImages(db,request.id,fixture.target,{get})).rejects.toThrow();expect(get).not.toHaveBeenCalled();expect(await db.businesses.count()).toBe(0);expect(await db.members.count()).toBe(0);
 const f=await boot({empty:true});await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get});expect(await f.db.inboxItems.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);expect(await f.db.operatorState.count()).toBe(0);expect(await f.db.syncImages.count()).toBe(2);
});
it('rejects a bootstrap with orphan images or duplicate image positions before fetching bytes',async()=>{
 for(const bad of ['orphan','duplicate']as const){const fixture=await syncImagesFixture();if(bad==='orphan')for(const page of fixture.pages)page.parts=page.parts.filter(p=>p.table!=='inbox_items');else await rewriteImagePart(fixture,row=>({...row,position:0}));const f=await boot({fixture});await expect(downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).rejects.toMatchObject({kind:'review'});expect(f.get).not.toHaveBeenCalled();}
});
it('accepts an incremental image update without demanding an unchanged parent or position zero',async()=>{
 const fixture=await syncImagesFixture();for(const page of fixture.pages)page.parts=page.parts.filter(p=>p.table==='inbox_images'&&JSON.parse(atob(p.data)).position===1);const f=await boot({fixture,previousCursor:'synthetic-accepted-cursor'});expect((await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).images).toHaveLength(1);expect(f.get).toHaveBeenCalledTimes(1);
});
it('does not fetch bytes for a deleted image',async()=>{
 const fixture=await syncImagesFixture();await rewriteImagePart(fixture,()=>null);const f=await boot({fixture});expect((await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get})).images).toEqual([]);expect(f.get).not.toHaveBeenCalled();
});
it('preserves original full-size image tails instead of accepting a header-only duplicate',async()=>{
 const f=await boot({size:5242880}),result=await downloadSyncImages(f.db,f.request.id,f.target,{get:f.get});expect(result.bytes).toBe(10485760);expect(result.images.every(i=>i.blob.size===5242880)).toBe(true);const changed=new Uint8Array(f.imageBytes);changed[changed.length-1]=1;const old=result.images[0];await f.db.syncImages.put({...old,blob:new Blob([changed],{type:'image/png'})});await expect(readVerifiedSyncImages(f.db,f.request.id,f.target)).rejects.toMatchObject({kind:'integrity'});
},60000); // Includes complete 10 MB portable-source validation, not an app latency assertion.
it('upgrades an actual schema-13 database without changing its operator, original image, upload receipt, cash queue or download pages',async()=>{
 const f=await boot({armed:true,selected:true}),setup=(await f.db.setup())!;await f.db.recordSale({expression:'5',method:'cash'});expect((await f.db.cloudState.get('binding'))?.receipt).toBeTruthy();expect(await f.db.outbox.count()).toBe(1);const before=backupToken(await f.db.readBackup()),selection=await f.db.operatorState.toArray(),name='mise-sync-images-upgrade-'+randomUUID(),legacy=new Dexie(name);legacy.version(13).stores(Object.fromEntries(f.db.tables.filter(t=>!['syncImages','syncCoverage','syncCanonical','syncApplications','syncAdmissions','syncSessions','joinSessions'].includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(const t of legacy.tables)await legacy.table(t.name).bulkPut(await f.db.table(t.name).toArray());legacy.close();const upgraded=new MiseDatabase(name);databases.push(upgraded);
 expect(backupToken(await upgraded.readBackup())).toBe(before);expect(await upgraded.operatorState.toArray()).toEqual(selection);for(const table of ['syncReads','syncPages','syncRecords','cloudState','outbox'])expect(await upgraded.table(table).toArray()).toEqual(await f.db.table(table).toArray());expect(await upgraded.syncImages.count()).toBe(0);expect(upgraded.verno).toBe(localSchemaVersion);expect((await upgraded.setup())?.owner.id).toBe(setup.owner.id);
},15000);
