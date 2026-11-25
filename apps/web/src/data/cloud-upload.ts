import Dexie,{liveQuery,type EntityTable} from 'dexie';
import {assertCloudUploadCurrent,cloudUploadManifestHash,parseCloudUploadManifest,prepareCloudUpload,readCloudUpload,verifyCloudUploadChunk,type CloudUploadPlan} from '@mise/core/cloud-upload';
import {parseCloudUploadProgress,runCloudUpload,type CloudUploadProgress,type CloudUploadRemote} from '@mise/core/cloud-upload-runner';
import {parseLocalCloudState} from '@mise/core/local-outbox';
import type {MiseDatabase} from './db';
import {readDatabaseBackup} from './backup';
import {beginLocalUpload,assertLocalUploadCoverage,acceptLocalUpload} from './local-outbox';
import {readCanonicalState,assertCanonicalState} from './cloud-canonical-state';
import {parseLocalOperatorState} from '@mise/core/operators';
import {syncDownloadToken} from '@mise/core/sync-download';

interface StoredCloudUpload extends CloudUploadPlan {id:string;businessId:string;manifestHash:string;progress:CloudUploadProgress|null}
interface SelectedReview {id:string;uploadId:string}
export interface LocalUploadReview {snapshot:StoredCloudUpload|null;phase:'review'|'uploading'|'ready'}
const reviewKey=(scope:{businessId:string;outletId:string;ownerId:string})=>[scope.businessId,scope.outletId,scope.ownerId].join('/');
const reviewError=()=>new Error('The original upload review needs recovery. Keep your local copy and JSON backup.');
async function reviewContext(db:MiseDatabase){
  return db.transaction('r',db.cloudState,db.businesses,db.outlets,db.members,async()=>{
    const setup=await db.setup();if(!setup)throw reviewError();
    const saved=await db.cloudState.get('binding'),binding=saved===undefined?null:parseLocalCloudState(saved);
    const scope={businessId:setup.business.id,outletId:setup.outlet.id,ownerId:setup.owner.id};
    if(binding&&binding.phase!=='cancelled'&&(binding.businessId!==scope.businessId||binding.outletId!==scope.outletId||binding.ownerId!==scope.ownerId))throw reviewError();
    return {scope,binding};
  });
}
/** Separate from shop/backup tables. No JWT, API key or other credential belongs here. */
export class CloudUploadJournal extends Dexie {
  uploads!:EntityTable<StoredCloudUpload,'id'>;
  reviews!:EntityTable<SelectedReview,'id'>;
  constructor(name='mise-cloud-uploads'){super(name);this.version(1).stores({uploads:'id,businessId'});this.version(2).stores({reviews:'id'});}
  async prepare(db:MiseDatabase,id:string):Promise<StoredCloudUpload>{
    if(await db.nativePaymentActions.count())throw Error('Native payment delivery is not enabled yet. Keep the original journal.');
    const current=await this.review(db);if(current.phase!=='review')return current.snapshot!;
    if(await db.paymentOriginalBases.count()||await db.nativePaymentActions.count())throw Error('Native payment archive sync is not enabled yet. Keep a complete JSON backup.');
    const plan=await prepareCloudUpload(await readDatabaseBackup(db),id);await this.addSnapshot(plan);
    // A second tab may have armed an older review while compression was pending.
    // Neither snapshot is discarded; the shop's original binding wins selection.
    const next=await this.review(db);if(!next.snapshot)throw reviewError();return next.snapshot;
  }
  async addSnapshot(plan:CloudUploadPlan):Promise<StoredCloudUpload>{
    const manifest=parseCloudUploadManifest(plan.manifest),chunks=[...plan.chunks];
    if(chunks.length!==manifest.chunks.length)throw new Error('Incomplete local upload snapshot.');
    for(const part of manifest.chunks)await verifyCloudUploadChunk(manifest,part.index,chunks[part.index]);
    const stored:StoredCloudUpload={id:manifest.id,businessId:manifest.businessId,manifestHash:await cloudUploadManifestHash(manifest),manifest,chunks,progress:null};
    await this.transaction('rw',this.uploads,this.reviews,async()=>{await this.uploads.add(stored);await this.reviews.put({id:reviewKey(manifest),uploadId:manifest.id});});return stored;
  }
  async readSnapshot(id:string):Promise<StoredCloudUpload>{
    const stored=await this.uploads.get(id);if(!stored)throw new Error('This upload snapshot is unavailable. Review the local shop again.');
    const manifest=parseCloudUploadManifest(stored.manifest);
    if(stored.id!==manifest.id||stored.businessId!==manifest.businessId||stored.manifestHash!==await cloudUploadManifestHash(manifest)||!Array.isArray(stored.chunks)||stored.chunks.length!==manifest.chunks.length)throw new Error('The local upload journal has changed. Keep your JSON backup.');
    if(stored.progress)stored.progress=parseCloudUploadProgress(stored.progress,manifest,stored.manifestHash);
    return {...stored,manifest,chunks:[...stored.chunks]};
  }
  async latest(businessId:string,outletId:string):Promise<StoredCloudUpload|null>{const rows=(await this.uploads.where('businessId').equals(businessId).toArray()).filter(row=>row.manifest.outletId===outletId).sort((a,b)=>b.manifest.exportedAt-a.manifest.exportedAt||b.id.localeCompare(a.id));return rows.length?this.readSnapshot(rows[0].id):null;}
  /** Follow the shop's original armed snapshot, never a newer count review. */
  async review(db:MiseDatabase):Promise<LocalUploadReview>{
    for(let attempt=0;attempt<3;attempt++){
      const before=await reviewContext(db),{scope,binding}=before,active=binding&&binding.phase!=='cancelled';
      let snapshot:StoredCloudUpload|null;
      if(active)snapshot=await this.readSnapshot(binding.uploadId);
      else {
        const selected=await this.reviews.get(reviewKey(scope));
        snapshot=selected?await this.readSnapshot(selected.uploadId):await this.latest(scope.businessId,scope.outletId);
        if(snapshot?.id===binding?.uploadId)snapshot=null;
      }
      if(snapshot){
        const manifest=snapshot.manifest;
        if(manifest.businessId!==scope.businessId||manifest.outletId!==scope.outletId||manifest.ownerId!==scope.ownerId)throw reviewError();
        if(active){
          if(snapshot.manifestHash!==binding.manifestHash)throw reviewError();
          await readCloudUpload(snapshot);
          if(binding.phase==='ready'){
            const progress=parseCloudUploadProgress({id:snapshot.id,manifestHash:snapshot.manifestHash,received:manifest.chunks.map(part=>part.index),receipt:binding.receipt},manifest,snapshot.manifestHash);
            if(JSON.stringify(progress.receipt)!==JSON.stringify(snapshot.progress?.receipt))throw reviewError();
          }
        }else if(snapshot.progress)throw reviewError();
      }
      const after=await reviewContext(db);
      if(JSON.stringify(before)!==JSON.stringify(after))continue;
      return {snapshot,phase:active?(binding.phase==='ready'?'ready':'uploading'):'review'};
    }
    throw new Error('The upload review changed in another tab. Try reading it again.');
  }
  /** Observe only Dexie reads; hashing/decoding runs outside the live query. */
  watchReview(db:MiseDatabase,next:(value:LocalUploadReview)=>void,error:()=>void):()=>void {
    let stopped=false,revision=0;
    const subscription=liveQuery(()=>Promise.all([db.cloudState.get('binding'),this.uploads.toArray(),this.reviews.toArray()])).subscribe({
      next:()=>{const current=++revision;void this.review(db).then(value=>{if(!stopped&&current===revision)next(value);}).catch(()=>{if(!stopped&&current===revision)error();});},
      error:()=>{revision++;if(!stopped)error();}
    });
    return ()=>{stopped=true;revision++;subscription.unsubscribe();};
  }
  async acknowledge(id:string,value:CloudUploadProgress):Promise<void>{
    const source=await this.readSnapshot(id),progress=parseCloudUploadProgress(value,source.manifest,source.manifestHash);
    await this.transaction('rw',this.uploads,async()=>{
      const latest=await this.uploads.get(id);if(!latest||latest.manifestHash!==source.manifestHash)throw new Error('The upload snapshot changed.');
      if(latest.progress?.receipt&&JSON.stringify(latest.progress.receipt)!==JSON.stringify(progress.receipt))throw new Error('Keep the accepted upload receipt.');
      const previous=latest.progress?parseCloudUploadProgress(latest.progress,source.manifest,source.manifestHash):null;
      const received=[...new Set([...(previous?.received??[]),...progress.received])];
      await this.uploads.update(id,{progress:parseCloudUploadProgress({...progress,received},source.manifest,source.manifestHash)});
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
/** Initial upload with a same-database fence; every later local write is retained atomically. */
export async function uploadWithLocalOutbox(db:MiseDatabase,journal:CloudUploadJournal,id:string,targetHash:string,remote:CloudUploadRemote,options:{signal?:AbortSignal;assertCurrent?:()=>void}={}){
 const snapshot=await journal.readSnapshot(id);
 // An adopted upload is immutable history. Reading its real receipt never
 // reconstructs the working copy from pre-rebase row changes or sends chunks.
 if(await db.syncCanonical.get('active')){
  const installed=await readCanonicalState(db),binding=installed.binding,operator=parseLocalOperatorState(await db.operatorState.get('active'));
  if(binding.version!==1||!installed.upload||binding.uploadId!==id||binding.targetHash!==targetHash||binding.manifestHash!==snapshot.manifestHash||!binding.receipt||operator.phase!=='active'||operator.businessId!==binding.businessId||operator.outletId!==binding.outletId||operator.actorId!==binding.ownerId||operator.connection?.targetHash!==targetHash||operator.connection.accountHash!==installed.base.snapshot.scope.accountHash)throw reviewError();
  options.signal?.throwIfAborted();const progress=parseCloudUploadProgress(await remote.begin(snapshot.manifest,snapshot.manifestHash,options.signal),snapshot.manifest,snapshot.manifestHash);options.signal?.throwIfAborted();if(!progress.receipt||syncDownloadToken(progress.receipt)!==syncDownloadToken(binding.receipt))throw reviewError();
  await db.transaction('r',db.cloudState,db.syncCanonical,db.syncApplications,db.syncAdmissions,db.operatorState,async()=>{await assertCanonicalState(db,installed);if(syncDownloadToken(await db.operatorState.get('active'))!==syncDownloadToken(operator))throw reviewError();});await journal.acknowledge(id,progress);return progress.receipt;
 }
 await beginLocalUpload(db,snapshot,targetHash);
 await assertLocalUploadCoverage(db,snapshot,targetHash);
 const receipt=await runCloudUpload(snapshot,remote,{signal:options.signal,progress:value=>journal.acknowledge(id,value),beforeCommit:async()=>{await assertLocalUploadCoverage(db,snapshot,targetHash);}});
 await acceptLocalUpload(db,snapshot,targetHash,receipt,options.assertCurrent);return receipt;
}
