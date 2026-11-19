import Dexie from 'dexie';
import {MiseDatabase} from '../../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../../apps/web/src/data/cloud-upload';
import {prepareSyncDownload,runSyncDownload,readSyncDownload,bindSyncDownloadWindow,appendSyncDownloadPage} from '../../apps/web/src/data/cloud-sync-journal';
import {backupToken} from '../../packages/core/backup';
import {newInboxId} from '../../packages/core/inbox';
import {MemoryCloudUpload} from '../cloud-upload-fixture';
import {syncDownloadFixture} from '../sync-download-fixture';
import {localDownloadTableNames} from '../../packages/core/sync-download';
import {captureDatabaseInbox} from '../../apps/web/src/data/inbox';
import {inboxPng} from '../inbox-fixture';

type Fixture=Awaited<ReturnType<typeof syncDownloadFixture>>;
class Receiver extends Dexie {constructor(name:string){super(name);this.version(1).stores({wire:'id'});}}
async function use<T>(task:(db:MiseDatabase,journal:CloudUploadJournal,receiver:Receiver)=>Promise<T>){
 const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),journal=new CloudUploadJournal('mise-cloud-uploads:'+base),receiver=new Receiver('mise-sync-stage-fixture:'+base);
 try{return await task(db,journal,receiver);}finally{db.close();journal.close();receiver.close();}
}
async function fixture(receiver:Receiver):Promise<Fixture>{const row=await receiver.table('wire').get('download');if(!row)throw Error('Prepare the test receiver first.');return row.fixture;}
function remote(f:Fixture,partial=false){return {begin:async()=>structuredClone(f.window),page:async(_window:unknown,index:number)=>{const page=structuredClone(f.pages[index]);if(partial&&index===1)throw Error('Synthetic lost page reply');return page;}};}
const api={
 upgradeLegacy:()=>use(async(db,journal)=>{
  await captureDatabaseInbox(db,{title:'Original upgrade image',text:'Keep these source bytes',files:[new File([new Uint8Array(inboxPng)],'original.png',{type:'image/png'})]});
  const plan=await journal.prepare(db,newInboxId());await uploadWithLocalOutbox(db,journal,plan.id,'a'.repeat(64),new MemoryCloudUpload());await db.recordSale({expression:'5',method:'cash'});
  const before=backupToken(await db.readBackup()),queue=await db.outbox.toArray(),binding=await db.cloudState.toArray(),name='mise-stage-native-upgrade-'+crypto.randomUUID(),legacy=new Dexie(name);
  legacy.version(11).stores(Object.fromEntries(db.tables.filter(t=>t.name!=='syncCoverage'&&t.name!=='syncCanonical'&&t.name!=='syncApplications'&&t.name!=='syncAdmissions'&&t.name!=='syncImages'&&t.name!=='operatorState'&&!(localDownloadTableNames as readonly string[]).includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));
  const upgraded=new MiseDatabase(name);
  try{for(const table of legacy.tables)await legacy.table(table.name).bulkPut(await db.table(table.name).toArray());legacy.close();return {before,after:backupToken(await upgraded.readBackup()),queuePreserved:JSON.stringify(await upgraded.outbox.toArray())===JSON.stringify(queue),bindingPreserved:JSON.stringify(await upgraded.cloudState.toArray())===JSON.stringify(binding),downloadRows:await Promise.all(localDownloadTableNames.map(t=>upgraded.table(t).count())),schema:upgraded.verno};}finally{legacy.close();await upgraded.delete();}
 }),
 prepare:(empty=false)=>use(async(db,journal,receiver)=>{
  if(!empty){const review=await journal.prepare(db,newInboxId());await uploadWithLocalOutbox(db,journal,review.id,'a'.repeat(64),new MemoryCloudUpload());}
  const f=await syncDownloadFixture(empty?{large:true}:{large:true,source:await db.readBackup()});await receiver.table('wire').put({id:'download',fixture:f});
  await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:null});return {id:f.window.id,expectedRecords:f.rows.length,original:empty?null:backupToken(await db.readBackup())};
 }),
 partial:()=>use(async(db,_journal,receiver)=>{const f=await fixture(receiver);try{await runSyncDownload(db,f.window.id,f.target,remote(f,true));throw Error('Expected a lost reply');}catch(error){if(!(error instanceof Error)||error.message!=='Synthetic lost page reply')throw error;}return readSyncDownload(db,f.window.id,f.target);}),
 resume:()=>use(async(db,_journal,receiver)=>{const f=await fixture(receiver);return runSyncDownload(db,f.window.id,f.target,remote(f));}),
 failProgress:()=>use(async(db,_journal,receiver)=>{
  const f=await fixture(receiver);await bindSyncDownloadWindow(db,f.window.id,f.target,f.window);const fail=()=>{throw new DOMException('Synthetic storage quota','QuotaExceededError');};db.syncReads.hook('updating',fail);let blocked=false;
  try{await appendSyncDownloadPage(db,f.window.id,f.target,f.pages[0]);}catch{blocked=true;}finally{db.syncReads.hook('updating').unsubscribe(fail);}
  return {blocked,pages:await db.syncPages.count(),state:await readSyncDownload(db,f.window.id,f.target)};
 }),
 inspect:()=>use(async(db,_journal,receiver)=>{const f=await fixture(receiver),state=await readSyncDownload(db,f.window.id,f.target),records=await db.syncRecords.toArray(),binding=await db.cloudState.get('binding');return {id:state.id,pages:state.pages,seal:state.seal,sourceHash:state.sourceHash,recordCount:records.length,receivedCursor:state.receivedCursor,queue:await db.outbox.toArray(),binding,backup:await db.readBackup(),schema:db.verno,businessCount:await db.businesses.count(),stagedLargeName:records.some(r=>r.meta.table==='businesses'&&r.row?.name===f.large)};})
};
declare global {interface Window {miseSyncStageTest:typeof api}}
window.miseSyncStageTest=api;
