import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {newInboxId} from '../packages/core/inbox';
import {backupToken} from '../packages/core/backup';
import type {MiseBackup} from '../packages/core/backup-tables';
import {prepareCloudUpload,readCloudUpload,assertCloudUploadCurrent,cloudUploadHash} from '../packages/core/cloud-upload';
import {openSavedPaymentSource,recordSavedPayment} from '../apps/web/src/data/payment-capture';
const databases:MiseDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.delete();});
async function fixture(){const db=new MiseDatabase('payment-upgrade-'+newInboxId());databases.push(db);const setup=await db.saveSetup({businessType:'corner_shop',marketCode:'BD',name:'Legacy upload source',phone:'01712345482'});await db.recordSale({expression:'25',method:'cash'});return {db,setup};}
// Frozen schema-10 protocol vocabulary, independent of the new native registry.
const legacyTables=['businesses','outlets','members','categories','items','events','sales','customers','creditAccounts','creditEntries','orders','orderNotes','orderCommunications','orderRefunds','stockItems','stockMoves','suppliers','supplierMessages','dayClosings','purchases','inboxItems'];
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,value])=>[k,canonical(value)])):v;
it('retains an actual schema-10 compressed source and its original review fingerprint across the empty-table upgrade',async()=>{
 const f=await fixture(),current=await f.db.readBackup(),legacy={...current,schemaVersion:10,tables:Object.fromEntries(legacyTables.map(name=>[name,current.tables[name as keyof typeof current.tables]]))},expected=JSON.stringify(canonical(Object.fromEntries(legacyTables.map(name=>[name,[...(legacy.tables[name] as {id:string}[])].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)]))));
 const plan=await prepareCloudUpload(legacy as unknown as MiseBackup,newInboxId());expect(Object.keys(plan.manifest.counts).sort()).toEqual([...legacyTables].sort());expect(plan.manifest.reviewHash).toBe(await cloudUploadHash(new TextEncoder().encode(expected)));expect(backupToken(current)).toBe(expected);expect((await readCloudUpload(plan)).tables.payments).toEqual([]);expect((await readCloudUpload(plan)).schemaVersion).toBe(13);await expect(assertCloudUploadCurrent(plan.manifest,current)).resolves.toBeUndefined();
 const newPlan=await prepareCloudUpload(current,newInboxId()),raw=JSON.parse(await new Response(newPlan.chunks[0].stream().pipeThrough(new DecompressionStream('gzip'))).text());expect(raw.schemaVersion).toBe(10);expect(Object.keys(raw.tables).sort()).toEqual([...legacyTables].sort());expect(raw.tables.payments).toBeUndefined();expect(backupToken(await readCloudUpload(newPlan))).toBe(expected);
});
it('refuses a complete saved-payment snapshot before preparing upload chunks and keeps all native records available for backup',async()=>{
 const f=await fixture(),item=await f.db.captureInbox({text:'You have received Tk 10. TrxID TESTNOUPLOAD'}),review=await openSavedPaymentSource(f.db,item.id,{businessId:f.setup.business.id,outletId:f.setup.outlet.id,actorId:f.setup.owner.id},{sender:'bKash'});await recordSavedPayment(f.db,review,{checked:true,amount:1000,currency:'BDT',method:'wallet',methodName:'bKash',reference:'TESTNOUPLOAD',receivedAt:item.createdAt});const backup=await f.db.readBackup(),before=backupToken(backup);await expect(prepareCloudUpload(backup,newInboxId())).rejects.toThrow('Native payment sync');expect(backupToken(await f.db.readBackup())).toBe(before);expect(backup.tables.payments).toHaveLength(1);
});
