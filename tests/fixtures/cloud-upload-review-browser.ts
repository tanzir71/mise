import {MiseDatabase} from '../../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../../apps/web/src/data/cloud-upload';
import {beginLocalUpload,cancelLocalUpload} from '../../apps/web/src/data/local-outbox';
import {cloudUploadHash,prepareCloudUpload} from '../../packages/core/cloud-upload';
import {newInboxId} from '../../packages/core/inbox';
import {MemoryCloudUpload} from '../cloud-upload-fixture';

const target='b'.repeat(64);
let removed:Awaited<ReturnType<CloudUploadJournal['readSnapshot']>>|null=null;
async function use<T>(task:(db:MiseDatabase,journal:CloudUploadJournal)=>Promise<T>){
 const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),journal=new CloudUploadJournal('mise-cloud-uploads:'+base);
 try{return await task(db,journal);}finally{db.close();journal.close();}
}
const api={
 arm:()=>use(async(db,journal)=>{const value=await journal.review(db);if(!value.snapshot)throw Error('Prepare a real local review first.');await beginLocalUpload(db,value.snapshot,target);return value.snapshot.id;}),
 shadow:()=>use(async(db,journal)=>{await db.recordSale({expression:'5',method:'cash'});const saved=await journal.addSnapshot(await prepareCloudUpload(await db.readBackup(),newInboxId()));return saved.id;}),
 accept:()=>use(async(db,journal)=>{const state=(await db.cloudState.get('binding'))!;return uploadWithLocalOutbox(db,journal,state.uploadId,target,new MemoryCloudUpload());}),
 cancel:()=>use(async(db)=>{const state=(await db.cloudState.get('binding'))!;await cancelLocalUpload(db,state.uploadId,target,{cancel:async id=>({id,canceled:true})});}),
 removeOriginal:()=>use(async(db,journal)=>{const state=(await db.cloudState.get('binding'))!;removed=await journal.readSnapshot(state.uploadId);await journal.uploads.delete(state.uploadId);}),
 restoreOriginal:()=>use(async(_db,journal)=>{if(!removed)throw Error('Original fixture missing.');await journal.uploads.add(removed);removed=null;}),
 inspect:()=>use(async(db,journal)=>{
  const state=await db.cloudState.get('binding'),rows=await journal.uploads.toArray(),bound=state?rows.find(row=>row.id===state.uploadId):null;
  return {phase:state?.phase??null,boundId:state?.uploadId??null,queue:await db.outbox.count(),snapshots:rows.map(row=>({id:row.id,records:row.manifest.records,progress:row.progress})),boundHash:bound?await cloudUploadHash(new Uint8Array(await bound.chunks[0].arrayBuffer())):null};
 })
};
declare global {interface Window {miseUploadReviewTest:typeof api}}
window.miseUploadReviewTest=api;
