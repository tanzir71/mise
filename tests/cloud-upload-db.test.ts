import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadDatabaseSnapshot} from '../apps/web/src/data/cloud-upload';
import {backupToken} from '../packages/core/backup';
import {backupTableNames} from '../packages/core/backup-tables';
import {readCloudUpload} from '../packages/core/cloud-upload';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
const databases:(MiseDatabase|CloudUploadJournal)[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(){const db=new MiseDatabase('mise-upload-shop-test-'+randomUUID());databases.push(db);const source=cloudUploadFixture(),review=await db.previewRestore(source);await db.restoreBackup(source,review);return db;}
function journal(name='mise-upload-journal-test-'+randomUUID()){const db=new CloudUploadJournal(name);databases.push(db);return db;}
it('keeps immutable chunks across close/reopen without changing the shop schema or its JSON backup',async()=>{
  const db=await boot(),before=await db.readBackup(),cache=journal(),saved=await cache.prepare(db,uploadId()),name=cache.name;cache.close();const reopened=journal(name),loaded=await reopened.readSnapshot(uploadId());
  expect(loaded.manifestHash).toBe(saved.manifestHash);expect(loaded.chunks[0]).toBeInstanceOf(Blob);expect(backupToken(await readCloudUpload(loaded))).toBe(backupToken(before));expect(backupToken(await db.readBackup())).toBe(backupToken(before));expect(db.tables.map(t=>t.name).sort()).toEqual([...backupTableNames].sort());expect(db.verno).toBe(10);expect(JSON.stringify(loaded)).not.toMatch(/api_key|access_token|refresh_token|authorization/i);
});
it('uses remote ACKs after restart, retains the accepted receipt and does not resend an accepted chunk',async()=>{
  const db=await boot(),cache=journal(),snapshot=await cache.prepare(db,uploadId()),remote=new MemoryCloudUpload();remote.losePartReply=0;
  await expect(uploadDatabaseSnapshot(db,cache,uploadId(),remote,{beforeCommit:async()=>{}})).rejects.toThrow('Connection lost');expect((await cache.readSnapshot(uploadId())).progress?.received).toEqual([]);
  const name=cache.name;cache.close();const reopened=journal(name),receipt=await uploadDatabaseSnapshot(db,reopened,uploadId(),remote,{beforeCommit:async()=>{}});expect(receipt).toEqual(remote.receipt);expect(remote.puts).toHaveLength(snapshot.chunks.length);expect((await reopened.readSnapshot(uploadId())).progress?.receipt).toEqual(receipt);
  const accepted=(await reopened.readSnapshot(uploadId())).progress!;await expect(reopened.acknowledge(uploadId(),{...accepted,receipt:null})).rejects.toThrow('accepted upload receipt');
});
it('a local edit during staging blocks promotion and leaves both the working copy and reviewed snapshot intact',async()=>{
  const db=await boot(),cache=journal(),snapshot=await cache.prepare(db,uploadId()),before=(await readCloudUpload(snapshot)).tables.items[0],remote=new MemoryCloudUpload();
  await db.saveItem({name:before.name,nameLocal:before.nameLocal,unit:before.unit,category:'Changed',price:before.price+50,available:true,oftenBought:false},before.id);
  await expect(uploadDatabaseSnapshot(db,cache,uploadId(),remote,{beforeCommit:async()=>{}})).rejects.toThrow('data changed');expect(remote.commits).toBe(0);expect((await db.items.get(before.id))!.price).toBe(before.price+50);expect((await readCloudUpload(await cache.readSnapshot(uploadId()))).tables.items[0].price).toBe(before.price);expect((await cache.readSnapshot(uploadId())).progress?.receipt).toBeNull();
});
it('never overwrites an existing upload ID and refuses corrupted manifest bindings',async()=>{
  const db=await boot(),cache=journal(),saved=await cache.prepare(db,uploadId());await expect(cache.addSnapshot(saved)).rejects.toMatchObject({name:'ConstraintError'});expect((await cache.readSnapshot(uploadId())).manifestHash).toBe(saved.manifestHash);
  await cache.uploads.update(uploadId(),{manifestHash:'0'.repeat(64)});await expect(cache.readSnapshot(uploadId())).rejects.toThrow('journal has changed');
});
it('corrupt persisted bytes cannot reach a promotion call',async()=>{
  const db=await boot(),cache=journal(),saved=await cache.prepare(db,uploadId()),remote=new MemoryCloudUpload();await cache.uploads.update(uploadId(),{chunks:[new Blob([new Uint8Array(saved.chunks[0].size)])]});
  await expect(uploadDatabaseSnapshot(db,cache,uploadId(),remote,{beforeCommit:async()=>{}})).rejects.toThrow('chunk changed');expect(remote.puts).toEqual([]);expect(remote.commits).toBe(0);
});
it('storage failure leaves local shop data available and does not create a partial journal',async()=>{
  const db=await boot(),cache=journal(),before=backupToken(await db.readBackup());vi.spyOn(cache.uploads,'add').mockRejectedValue(new DOMException('Quota exceeded','QuotaExceededError'));
  await expect(cache.prepare(db,uploadId())).rejects.toMatchObject({name:'QuotaExceededError'});expect(backupToken(await db.readBackup())).toBe(before);expect(await cache.uploads.count()).toBe(0);
});
