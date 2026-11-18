import Dexie from 'dexie';
import {MiseDatabase} from '../../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../../apps/web/src/data/cloud-upload';
import {prepareSyncDownload,runSyncDownload} from '../../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages,readVerifiedSyncImages} from '../../apps/web/src/data/cloud-sync-images';
import {createCloudImageRemote} from '../../apps/web/src/data/cloud-image-remote';
import {selectLocalOperator} from '../../apps/web/src/data/operator-state';
import {backupToken} from '../../packages/core/backup';
import {newInboxId,inboxImageBase64} from '../../packages/core/inbox';
import {operatorAccountHash} from '../../packages/core/operators';
import {cloudConnectionTarget} from '../../packages/core/cloud-connection';
import {syncHash,type SyncReadPart} from '../../packages/core/sync-read';
import {syncDownloadFixture} from '../sync-download-fixture';
import {syncImagesFixture} from '../sync-images-fixture';
import {inboxPng} from '../inbox-fixture';
import {MemoryCloudUpload} from '../cloud-upload-fixture';

type Fixture=Awaited<ReturnType<typeof syncDownloadFixture>>;
interface Wire {id:'read';fixture:Fixture;scope:string;userId:string}
class Receiver extends Dexie {wire!:Dexie.Table<Wire,string>;constructor(name:string){super(name);this.version(1).stores({wire:'id'});}}
const config={apiUrl:'https://images.test',publishableKey:'sb_publishable_test_only'},uid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function use<T>(run:(db:MiseDatabase,receiver:Receiver,journal:CloudUploadJournal)=>Promise<T>){const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),receiver=new Receiver('mise-image-receiver:'+base),journal=new CloudUploadJournal('mise-cloud-uploads:'+base);try{return await run(db,receiver,journal);}finally{db.close();receiver.close();journal.close();}}
async function wire(receiver:Receiver){const row=await receiver.wire.get('read');if(!row)throw Error('Prepare the native image receiver first.');return row;}
async function appendManager(f:Fixture){
 const original=f.pages.flatMap(p=>p.parts).find(p=>p.table==='members')!,member=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(original.data),c=>c.charCodeAt(0)))),actorId=newInboxId();
 const row={...member,id:actorId,name:'Receiving manager',role:'manager',phone:null},assignment={business_id:f.target.businessId,outlet_id:f.target.outletId,member_id:actorId},parts:SyncReadPart[]=[];let ordinal=BigInt(f.pages.at(-1)!.parts.at(-1)!.changeId)+1n;
 for(const [table,value]of [['members',row],['member_outlets',assignment]]as const){const bytes=new TextEncoder().encode(JSON.stringify(value));parts.push({changeId:String(ordinal++),table,id:actorId,operation:'upsert',offset:0,totalBytes:bytes.length,sha256:await syncHash(bytes),data:inboxImageBase64(bytes)});}
 const last=f.pages.at(-1)!;last.done=false;last.cursor=null;f.pages.push({...last,index:f.pages.length,parts,done:true,cursor:'synthetic-received-cursor'});return actorId;
}
const api={
 prepare:(emptyManager=false)=>use(async(db,receiver,journal)=>{
  let f:Fixture;if(emptyManager)f=await syncImagesFixture();else{
   const setup=await db.setup();if(!setup)throw Error('Configure the native test shop first.');await selectLocalOperator(db,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id},null);
   await db.captureInbox({title:'Original native image source',text:'Keep these original bytes.',files:[0,1].map(n=>new File([new Uint8Array(inboxPng).buffer],'তালিকা '+n+'.png',{type:'image/png'}))});f=await syncDownloadFixture({source:await db.readBackup()});
  }
  const base=location.pathname.replace(/\/app\/.*$/,'/app/'),scope=base+f.target.businessId,userId=uid(emptyManager?2:1),actorId=emptyManager?await appendManager(f):f.target.actorId;
  f.target={...f.target,actorId,role:emptyManager?'manager':'owner',accountHash:await operatorAccountHash(userId),targetHash:await cloudConnectionTarget(config,scope,userId)};const {targetHash:_targetHash,...fields}=f.target;void _targetHash;Object.assign(f.window,fields);for(const page of f.pages)Object.assign(page,fields);
  if(!emptyManager){const plan=await journal.prepare(db,newInboxId());await uploadWithLocalOutbox(db,journal,plan.id,f.target.targetHash,new MemoryCloudUpload());}
  await receiver.wire.put({id:'read',fixture:f,scope,userId});const request=await prepareSyncDownload(db,{id:f.window.id,target:f.target,previousCursor:null});await runSyncDownload(db,request.id,f.target,{begin:async()=>f.window,page:async(_window,index)=>f.pages[index]});return {id:request.id,images:f.pages.flatMap(p=>p.parts).filter(p=>p.table==='inbox_images').length};
 }),
 resume:()=>use(async(db,receiver)=>{const w=await wire(receiver),remote=createCloudImageRemote(config,w.scope,async()=>({jwt:'image.'+(w.userId===uid(2)?2:1)+'.signature',userId:w.userId})),result=await downloadSyncImages(db,w.fixture.window.id,w.fixture.target,remote);return {hash:result.hash,count:result.images.length,bytes:result.bytes};}),
 read:()=>use(async(db,receiver)=>{const w=await wire(receiver),result=await readVerifiedSyncImages(db,w.fixture.window.id,w.fixture.target);return {hash:result.hash,count:result.images.length,bytes:result.bytes};}),
 inspect:()=>use(async(db,receiver)=>{const w=await wire(receiver),rows=await db.syncImages.where('readId').equals(w.fixture.window.id).toArray(),cache=[];for(const row of rows)cache.push({imageId:row.imageId,sourceHash:row.sourceHash,target:row.source.target,size:row.blob.size,expectedHash:row.source.image.sha256,actualHash:await syncHash(new Uint8Array(await row.blob.arrayBuffer()))});return {cache,backup:await db.readBackup(),binding:await db.cloudState.get('binding'),queue:await db.outbox.toArray(),download:await db.syncReads.get(w.fixture.window.id),operator:await db.operatorState.get('active'),schema:db.verno,stores:db.tables.length};}),
 quota:()=>use(async(db,receiver)=>{const w=await wire(receiver),fail=()=>{throw new DOMException('Synthetic quota','QuotaExceededError');};db.syncImages.hook('creating',fail);try{await downloadSyncImages(db,w.fixture.window.id,w.fixture.target,createCloudImageRemote(config,w.scope,async()=>({jwt:'image.1.signature',userId:w.userId})));return {rejected:false};}catch{return {rejected:true,cacheRows:await db.syncImages.count()};}finally{db.syncImages.hook('creating').unsubscribe(fail);}}),
 corrupt:()=>use(async(db)=>{const row=(await db.syncImages.toArray())[0];if(!row)throw Error('Download originals first.');const bytes=new Uint8Array(await row.blob.arrayBuffer());bytes[bytes.length-1]^=1;await db.syncImages.put({...row,blob:new Blob([bytes],{type:row.blob.type})});}),
 upgrade:()=>use(async(db)=>{
  await db.recordSale({expression:'5',method:'cash'});const before=backupToken(await db.readBackup()),operator=await db.operatorState.toArray(),binding=await db.cloudState.toArray(),queue=await db.outbox.toArray(),pages=await db.syncPages.toArray(),legacy=new Dexie('mise-native-image-upgrade-'+crypto.randomUUID());legacy.version(13).stores(Object.fromEntries(db.tables.filter(t=>!['syncImages','syncCoverage'].includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(const table of legacy.tables)await legacy.table(table.name).bulkPut(await db.table(table.name).toArray());legacy.close();const upgraded=new MiseDatabase(legacy.name);
  try{return {before,after:backupToken(await upgraded.readBackup()),operatorPreserved:JSON.stringify(await upgraded.operatorState.toArray())===JSON.stringify(operator),bindingPreserved:JSON.stringify(await upgraded.cloudState.toArray())===JSON.stringify(binding),queuePreserved:JSON.stringify(await upgraded.outbox.toArray())===JSON.stringify(queue),pagesPreserved:JSON.stringify(await upgraded.syncPages.toArray())===JSON.stringify(pages),originalImages:(await upgraded.inboxItems.toArray())[0].images.map(i=>i.blob.size),receipt:!!binding[0]?.receipt,queued:queue.length,cacheRows:await upgraded.syncImages.count(),schema:upgraded.verno};}finally{await upgraded.delete();}
 })
};
declare global {interface Window {miseSyncImagesTest:typeof api}}
window.miseSyncImagesTest=api;
