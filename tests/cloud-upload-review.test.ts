import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import Dexie from 'dexie';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox,type LocalUploadReview} from '../apps/web/src/data/cloud-upload';
import {assertLocalUploadCoverage,beginLocalUpload,cancelLocalUpload} from '../apps/web/src/data/local-outbox';
import {prepareCloudUpload,readCloudUpload} from '../packages/core/cloud-upload';
import {backupToken} from '../packages/core/backup';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';

const databases:(MiseDatabase|CloudUploadJournal)[]=[],target='a'.repeat(64);
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(records?:number){
 const db=new MiseDatabase('mise-review-shop-'+randomUUID()),journal=new CloudUploadJournal('mise-review-cache-'+randomUUID());databases.push(db,journal);
 const backup=cloudUploadFixture(records);await db.restoreBackup(backup,await db.previewRestore(backup));const snapshot=await journal.prepare(db,uploadId());return {db,journal,snapshot};
}
async function edit(db:MiseDatabase){await db.recordSale({expression:'5',method:'cash'});}

it('refreshing an unarmed review retains the complete original snapshot and selects the new review after a backwards clock and reload',async()=>{
 const {db,journal,snapshot}=await boot();await edit(db);vi.spyOn(Date,'now').mockReturnValue(snapshot.manifest.exportedAt-1000);const next=await journal.prepare(db,uploadId(2));expect(next.manifest.exportedAt).toBeLessThan(snapshot.manifest.exportedAt);expect(await journal.uploads.count()).toBe(2);expect(backupToken(await readCloudUpload(await journal.readSnapshot(snapshot.id)))).not.toBe(backupToken(await db.readBackup()));
 journal.close();const reopened=new CloudUploadJournal(journal.name);databases.push(reopened);expect((await reopened.review(db)).snapshot?.id).toBe(next.id);expect((await reopened.review(db)).phase).toBe('review');
});
it('an armed review with no first acknowledgement cannot be replaced or removed by refreshing counts',async()=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);await edit(db);const before=backupToken(await db.readBackup()),original=await snapshot.chunks[0].arrayBuffer();expect((await journal.readSnapshot(snapshot.id)).progress).toBeNull();
 expect((await journal.prepare(db,uploadId(2))).id).toBe(snapshot.id);expect(await journal.uploads.count()).toBe(1);expect((await journal.review(db)).phase).toBe('uploading');expect(await (await journal.readSnapshot(snapshot.id)).chunks[0].arrayBuffer()).toEqual(original);expect(backupToken(await db.readBackup())).toBe(before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('a newer unbound snapshot never shadows the armed original, including after journal restart',async()=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);await edit(db);const other=await journal.addSnapshot(await prepareCloudUpload(await db.readBackup(),uploadId(2)));expect(other.manifest.records).toBeGreaterThan(snapshot.manifest.records);journal.close();const reopened=new CloudUploadJournal(journal.name);databases.push(reopened);
 expect((await reopened.review(db)).snapshot?.id).toBe(snapshot.id);expect((await reopened.prepare(db,uploadId(3))).id).toBe(snapshot.id);expect(await reopened.uploads.count()).toBe(2);await assertLocalUploadCoverage(db,snapshot,target);
});
it('arming in another tab during review preparation preserves both snapshots and returns the original armed review',async()=>{
 const {db,journal,snapshot}=await boot(),save=journal.addSnapshot.bind(journal);const other=new MiseDatabase(db.name);databases.push(other);
 vi.spyOn(journal,'addSnapshot').mockImplementation(async plan=>{await beginLocalUpload(other,snapshot,target);return save(plan);});
 expect((await journal.prepare(db,uploadId(2))).id).toBe(snapshot.id);expect(await journal.uploads.count()).toBe(2);await edit(db);await assertLocalUploadCoverage(db,snapshot,target);
});
it('a lost begin response keeps the original zero-progress snapshot resumable through refresh and restart',async()=>{
 const {db,journal,snapshot}=await boot(),remote=new MemoryCloudUpload(),begin=remote.begin.bind(remote);let lose=true;
 remote.begin=async(...args)=>{const result=await begin(...args);if(lose){lose=false;throw Error('Lost begin response');}return result;};
 await expect(uploadWithLocalOutbox(db,journal,snapshot.id,target,remote)).rejects.toThrow('Lost begin');await edit(db);expect((await journal.prepare(db,uploadId(2))).id).toBe(snapshot.id);journal.close();const reopened=new CloudUploadJournal(journal.name);databases.push(reopened);
 const receipt=await uploadWithLocalOutbox(db,reopened,snapshot.id,target,remote);expect(remote.commits).toBe(1);expect((await reopened.review(db))).toMatchObject({phase:'ready',snapshot:{id:snapshot.id,progress:{receipt}}});await assertLocalUploadCoverage(db,snapshot,target);
});
it('a lost finish response cannot turn an accepted source into a fresh review or lose the later queue',async()=>{
 const {db,journal,snapshot}=await boot(),remote=new MemoryCloudUpload();remote.loseCommitReply=true;
 await expect(uploadWithLocalOutbox(db,journal,snapshot.id,target,remote)).rejects.toThrow('Connection lost');await edit(db);expect((await journal.prepare(db,uploadId(2))).id).toBe(snapshot.id);expect((await journal.review(db)).phase).toBe('uploading');expect((await journal.readSnapshot(snapshot.id)).progress?.receipt).toBeNull();
 await uploadWithLocalOutbox(db,journal,snapshot.id,target,remote);expect(remote.commits).toBe(1);expect(await db.outbox.count()).toBe(1);expect((await journal.prepare(db,uploadId(3))).id).toBe(snapshot.id);await assertLocalUploadCoverage(db,snapshot,target);
});
it('a missing bound snapshot fails closed instead of selecting a newer snapshot or creating a replacement',async()=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);await edit(db);await journal.addSnapshot(await prepareCloudUpload(await db.readBackup(),uploadId(2)));await journal.uploads.delete(snapshot.id);const before=backupToken(await db.readBackup());
 await expect(journal.review(db)).rejects.toThrow('unavailable');await expect(journal.prepare(db,uploadId(3))).rejects.toThrow('unavailable');expect(await journal.uploads.count()).toBe(1);expect((await db.cloudState.get('binding'))?.uploadId).toBe(snapshot.id);expect(await db.outbox.count()).toBe(1);expect(backupToken(await db.readBackup())).toBe(before);
});
it.each(['manifest','bytes'] as const)('a damaged bound %s blocks refreshing without changing the shop or queue',async kind=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);await edit(db);const before=backupToken(await db.readBackup());
 await journal.uploads.update(snapshot.id,kind==='manifest'?{manifestHash:'0'.repeat(64)}:{chunks:[new Blob([new Uint8Array(snapshot.chunks[0].size)])]});
 await expect(journal.prepare(db,uploadId(2))).rejects.toThrow();expect(await journal.uploads.count()).toBe(1);expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(1);
});
it.each(['businessId','outletId','ownerId','manifestHash'] as const)('a mismatched %s cannot select a different upload review',async field=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);const state=(await db.cloudState.get('binding'))!;await db.cloudState.put({...state,[field]:field==='manifestHash'?'0'.repeat(64):uploadId(999)});
 await expect(journal.review(db)).rejects.toThrow('recovery');await expect(journal.prepare(db,uploadId(2))).rejects.toThrow('recovery');expect(await journal.uploads.count()).toBe(1);
});
it('a ready binding must retain the matching accepted journal receipt before its counts are shown',async()=>{
 const {db,journal,snapshot}=await boot();await uploadWithLocalOutbox(db,journal,snapshot.id,target,new MemoryCloudUpload());const current=await journal.readSnapshot(snapshot.id);await journal.uploads.update(snapshot.id,{progress:{...current.progress!,receipt:null}});
 await expect(journal.prepare(db,uploadId(2))).rejects.toThrow('recovery');expect((await db.cloudState.get('binding'))?.phase).toBe('ready');expect(await journal.uploads.count()).toBe(1);
});
it('server-confirmed cancellation permits a fresh review without deleting the cancelled source or its recovery queue',async()=>{
 const {db,journal,snapshot}=await boot();await beginLocalUpload(db,snapshot,target);await edit(db);await cancelLocalUpload(db,snapshot.id,target,{cancel:async id=>({id,canceled:true})});expect(await journal.review(db)).toEqual({snapshot:null,phase:'review'});
 const next=await journal.prepare(db,uploadId(2));expect(next.id).toBe(uploadId(2));expect(await journal.uploads.count()).toBe(2);expect(await db.outbox.count()).toBe(1);expect((await journal.review(db)).snapshot?.id).toBe(next.id);await beginLocalUpload(db,next,target);await edit(db);await assertLocalUploadCoverage(db,next,target);
});
it('snapshot and selected-review writes roll back together when saving the selection fails',async()=>{
 const {db,journal,snapshot}=await boot();vi.spyOn(journal.reviews,'put').mockRejectedValue(new DOMException('Quota exceeded','QuotaExceededError'));
 await expect(journal.prepare(db,uploadId(2))).rejects.toMatchObject({name:'QuotaExceededError'});expect(await journal.uploads.count()).toBe(1);expect((await journal.review(db)).snapshot?.id).toBe(snapshot.id);
});
it('upgrading a version-one journal retains its original Blob snapshot and supports a new explicit selection',async()=>{
 const {db,snapshot}=await boot(),name='mise-review-legacy-'+randomUUID(),legacy=new Dexie(name);legacy.version(1).stores({uploads:'id,businessId'});await legacy.table('uploads').add(snapshot);legacy.close();
 const upgraded=new CloudUploadJournal(name);databases.push(upgraded);expect((await upgraded.review(db)).snapshot?.id).toBe(snapshot.id);expect((await upgraded.readSnapshot(snapshot.id)).chunks[0]).toBeInstanceOf(Blob);expect(backupToken(await readCloudUpload(await upgraded.readSnapshot(snapshot.id)))).toBe(backupToken(await db.readBackup()));
 const next=await upgraded.prepare(db,uploadId(2));expect(upgraded.verno).toBe(2);expect((await upgraded.review(db)).snapshot?.id).toBe(next.id);expect(await upgraded.uploads.count()).toBe(2);
});
it('an explicit selected review that went missing cannot silently fall back to a different snapshot',async()=>{
 const {db,journal,snapshot}=await boot();await journal.reviews.put({id:[snapshot.manifest.businessId,snapshot.manifest.outletId,snapshot.manifest.ownerId].join('/'),uploadId:uploadId(404)});
 await expect(journal.prepare(db,uploadId(2))).rejects.toThrow('unavailable');expect(await journal.uploads.count()).toBe(1);expect(await journal.readSnapshot(snapshot.id)).toMatchObject({id:snapshot.id});
});
it('progress without its local boundary requires recovery rather than implicitly uploading a new snapshot',async()=>{
 const {db,journal,snapshot}=await boot();await journal.acknowledge(snapshot.id,{id:snapshot.id,manifestHash:snapshot.manifestHash,received:[],receipt:null});await edit(db);
 await expect(journal.prepare(db,uploadId(2))).rejects.toThrow('recovery');expect(await db.cloudState.count()).toBe(0);expect(await journal.uploads.count()).toBe(1);
});
it('parallel and stale acknowledgements retain the union of verified chunks',async()=>{
 const {journal,snapshot}=await boot(5000);expect(snapshot.manifest.chunks.length).toBeGreaterThan(1);
 const progress={id:snapshot.id,manifestHash:snapshot.manifestHash,received:[] as number[],receipt:null};
 await Promise.all([journal.acknowledge(snapshot.id,{...progress,received:[0]}),journal.acknowledge(snapshot.id,{...progress,received:[1]})]);await journal.acknowledge(snapshot.id,progress);expect((await journal.readSnapshot(snapshot.id)).progress?.received).toEqual([0,1]);
});
it('live review observers follow another connection and stop delivering after unsubscribe',async()=>{
 const {db,journal,snapshot}=await boot(),other=new MiseDatabase(db.name),otherJournal=new CloudUploadJournal(journal.name);databases.push(other,otherJournal);const values:LocalUploadReview[]=[],errors=vi.fn(),stop=journal.watchReview(db,value=>values.push(value),errors);
 try{await vi.waitFor(()=>expect(values.at(-1)?.phase).toBe('review'));await beginLocalUpload(other,snapshot,target);await vi.waitFor(()=>expect(values.at(-1)?.phase).toBe('uploading'));await uploadWithLocalOutbox(other,otherJournal,snapshot.id,target,new MemoryCloudUpload());await vi.waitFor(()=>expect(values.at(-1)?.phase).toBe('ready'));expect(errors).not.toHaveBeenCalled();}
 finally{stop();}
 const count=values.length;await journal.uploads.delete(snapshot.id);await new Promise(resolve=>setTimeout(resolve,30));expect(values).toHaveLength(count);expect(errors).not.toHaveBeenCalled();
});
