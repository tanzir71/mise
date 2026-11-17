import {expect,it,vi} from 'vitest';
import {backupToken,createBackup} from '../packages/core/backup';
import {assertCloudUploadCurrent,cloudUploadHash,cloudUploadManifestHash,parseCloudUploadManifest,prepareCloudUpload,readCloudUpload} from '../packages/core/cloud-upload';
import {parseCloudUploadProgress,runCloudUpload,type CloudUploadProgress} from '../packages/core/cloud-upload-runner';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
const progress=async(value:CloudUploadProgress)=>{void value;},beforeCommit=async()=>{};
it('round-trips all tables, literal Unicode and original image bytes in compressed verified chunks',async()=>{
  const source=cloudUploadFixture(),plan=await prepareCloudUpload(source,uploadId());expect(plan.manifest.records).toBe(Object.values(source.tables).reduce((n,rows)=>n+rows.length,0));expect(plan.manifest.images).toBe(1);expect(plan.manifest.imageBytes).toBe(source.tables.inboxItems[0].images[0].size);expect(backupToken(await readCloudUpload(plan))).toBe(backupToken(source));expect(JSON.stringify(plan.manifest)).not.toContain(source.tables.customers[0].name);expect(Object.isFrozen(plan.manifest.counts)).toBe(true);
});
it('captures before the first await and compares current data independently of capture time/order',async()=>{
  const source=cloudUploadFixture(),original=structuredClone(source),pending=prepareCloudUpload(source,uploadId());source.tables.items[0].price++;const plan=await pending;
  expect(backupToken(await readCloudUpload(plan))).toBe(backupToken(original));const reordered=createBackup({...original.tables,items:[...original.tables.items].reverse()},original.exportedAt+100);
  await expect(assertCloudUploadCurrent(plan.manifest,reordered)).resolves.toBeUndefined();await expect(assertCloudUploadCurrent(plan.manifest,source)).rejects.toThrow('data changed');
});
it('canonicalizes manifest order and rejects spoofed metadata or unsupported fields',async()=>{
  const {manifest}=await prepareCloudUpload(cloudUploadFixture(),uploadId()),reordered=Object.fromEntries(Object.entries(manifest).reverse());expect(await cloudUploadManifestHash(reordered as typeof manifest)).toBe(await cloudUploadManifestHash(manifest));
  for(const extra of [{role:'owner'},{authUserId:'spoof'},{token:'secret'}])expect(()=>parseCloudUploadManifest({...manifest,...extra})).toThrow();
  for(const change of [{snapshotBytes:50*1024*1024+1},{records:manifest.records+1},{counts:{...manifest.counts,items:'3'}},{chunks:[]},{chunks:new Array(manifest.chunks.length)},{snapshotHash:'invalid'}])expect(()=>parseCloudUploadManifest({...manifest,...change})).toThrow();
});
it('rejects a changed chunk, missing data and a validly hashed decompression bomb before promotion',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId());await expect(readCloudUpload({...plan,chunks:[]})).rejects.toThrow('Incomplete');
  await expect(readCloudUpload({...plan,chunks:[new Blob(['changed'])]})).rejects.toThrow('chunk changed');
  const bomb=await new Response(new Blob(['x'.repeat(plan.manifest.snapshotBytes+1)]).stream().pipeThrough(new CompressionStream('gzip'))).blob(),sha256=await cloudUploadHash(new Uint8Array(await bomb.arrayBuffer()));
  await expect(readCloudUpload({manifest:{...plan.manifest,chunks:[{...plan.manifest.chunks[0],bytes:bomb.size,sha256}]},chunks:[bomb]})).rejects.toThrow('exceeds its reviewed size');
});
it.each(['businessId','ownerId','reviewHash','snapshotHash'] as const)('receiver validation refuses a changed %s even with intact compressed data',async field=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),manifest={...plan.manifest,[field]:field.endsWith('Hash')?'0'.repeat(64):uploadId(99)};await expect(readCloudUpload({...plan,manifest})).rejects.toThrow();
});
it('resumes 5000 exact records from remote ACKs after a lost part reply without resending accepted chunks',async()=>{
  const source=cloudUploadFixture(5000),plan=await prepareCloudUpload(source,uploadId()),remote=new MemoryCloudUpload(),updates=vi.fn(progress),gate=vi.fn(beforeCommit);expect(plan.manifest.records).toBe(5000);expect(plan.chunks.length).toBeGreaterThan(1);
  remote.losePartReply=1;await expect(runCloudUpload(plan,remote,{progress:updates,beforeCommit:gate})).rejects.toThrow('Connection lost');expect(gate).not.toHaveBeenCalled();const accepted=[...remote.received];
  const receipt=await runCloudUpload(plan,remote,{progress:updates,beforeCommit:gate});expect(receipt.records).toBe(5000);for(const n of accepted)expect(remote.puts.filter(index=>index===n)).toHaveLength(1);expect(gate).toHaveBeenCalledTimes(1);expect(remote.commits).toBe(1);expect(backupToken(remote.snapshot!)).toBe(backupToken(source));
});
it('lost commit acknowledgements replay one historical receipt without a second promotion',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),remote=new MemoryCloudUpload(),gate=vi.fn(beforeCommit);remote.loseCommitReply=true;
  await expect(runCloudUpload(plan,remote,{progress,beforeCommit:gate})).rejects.toThrow('after commit');expect(remote.commits).toBe(1);const receipt=await runCloudUpload(plan,remote,{progress,beforeCommit:gate});expect(receipt).toEqual(remote.receipt);expect(remote.commits).toBe(1);expect(gate).toHaveBeenCalledTimes(1);
});
it('a changed local review prevents final promotion and leaves the original snapshot available',async()=>{
  const source=cloudUploadFixture(),plan=await prepareCloudUpload(source,uploadId()),remote=new MemoryCloudUpload();source.tables.items[0].price++;
  await expect(runCloudUpload(plan,remote,{progress,beforeCommit:()=>assertCloudUploadCurrent(plan.manifest,source)})).rejects.toThrow('data changed');expect(remote.commits).toBe(0);expect(remote.received.size).toBe(plan.chunks.length);expect((await readCloudUpload(plan)).tables.items[0].price).not.toBe(source.tables.items[0].price);
});
it('a wrong manifest, malformed ACK or omitted receipt stops instead of claiming completion',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),hash=await cloudUploadManifestHash(plan.manifest),status={id:plan.manifest.id,manifestHash:hash,received:[],receipt:null};
  for(const change of [{id:uploadId(2)},{manifestHash:'0'.repeat(64)},{received:[0,0]},{received:[-1]},{received:[999]},{received:new Array(1)},{private:'data'}])expect(()=>parseCloudUploadProgress({...status,...change},plan.manifest,hash)).toThrow();
  const remote=new MemoryCloudUpload();vi.spyOn(remote,'put').mockResolvedValue(status);await expect(runCloudUpload(plan,remote,{progress,beforeCommit})).rejects.toThrow('acknowledgement');expect(remote.commits).toBe(0);
});
it('abort preserves remote progress for the same upload ID without finalizing',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),remote=new MemoryCloudUpload(),controller=new AbortController(),put=remote.put.bind(remote);vi.spyOn(remote,'put').mockImplementation(async(...args)=>{const status=await put(...args);controller.abort();return status;});
  await expect(runCloudUpload(plan,remote,{progress,beforeCommit,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(remote.commits).toBe(0);expect(remote.received.size).toBe(1);
  await runCloudUpload(plan,remote,{progress,beforeCommit});expect(remote.commits).toBe(1);expect(remote.puts).toHaveLength(1);
});
it('an incomplete final acknowledgement leaves a resumable upload instead of a success receipt',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),remote=new MemoryCloudUpload();vi.spyOn(remote,'finish').mockImplementation(async()=>({id:plan.manifest.id,manifestHash:await cloudUploadManifestHash(plan.manifest),received:[0],receipt:null}));
  await expect(runCloudUpload(plan,remote,{progress,beforeCommit})).rejects.toThrow('not accepted');expect(remote.commits).toBe(0);
});
it('an accepted final receipt is persisted when cancellation races the response',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),remote=new MemoryCloudUpload(),controller=new AbortController(),finish=remote.finish.bind(remote),updates=vi.fn(progress);
  vi.spyOn(remote,'finish').mockImplementation(async(...args)=>{const value=await finish(...args);controller.abort();return value;});
  const result=await runCloudUpload(plan,remote,{progress:updates,beforeCommit,signal:controller.signal});expect(result).toEqual(remote.receipt);expect(updates.mock.calls.at(-1)?.[0].receipt).toEqual(result);
});
it('the final gate must succeed before any promotion request is made',async()=>{
  const plan=await prepareCloudUpload(cloudUploadFixture(),uploadId()),remote=new MemoryCloudUpload();await expect(runCloudUpload(plan,remote,{progress,beforeCommit:async()=>{throw new Error('Outbox boundary unavailable');}})).rejects.toThrow('Outbox boundary');expect(remote.commits).toBe(0);expect(remote.received.size).toBe(plan.chunks.length);
});
