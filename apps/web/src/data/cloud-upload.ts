import Dexie,{type EntityTable} from 'dexie';
import {assertCloudUploadCurrent,cloudUploadManifestHash,parseCloudUploadManifest,prepareCloudUpload,verifyCloudUploadChunk,type CloudUploadPlan} from '@mise/core/cloud-upload';
import {parseCloudUploadProgress,runCloudUpload,type CloudUploadProgress,type CloudUploadRemote} from '@mise/core/cloud-upload-runner';
import type {MiseDatabase} from './db';
import {readDatabaseBackup} from './backup';

interface StoredCloudUpload extends CloudUploadPlan {id:string;businessId:string;manifestHash:string;progress:CloudUploadProgress|null}
/** Separate from shop/backup tables. No JWT, API key or other credential belongs here. */
export class CloudUploadJournal extends Dexie {
  uploads!:EntityTable<StoredCloudUpload,'id'>;
  constructor(name='mise-cloud-uploads'){super(name);this.version(1).stores({uploads:'id,businessId'});}
  async prepare(db:MiseDatabase,id:string):Promise<StoredCloudUpload>{
    const plan=await prepareCloudUpload(await readDatabaseBackup(db),id);return this.addSnapshot(plan);
  }
  async addSnapshot(plan:CloudUploadPlan):Promise<StoredCloudUpload>{
    const manifest=parseCloudUploadManifest(plan.manifest),chunks=[...plan.chunks];
    if(chunks.length!==manifest.chunks.length)throw new Error('Incomplete local upload snapshot.');
    for(const part of manifest.chunks)await verifyCloudUploadChunk(manifest,part.index,chunks[part.index]);
    const stored:StoredCloudUpload={id:manifest.id,businessId:manifest.businessId,manifestHash:await cloudUploadManifestHash(manifest),manifest,chunks,progress:null};
    await this.uploads.add(stored);return stored;
  }
  async readSnapshot(id:string):Promise<StoredCloudUpload>{
    const stored=await this.uploads.get(id);if(!stored)throw new Error('This upload snapshot is unavailable. Review the local shop again.');
    const manifest=parseCloudUploadManifest(stored.manifest);
    if(stored.id!==manifest.id||stored.businessId!==manifest.businessId||stored.manifestHash!==await cloudUploadManifestHash(manifest)||!Array.isArray(stored.chunks)||stored.chunks.length!==manifest.chunks.length)throw new Error('The local upload journal has changed. Keep your JSON backup.');
    if(stored.progress)stored.progress=parseCloudUploadProgress(stored.progress,manifest,stored.manifestHash);
    return {...stored,manifest,chunks:[...stored.chunks]};
  }
  async latest(businessId:string,outletId:string):Promise<StoredCloudUpload|null>{const rows=(await this.uploads.where('businessId').equals(businessId).toArray()).filter(row=>row.manifest.outletId===outletId).sort((a,b)=>b.manifest.exportedAt-a.manifest.exportedAt||b.id.localeCompare(a.id));return rows.length?this.readSnapshot(rows[0].id):null;}
  async acknowledge(id:string,value:CloudUploadProgress):Promise<void>{
    const source=await this.readSnapshot(id),progress=parseCloudUploadProgress(value,source.manifest,source.manifestHash);
    await this.transaction('rw',this.uploads,async()=>{
      const latest=await this.uploads.get(id);if(!latest||latest.manifestHash!==source.manifestHash)throw new Error('The upload snapshot changed.');
      if(latest.progress?.receipt&&JSON.stringify(latest.progress.receipt)!==JSON.stringify(progress.receipt))throw new Error('Keep the accepted upload receipt.');
      await this.uploads.update(id,{progress});
    });
  }
}
/** Does not enable sync or replace shop data. The caller must establish its outbox boundary. */
export async function uploadDatabaseSnapshot(db:MiseDatabase,journal:CloudUploadJournal,id:string,remote:CloudUploadRemote,options:{beforeCommit:()=>Promise<void>;signal?:AbortSignal}){
  const snapshot=await journal.readSnapshot(id);
  return runCloudUpload(snapshot,remote,{signal:options.signal,progress:value=>journal.acknowledge(id,value),beforeCommit:async manifest=>{
    await options.beforeCommit();await assertCloudUploadCurrent(manifest,await readDatabaseBackup(db));
  }});
}
