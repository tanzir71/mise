import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {prepareSyncDownload,runSyncDownload,readVerifiedSyncRecords} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {mergeCanonicalRecords,reconstructCanonicalSnapshot,type CanonicalRecord} from '../packages/core/sync-canonical';
import {syncHash,type SyncReadPage} from '../packages/core/sync-read';
import {syncDownloadToken,type LocalSyncRecord} from '../packages/core/sync-download';
import {backupToken} from '../packages/core/backup';
import {inboxImageBase64,newInboxId} from '../packages/core/inbox';
import {syncJoinFixture} from './sync-join-fixture';
const databases:MiseDatabase[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
const digest=(row:unknown)=>syncHash(new TextEncoder().encode(syncDownloadToken(row)));
async function boot(manager=false){const f=await syncJoinFixture(manager),db=new MiseDatabase('canonical-core-'+newInboxId());databases.push(db);await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:null});const state=await runSyncDownload(db,f.window.id,f.target,{begin:async()=>f.window,page:async(_w,i)=>f.pages[i]}),records=(await readVerifiedSyncRecords(db,f.window.id,f.target)).records,images=await downloadSyncImages(db,f.window.id,f.target,{get:async source=>new Blob([new Uint8Array(f.imageBytes).buffer],{type:source.image.type})});return {...f,db,state,records,images:images.images};}
it.each([false,true])('reconstructs every portable row and original image for a manager=%s, without mutating the source',async manager=>{const f=await boot(manager),before=syncDownloadToken(f.records),snapshot=await reconstructCanonicalSnapshot(f.state,f.records,f.images);expect(backupToken(snapshot.backup)).toBe(backupToken(f.backup));expect(syncDownloadToken(f.records)).toBe(before);expect(snapshot.backup.tables.inboxItems[0].images[0].name).toContain('তালিকা');expect(snapshot.scope.role).toBe(manager?'manager':'owner');expect(await f.db.businesses.count()).toBe(0);expect(await f.db.cloudState.count()).toBe(0);});
it('keeps full bigint ordering and tombstones when a late older upsert arrives',async()=>{
 const id=newInboxId(),row={id,name:'Original'},base:CanonicalRecord={table:'items',id,changeId:'9007199254740994',operation:'delete',row:null,rowHash:await digest(null)},incoming:LocalSyncRecord={readId:id,changeId:'9007199254740993',meta:{table:'items',id,changeId:'9007199254740993',operation:'upsert',sha256:'a'.repeat(64),totalBytes:1},row,rowHash:await digest(row)};
 expect(await mergeCanonicalRecords([base],[incoming],id)).toEqual([base]);
});
it.each(['hash','ordinal','identity'] as const)('refuses a changed %s before selecting a canonical row',async kind=>{const f=await boot(),rows=structuredClone(f.records);if(kind==='hash')rows[0].rowHash='f'.repeat(64);if(kind==='ordinal')rows[1].changeId=rows[1].meta.changeId=rows[0].changeId;if(kind==='identity')rows[0].meta.id=newInboxId();await expect(reconstructCanonicalSnapshot(f.state,rows,f.images)).rejects.toThrow();});
it('requires the complete original record set, customer associations and image bytes',async()=>{const f=await boot();for(const table of ['events','customer_outlets','inbox_images'])await expect(reconstructCanonicalSnapshot(f.state,f.records.filter(r=>r.meta.table!==table),f.images)).rejects.toThrow();await expect(reconstructCanonicalSnapshot(f.state,f.records,[])).rejects.toThrow();});
it('a real staged delta preserves unchanged original image bytes and applies a changed catalogue price',async()=>{
 const f=await boot(),base=await reconstructCanonicalSnapshot(f.state,f.records,f.images),id=newInboxId(),window={...f.window,id},original=f.pages.flatMap(p=>p.parts).find(p=>p.table==='items')!,raw=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(original.data),c=>c.charCodeAt(0))));raw.price+=100;
 const bytes=new TextEncoder().encode(JSON.stringify(raw)),changeId=String(f.records.reduce((n,r)=>BigInt(r.changeId)>n?BigInt(r.changeId):n,0n)+1n),{createdAt:_,expiresAt:__,...scope}=window;void _;void __;
 const page:SyncReadPage={...scope,index:0,parts:[{...original,changeId,totalBytes:bytes.length,sha256:await syncHash(bytes),data:inboxImageBase64(bytes)}],done:true,cursor:'synthetic-next-cursor'};
 await prepareSyncDownload(f.db,{id,target:f.target,previousCursor:base.cursor});const state=await runSyncDownload(f.db,id,f.target,{begin:async()=>window,page:async()=>page}),records=(await readVerifiedSyncRecords(f.db,id,f.target)).records,next=await reconstructCanonicalSnapshot(state,records,[],base);
 expect(next.backup.tables.items.find(i=>i.id===raw.id)?.price).toBe(raw.price);expect(next.backup.tables.inboxItems).toEqual(base.backup.tables.inboxItems);expect(next.backup.tables.sales).toEqual(base.backup.tables.sales);expect(next.cursor).toBe('synthetic-next-cursor');expect(base.backup.tables.items.find(i=>i.id===raw.id)?.price).toBe(raw.price-100);
 const damaged=structuredClone(base),image=damaged.backup.tables.inboxItems[0].images[0];const data=Uint8Array.from(atob(image.data),c=>c.charCodeAt(0));data[data.length-1]^=1;image.data=inboxImageBase64(data);await expect(reconstructCanonicalSnapshot(state,records,[],damaged)).rejects.toThrow();
 await expect(reconstructCanonicalSnapshot({...state,source:{...state.source,previousCursor:'another-cursor'}},records,[],base)).rejects.toThrow();
});
