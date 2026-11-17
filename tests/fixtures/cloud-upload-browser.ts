import {MiseDatabase} from '../../apps/web/src/data/db';
import {CloudUploadJournal,uploadDatabaseSnapshot} from '../../apps/web/src/data/cloud-upload';
import {backupToken} from '../../packages/core/backup';
import {readCloudUpload} from '../../packages/core/cloud-upload';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from '../cloud-upload-fixture';

let remote:MemoryCloudUpload|null=null;
function handles(){const state=JSON.parse(sessionStorage.getItem('mise-upload-test-handles')||'null') as {shop:string;journal:string}|null;if(!state)throw new Error('Test snapshot missing');return {db:new MiseDatabase(state.shop),journal:new CloudUploadJournal(state.journal)};}
const api={
  async prepare(){
    const state={shop:'mise-native-upload-shop-'+crypto.randomUUID(),journal:'mise-native-upload-journal-'+crypto.randomUUID()};sessionStorage.setItem('mise-upload-test-handles',JSON.stringify(state));const {db,journal}=handles();
    try{const backup=cloudUploadFixture(4999),review=await db.previewRestore(backup);await db.restoreBackup(backup,review);const snapshot=await journal.prepare(db,uploadId());return {records:snapshot.manifest.records,chunks:snapshot.chunks.length,rawBytes:snapshot.manifest.snapshotBytes,compressedBytes:snapshot.chunks.reduce((n,b)=>n+b.size,0)};}finally{db.close();journal.close();}
  },
  async inspect(){const {db,journal}=handles();try{const saved=await journal.readSnapshot(uploadId()),source=await readCloudUpload(saved),current=await db.readBackup();return {sameLocalData:backupToken(source)===backupToken(current),nativeBlob:saved.chunks.every(b=>b instanceof Blob),records:saved.manifest.records,sameOriginalImage:source.tables.inboxItems[0].images[0].data===current.tables.inboxItems[0].images[0].data};}finally{db.close();journal.close();}},
  async interrupt(){const {db,journal}=handles();remote=new MemoryCloudUpload();remote.losePartReply=0;try{await uploadDatabaseSnapshot(db,journal,uploadId(),remote,{beforeCommit:async()=>{}});throw new Error('Expected interruption');}catch(error){if(!(error instanceof Error)||!error.message.includes('Connection lost'))throw error;return {accepted:[...remote.received],cached:(await journal.readSnapshot(uploadId())).progress?.received};}finally{db.close();journal.close();}},
  async resume(){if(!remote)throw new Error('Receiver fixture missing');const {db,journal}=handles();try{const receipt=await uploadDatabaseSnapshot(db,journal,uploadId(),remote,{beforeCommit:async()=>{}});return {receipt,puts:remote.puts,commits:remote.commits,cachedReceipt:(await journal.readSnapshot(uploadId())).progress?.receipt,sameLocalData:backupToken(remote.snapshot!)===backupToken(await db.readBackup())};}finally{db.close();journal.close();}},
  async cleanup(){const {db,journal}=handles();await Promise.all([db.delete(),journal.delete()]);sessionStorage.removeItem('mise-upload-test-handles');remote=null;},
};
declare global {interface Window {miseCloudUploadTest:typeof api}}
window.miseCloudUploadTest=api;
