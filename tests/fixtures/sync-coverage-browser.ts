import Dexie from 'dexie';
import {MiseDatabase} from '../../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../../apps/web/src/data/cloud-upload';
import {prepareSyncDownload,runSyncDownload} from '../../apps/web/src/data/cloud-sync-journal';
import {downloadSyncCoverage,readVerifiedSyncCoverage} from '../../apps/web/src/data/cloud-sync-coverage';
import {downloadSyncImages} from '../../apps/web/src/data/cloud-sync-images';
import {createCloudCoverageRemote} from '../../apps/web/src/data/cloud-coverage-remote';
import {selectLocalOperator} from '../../apps/web/src/data/operator-state';
import {newInboxId} from '../../packages/core/inbox';
import {backupToken} from '../../packages/core/backup';
import {operatorAccountHash} from '../../packages/core/operators';
import {cloudConnectionTarget} from '../../packages/core/cloud-connection';
import {syncHash} from '../../packages/core/sync-read';
import type {ShopCommand} from '../../packages/core/shop-commands';
import {syncImagesFixture} from '../sync-images-fixture';
import {syncDownloadFixture} from '../sync-download-fixture';
import {coverageCash,coverageConfig as config,coverageUid as userId} from '../sync-coverage-fixture';
import {inboxPng} from '../inbox-fixture';
import {MemoryCloudUpload} from '../cloud-upload-fixture';
type Fixture=Awaited<ReturnType<typeof syncDownloadFixture>>;
interface Wire {id:'read';fixture:Fixture;commands:ShopCommand[];scope:string}
class Receiver extends Dexie {wire!:Dexie.Table<Wire,string>;constructor(name:string){super(name);this.version(1).stores({wire:'id'});}}
async function use<T>(run:(db:MiseDatabase,receiver:Receiver,journal:CloudUploadJournal)=>Promise<T>){const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),receiver=new Receiver('mise-coverage-receiver:'+base),journal=new CloudUploadJournal('mise-cloud-uploads:'+base);try{return await run(db,receiver,journal);}finally{db.close();receiver.close();journal.close();}}
async function wire(receiver:Receiver){const w=await receiver.wire.get('read');if(!w)throw Error('Prepare the native coverage receiver.');return w;}
const api={
 prepare:(empty=false)=>use(async(db,receiver,journal)=>{let f:Fixture,commands:ShopCommand[];
  if(empty){f=await syncImagesFixture();commands=[coverageCash(f.target.outletId)];}else{const setup=(await db.setup())!;await selectLocalOperator(db,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id},null);await db.captureInbox({title:'Keep original image source',text:'Original bytes',files:[0,1].map(n=>new File([new Uint8Array(inboxPng).buffer],'তালিকা '+n+'.png',{type:'image/png'}))});f=await syncDownloadFixture({source:await db.readBackup()});commands=[];}
  const scope=location.pathname.replace(/\/app\/.*$/,'/app/')+f.target.businessId;f.target.accountHash=await operatorAccountHash(userId);f.target.targetHash=await cloudConnectionTarget(config,scope,userId);f.window.accountHash=f.target.accountHash;for(const p of f.pages)p.accountHash=f.target.accountHash;
  if(!empty){const snapshot=await journal.prepare(db,newInboxId());await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,f.target.targetHash,new MemoryCloudUpload());await db.recordSale({expression:'5',method:'cash'});commands=(await db.outbox.toArray())[0].commands;}
  const request=await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:null});await runSyncDownload(db,request.id,f.target,{begin:async()=>f.window,page:async(_w,index)=>f.pages[index]});await receiver.wire.put({id:'read',fixture:f,scope,commands});return {readId:f.window.id,commands:commands.map(c=>c.id)};
 }),
 resume:()=>use(async(db,receiver)=>{const w=await wire(receiver);return downloadSyncCoverage(db,w.fixture.window.id,w.fixture.target,w.commands,createCloudCoverageRemote(config,w.scope,async()=>({jwt:'coverage.1.signature',userId})));}),
 read:()=>use(async(db,receiver)=>{const w=await wire(receiver);return readVerifiedSyncCoverage(db,w.fixture.window.id,w.fixture.target,w.commands);}),
 source:()=>use(async(db)=>{const rows=await db.syncCoverage.toArray();if(rows.length!==1)throw Error('Expected one original prepared batch.');return rows[0].source;}),
 inspect:()=>use(async(db)=>({proof:await db.syncCoverage.toArray(),queue:await db.outbox.toArray(),binding:await db.cloudState.get('binding'),operator:await db.operatorState.get('active'),backup:await db.readBackup(),pages:await db.syncPages.toArray(),schema:db.verno,stores:db.tables.length})),
 quota:()=>use(async(db,receiver)=>{const w=await wire(receiver),fail=()=>{throw new DOMException('Synthetic quota','QuotaExceededError');};db.syncCoverage.hook('updating',fail);try{await downloadSyncCoverage(db,w.fixture.window.id,w.fixture.target,w.commands,createCloudCoverageRemote(config,w.scope,async()=>({jwt:'coverage.1.signature',userId})));return {rejected:false};}catch{return {rejected:true,prepared:await db.syncCoverage.count(),result:(await db.syncCoverage.toArray())[0]?.result};}finally{db.syncCoverage.hook('updating').unsubscribe(fail);}}),
 corrupt:()=>use(async db=>{const row=(await db.syncCoverage.toArray())[0];await db.syncCoverage.put({...row,resultHash:'f'.repeat(64)});}),
 upgrade:()=>use(async(db,receiver)=>{const w=await wire(receiver);await downloadSyncImages(db,w.fixture.window.id,w.fixture.target,{get:async s=>new Blob([new Uint8Array(inboxPng).buffer],{type:s.image.type})});const before=backupToken(await db.readBackup()),names=['cloudState','outbox','operatorState','syncReads','syncPages','syncRecords','syncImages'],saved=await Promise.all(names.map(n=>db.table(n).toArray())),legacy=new Dexie('mise-native-coverage-legacy-'+crypto.randomUUID());legacy.version(14).stores(Object.fromEntries(db.tables.filter(t=>!['scopeRecoveries','syncCoverage','syncCanonical','syncApplications','syncAdmissions','syncSessions','joinSessions','syncActionReviews'].includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(const t of legacy.tables)await legacy.table(t.name).bulkPut(await db.table(t.name).toArray());legacy.close();const upgraded=new MiseDatabase(legacy.name);try{return {before,after:backupToken(await upgraded.readBackup()),oldInternalPreserved:JSON.stringify(await Promise.all(names.map(n=>upgraded.table(n).toArray())))===JSON.stringify(saved),originalImages:(await upgraded.inboxItems.toArray())[0].images.map(i=>i.blob.size),verifiedImages:(await upgraded.syncImages.toArray()).map(i=>i.blob.size),verifiedHashes:(await Promise.all((await upgraded.syncImages.toArray()).map(async i=>await syncHash(new Uint8Array(await i.blob.arrayBuffer()))===i.source.image.sha256))).every(Boolean),receipt:!!(await upgraded.cloudState.get('binding'))?.receipt,queue:await upgraded.outbox.count(),schema:upgraded.verno,stores:upgraded.tables.length,coverage:await upgraded.syncCoverage.count(),reviews:await upgraded.syncActionReviews.count()};}finally{await upgraded.delete();}})
};
declare global {interface Window {miseSyncCoverageTest:typeof api}}
window.miseSyncCoverageTest=api;
