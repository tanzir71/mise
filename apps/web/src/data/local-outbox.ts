import Dexie from 'dexie';
import {backupTableNames,emptyBackupTables,type BackupTable} from '@mise/core/backup-tables';
import {backupToken,createBackup} from '@mise/core/backup';
import {originalCloudAdmission,parseLocalCloudState,type LocalCloudState,type LocalOutboxEntry} from '@mise/core/local-outbox';
import {parseShopCommand,parseShopCommandReceipt,type ShopCommand,type ShopCommandReceipt} from '@mise/core/shop-commands';
import {assertCloudUploadCurrent,cloudUploadManifestHash,readCloudUpload,type CloudUploadPlan} from '@mise/core/cloud-upload';
import {parseCloudUploadProgress,type CloudUploadReceipt} from '@mise/core/cloud-upload-runner';
import type {MiseDatabase} from './db';
import {portableInboxItems,type StoredInboxItem} from './inbox';
import {readDatabaseBackup} from './backup';
import {parseLocalOperatorState,type LocalOperatorState} from '@mise/core/operators';
import {nativeRowHash} from './canonical-writes';
import {assertCommandReceipt,commandReviewProof,CommandRequestError} from './command-request';
import {parseSyncActionReview,type SyncActionReview} from '@mise/core/sync-action-review';
import {savedOrderCurrency} from '@mise/core/order-currency';
import {savedMoneyCurrency} from '@mise/core/money-currency';
import {readCanonicalState} from './cloud-canonical-state';
import {syncHash} from '@mise/core/sync-read';
import {isLocalInboxRetention} from '@mise/core/local-inbox';
import type {SyncImageDescriptor} from '@mise/core/sync-images';
import type {InboxImageUploadReceipt} from './cloud-inbox-upload';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const same=(v:unknown):unknown=>Array.isArray(v)?v.map(same):object(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,same(v[key])])):v;
const token=(v:unknown)=>JSON.stringify(same(v));
function entry(value:LocalOutboxEntry,state:LocalCloudState):LocalOutboxEntry {
 if(!value||value.version!==1||value.uploadId!==state.uploadId||value.businessId!==state.businessId||value.outletId!==state.outletId||typeof value.id!=='string'||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.id)||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isSafeInteger(value.at)||value.at<0||!['retained','pending','accepted'].includes(value.status)||!Array.isArray(value.commands)||!Array.isArray(value.receipts)||!Array.isArray(value.changes)||!value.changes.length||value.receipts.length>value.commands.length)throw new Error('The saved local change queue changed. Keep a backup.');
 const commands=value.commands.map(parseShopCommand);if(commands.some(c=>c.outletId!==state.outletId)||new Set(commands.map(c=>c.id)).size!==commands.length||value.status==='retained'&&value.receipts.length||value.status!=='retained'&&!commands.length||value.status==='accepted'&&commands.length!==value.receipts.length)throw new Error('Keep the complete queued actions and receipts.');
 const receipts=value.receipts.map((receipt,index)=>parseShopCommandReceipt(receipt,commands[index]));
 for(const change of value.changes)if(!change||!(backupTableNames as readonly string[]).includes(change.table)||typeof change.key!=='string'||!change.key||![change.before,change.after].every(row=>row===null||object(row)&&row.id===change.key))throw new Error('Keep each original local record change.');
 return {...value,commands,receipts};
}
export {entry as parseLocalOutboxEntry};
function bound(state:LocalCloudState,id:string,targetHash:string,manifestHash:string,scope?:Pick<LocalCloudState,'businessId'|'outletId'|'ownerId'>){if(state.uploadId!==id||state.targetHash!==targetHash||state.manifestHash!==manifestHash||scope&&(state.businessId!==scope.businessId||state.outletId!==scope.outletId||state.ownerId!==scope.ownerId))throw new Error('Use the original account, connection and upload for this local queue.');}
async function joinedOperator(db:MiseDatabase,binding:LocalCloudState){
 const raw=await db.operatorState.get('active');if(!raw&&binding.version===1)return null;const state=parseLocalOperatorState(raw),join=binding.join;
 if(binding.version===3){const scope=binding.recovery!.scope,c=state.connection;if(state.phase!=='active'||state.businessId!==scope.businessId||state.outletId!==scope.outletId||state.actorId!==scope.actorId||state.role!==scope.role||c?.targetHash!==binding.targetHash||c.accountHash!==scope.accountHash||c.epoch!==scope.epoch||c.scopeVersion!==scope.scopeVersion)throw new Error('Verify the recovered original operator before sending local changes.');return state;}
 if(state.phase!=='active'||state.businessId!==binding.businessId||state.outletId!==binding.outletId||state.actorId!==binding.ownerId||binding.version===1&&(state.role!=='owner'||state.connection&&state.connection.targetHash!==binding.targetHash)||binding.version===2&&(!join||state.role!==join.role||state.connection?.targetHash!==binding.targetHash||state.connection.accountHash!==join.accountHash||state.connection.epoch!==join.epoch||state.connection.scopeVersion!==join.scopeVersion))throw new Error('Verify the original joined operator before sending local changes.');
 return state;
}
const deliveryToken=(binding:LocalCloudState,operator:LocalOperatorState|null)=>token({binding:{...binding,sequence:0},operator});
const originalEntry=(value:LocalOutboxEntry)=>({...value,status:'pending',receipts:[]});
function hasOriginalAdmission(binding:LocalCloudState){const original=originalCloudAdmission(binding);return binding.phase==='ready'&&(original.version===1?!!original.receipt:!!original.join);}

/** Hold the shop transaction while checking the exact reviewed source and arming its fence. */
export async function beginLocalUpload(db:MiseDatabase,plan:CloudUploadPlan,targetHash:string):Promise<LocalCloudState>{
 if(!/^[a-f0-9]{64}$/.test(targetHash))throw new Error('Use a private connection fingerprint.');
 const manifest=plan.manifest,manifestHash=await cloudUploadManifestHash(manifest);
 return db.transaction('rw',db.tables,async()=>{
  const saved=await db.cloudState.get('binding');if(saved){const state=parseLocalCloudState(saved);if(state.version!==1)throw new Error('This device joined an existing outlet. Keep its original sync admission.');if(state.phase!=='cancelled'){bound(state,manifest.id,targetHash,manifestHash,manifest);return state;}if(state.uploadId===manifest.id)throw new Error('Prepare a fresh review after cancelling this upload.');}
  await Dexie.waitFor(assertCloudUploadCurrent(manifest,await readDatabaseBackup(db)));
  const state:LocalCloudState={id:'binding',version:1,uploadId:manifest.id,businessId:manifest.businessId,outletId:manifest.outletId,ownerId:manifest.ownerId,targetHash,manifestHash,phase:'uploading',sequence:0,receipt:null};
  await db.cloudState.put(state);return state;
 });
}
async function portable(table:BackupTable,row:unknown):Promise<unknown>{if(row===null)return null;return table==='inboxItems'?(await portableInboxItems([row as StoredInboxItem]))[0]:JSON.parse(JSON.stringify(row));}

/** Prove the snapshot plus every committed local transaction reproduces the working copy. */
export async function assertLocalUploadCoverage(db:MiseDatabase,plan:CloudUploadPlan,targetHash:string):Promise<LocalCloudState>{
 const original=await readCloudUpload(plan),manifestHash=await cloudUploadManifestHash(plan.manifest);
 return db.transaction('r',db.tables,async()=>{
  const state=parseLocalCloudState(await db.cloudState.get('binding'));if(state.version!==1)throw new Error('Use the original owner upload.');bound(state,plan.manifest.id,targetHash,manifestHash,plan.manifest);
  if(state.phase==='cancelled')throw new Error('This upload was cancelled. Prepare a fresh review.');
  const queue=(await db.outbox.where('uploadId').equals(state.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence);
  if(queue.length!==state.sequence)throw new Error('A local change is missing from the upload queue. Keep a backup.');
  const maps=new Map<BackupTable,Map<string,unknown>>(backupTableNames.map(name=>[name,new Map<string,unknown>(original.tables[name].map(row=>[row.id,row]))]));
  for(let index=0;index<queue.length;index++){
   const saved=entry(queue[index],state);if(saved.sequence!==index+1)throw new Error('Keep the complete local change order.');
   for(const change of saved.changes){
    const rows=maps.get(change.table)!,before=await Dexie.waitFor(portable(change.table,change.before)),after=await Dexie.waitFor(portable(change.table,change.after));
    if(token(rows.get(change.key)??null)!==token(before))throw new Error('A queued local source changed. Keep the original snapshot and backup.');
    if(after===null)rows.delete(change.key);else rows.set(change.key,after);
   }
  }
  const tables=emptyBackupTables();for(const name of backupTableNames)Object.assign(tables,{[name]:[...maps.get(name)!.values()]});
  const projected=createBackup(tables,original.exportedAt),current=await readDatabaseBackup(db);
  if(backupToken(projected)!==backupToken(current))throw new Error('Some local records are not covered by the upload queue. Keep a backup.');
  return state;
 });
}
export async function acceptLocalUpload(db:MiseDatabase,plan:CloudUploadPlan,targetHash:string,receipt:CloudUploadReceipt,assertCurrent?:()=>void):Promise<LocalCloudState>{
 const hash=await cloudUploadManifestHash(plan.manifest),confirmed=parseCloudUploadProgress({id:plan.manifest.id,manifestHash:hash,received:plan.manifest.chunks.map(p=>p.index),receipt},plan.manifest,hash).receipt!;
 await assertLocalUploadCoverage(db,plan,targetHash);
 return db.transaction('rw',db.cloudState,async()=>{const state=parseLocalCloudState(await db.cloudState.get('binding'));bound(state,plan.manifest.id,targetHash,hash,plan.manifest);if(state.receipt&&token(state.receipt)!==token(confirmed))throw new Error('Keep the original accepted upload receipt.');const next={...state,phase:'ready' as const,receipt:confirmed};assertCurrent?.();await db.cloudState.put(next);assertCurrent?.();return next;});
}
/** Stop capture only after the server confirms that this unaccepted staging upload is cancelled. */
export async function cancelLocalUpload(db:MiseDatabase,uploadId:string,targetHash:string,remote:{cancel(id:string,signal?:AbortSignal):Promise<{id:string;canceled:true}>},signal?:AbortSignal):Promise<void>{
 const initial=parseLocalCloudState(await db.cloudState.get('binding'));if(initial.uploadId!==uploadId||initial.targetHash!==targetHash||initial.phase==='ready'||initial.receipt)throw new Error('An accepted upload cannot be cancelled. Keep its receipt and local queue.');
 if(initial.phase==='cancelled')return;
 const result=await remote.cancel(uploadId,signal);if(result.id!==uploadId||result.canceled!==true)throw new Error('Cancellation is unconfirmed. Keep the original upload and local queue.');
 await db.transaction('rw',db.cloudState,async()=>{const state=parseLocalCloudState(await db.cloudState.get('binding'));bound(state,uploadId,targetHash,initial.manifestHash);if(state.phase==='ready'||state.receipt)throw new Error('The server accepted this upload. Keep its receipt and local queue.');await db.cloudState.put({...state,phase:'cancelled'});});
}

/** Receipts are durable per intent. Retained/unclassified work stops ordered delivery. */
export async function deliverLocalOutbox(db:MiseDatabase,targetHash:string,send:(command:ShopCommand,currency?:string)=>Promise<ShopCommandReceipt>,throughCommandId?:string):Promise<{accepted:number;retained:number;pending:number}>{
 const {initial,operator,rows}=await db.transaction('r',db.cloudState,db.operatorState,db.outbox,async()=>{const initial=parseLocalCloudState(await db.cloudState.get('binding'));if(initial.targetHash!==targetHash||!hasOriginalAdmission(initial))throw new Error('Finish the original upload or device join before sending local changes.');return {initial,operator:await joinedOperator(db,initial),rows:(await db.outbox.where('uploadId').equals(initial.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence)};});
 const originalOperator=deliveryToken(initial,operator);let deliveryIdentityHash:Promise<string>|null=null;
 async function currentOperator(){const state=parseLocalCloudState(await db.cloudState.get('binding'));if(deliveryToken(state,await joinedOperator(db,state))!==originalOperator)throw new Error('The original operator changed. Keep the local action and its receipt unconfirmed.');return state;}
 if(rows.length!==initial.sequence||rows.some((row,index)=>row.sequence!==index+1))throw new Error('A local change is missing from the delivery queue. Keep a backup.');
 delivery: for(const row of rows){
  let saved=entry(row,initial);if(saved.status==='accepted')continue;
  if(isLocalInboxRetention(saved)){const original=await nativeRowHash(saved);await db.transaction('r',db.cloudState,db.operatorState,db.outbox,async()=>{await currentOperator();if(await Dexie.waitFor(nativeRowHash(entry((await db.outbox.get(saved.id))!,initial)))!==original)throw new Error('The original saved share changed. Keep its source.');});continue;}
  if(saved.status==='retained')break;
  const identityHash=await(deliveryIdentityHash??=syncHash(new TextEncoder().encode(originalOperator)));
  for(let index=saved.receipts.length;index<saved.commands.length;index++){
   if(index<saved.receipts.length)continue;
   const sourceHash=await nativeRowHash(originalEntry(saved));await db.transaction('r',db.cloudState,db.operatorState,currentOperator);
   const command=parseShopCommand(JSON.parse(JSON.stringify(saved.commands[index]))),reviewId=await syncHash(new TextEncoder().encode(JSON.stringify([initial.uploadId,command.id,identityHash])));
   let confirmed:ShopCommandReceipt;
   try{let currency:string|undefined;try{currency=savedOrderCurrency(command,saved.changes)??savedMoneyCurrency(command,saved.changes,saved.commands.slice(0,index));}catch{throw new CommandRequestError('review');}confirmed=await send(command,currency);}
   catch(error){
    const proof=commandReviewProof(error);
    if(proof){
     const commandHash=await syncHash(new TextEncoder().encode(JSON.stringify(parseShopCommand(saved.commands[index])))),receiptsHash=await nativeRowHash(saved.receipts.slice(0,index));
     if(proof.targetHash!==initial.targetHash||proof.bodyHash!==commandHash||operator?.connection&&proof.accountHash!==operator.connection.accountHash)throw new CommandRequestError('auth');
     await db.transaction('rw',db.cloudState,db.operatorState,db.outbox,db.syncActionReviews,async()=>{
      const tx=Dexie.currentTransaction,state=await currentOperator(),current=entry((await db.outbox.get(row.id))!,state);
      if(await Dexie.waitFor(nativeRowHash(originalEntry(current)))!==sourceHash||current.receipts.length<index||await Dexie.waitFor(nativeRowHash(current.receipts.slice(0,index)))!==receiptsHash)throw new Error('The rejected action source changed. Keep its original records.');
      const raw=await db.syncActionReviews.get(reviewId),previous=raw?parseSyncActionReview(raw):null,observedAt=Date.now();
      const fields={id:reviewId,version:1 as const,uploadId:initial.uploadId,entryId:current.id,commandId:command.id,businessId:initial.businessId,outletId:initial.outletId,actorId:initial.ownerId,targetHash:proof.targetHash,accountHash:proof.accountHash,identityHash,sourceHash,commandHash,receiptsHash,commandIndex:index,sequence:current.sequence};
      if(previous&&Object.entries(fields).some(([key,value])=>previous[key as keyof typeof previous]!==value))throw new Error('Keep the original rejected action review.');
      const lastObservedAt=Math.max(observedAt,previous?.lastObservedAt??0),receipt=current.receipts[index],receiptHash=receipt?await Dexie.waitFor(nativeRowHash(receipt)):null;
      if(previous?.receiptHash&&previous.receiptHash!==receiptHash)throw new Error('Keep the original confirmed action receipt.');
      const next=parseSyncActionReview({...fields,status:previous?.status??proof.status,firstObservedAt:previous?.firstObservedAt??observedAt,lastObservedAt,observations:(previous?.observations??0)+1,confirmedAt:receipt?Math.max(lastObservedAt,previous?.confirmedAt??0):null,receiptHash});
      proof.assertCurrent();if(!tx||Dexie.currentTransaction!==tx||!tx.active||tx.db!==db||tx.mode!=='readwrite')throw new Error('The action review transaction changed. Keep its source unconfirmed.');
      await db.syncActionReviews.put(next);proof.assertCurrent();
     });
    }
    throw error;
   }
   const receipt=parseShopCommandReceipt(confirmed,saved.commands[index]);assertCommandReceipt(confirmed);
   if(receipt.type==='command.resolved'&&(receipt.sourceHash!==sourceHash||receipt.commandHash!==await syncHash(new TextEncoder().encode(JSON.stringify(command)))))throw new CommandRequestError('review');
   saved=await db.transaction('rw',db.cloudState,db.operatorState,db.outbox,db.syncActionReviews,async()=>{
    const tx=Dexie.currentTransaction;
    const state=await currentOperator();
    const current=entry((await db.outbox.get(row.id))!,state);if(await Dexie.waitFor(nativeRowHash(originalEntry(current)))!==sourceHash)throw new Error('A queued action changed. Keep its server receipt.');
    if(current.receipts[index]&&token(current.receipts[index])!==token(receipt))throw new Error('Keep the original action receipt.');
    const review=await db.syncActionReviews.get(reviewId);let confirmedReview:SyncActionReview|undefined;
    if(review){const original=parseSyncActionReview(review);if(original.entryId!==current.id||original.commandId!==command.id||original.sourceHash!==sourceHash||original.identityHash!==identityHash||original.commandIndex!==index)throw new Error('Keep the original action review source.');const receiptHash=await Dexie.waitFor(nativeRowHash(receipt));if(original.receiptHash&&original.receiptHash!==receiptHash)throw new Error('Keep the original confirmed action review receipt.');confirmedReview=parseSyncActionReview({...original,confirmedAt:original.confirmedAt??Math.max(Date.now(),original.lastObservedAt),receiptHash});}
    const alreadyConfirmed=!!current.receipts[index];
    if(!alreadyConfirmed&&current.receipts.length!==index)throw new Error('Keep action receipts in their original order.');
    const receipts=alreadyConfirmed?current.receipts:[...current.receipts,receipt],next={...current,receipts,status:receipts.length===current.commands.length?'accepted' as const:'pending' as const};
    const writable=()=>{assertCommandReceipt(confirmed);if(!tx||Dexie.currentTransaction!==tx||!tx.active||tx.db!==db||tx.mode!=='readwrite')throw new Error('The receipt transaction changed. Keep the original action unconfirmed.');};
    writable();if(confirmedReview){await db.syncActionReviews.put(confirmedReview);writable();}if(!alreadyConfirmed){await db.outbox.put(next);writable();}return next;
   });
   if(command.id===throughCommandId)break delivery;
  }
 }
 const latest=await db.outbox.where('uploadId').equals(initial.uploadId).toArray();return {accepted:latest.filter(r=>r.status==='accepted').length,retained:latest.filter(r=>r.status==='retained'&&!isLocalInboxRetention(r)).length,pending:latest.filter(r=>r.status==='pending').length};
}
/** Read the actual retained source, offline, for this original active operator.
 * Observations and local hashes never authorize replacement or disposal. */
export async function localReviewIdentity(db:MiseDatabase){
 const binding=parseLocalCloudState(await db.cloudState.get('binding'));
 if(!hasOriginalAdmission(binding))throw new Error('Use the original admitted outlet to review saved actions.');
 const operator=await joinedOperator(db,binding),identityHash=await Dexie.waitFor(syncHash(new TextEncoder().encode(deliveryToken(binding,operator))));
 return {binding,identityHash};
}
export async function readLocalActionReviews(db:MiseDatabase):Promise<{review:SyncActionReview;entry:LocalOutboxEntry;command:ShopCommand}[]> {
 return db.transaction('r',db.cloudState,db.operatorState,db.outbox,db.syncActionReviews,async()=>{
  const binding=parseLocalCloudState(await db.cloudState.get('binding'));
  if(!hasOriginalAdmission(binding))throw new Error('Use the original admitted outlet to review saved actions.');
  const operator=await joinedOperator(db,binding),identityHash=await Dexie.waitFor(syncHash(new TextEncoder().encode(deliveryToken(binding,operator))));
  const observations=await db.syncActionReviews.where('uploadId').equals(binding.uploadId).filter(row=>row.identityHash===identityHash).toArray(),result=[];
  for(const raw of observations){
   const review=parseSyncActionReview(raw),saved=entry((await db.outbox.get(review.entryId))!,binding),command=saved.commands[review.commandIndex];
   if(!command||review.commandId!==command.id||review.businessId!==binding.businessId||review.outletId!==binding.outletId||review.actorId!==binding.ownerId||review.targetHash!==binding.targetHash||operator?.connection&&review.accountHash!==operator.connection.accountHash||review.sequence!==saved.sequence||
    review.id!==await Dexie.waitFor(syncHash(new TextEncoder().encode(JSON.stringify([binding.uploadId,command.id,identityHash]))))||
    review.sourceHash!==await Dexie.waitFor(nativeRowHash(originalEntry(saved)))||review.commandHash!==await Dexie.waitFor(syncHash(new TextEncoder().encode(JSON.stringify(command))))||review.receiptsHash!==await Dexie.waitFor(nativeRowHash(saved.receipts.slice(0,review.commandIndex)))||
    review.receiptHash!==null&&(!saved.receipts[review.commandIndex]||review.receiptHash!==await Dexie.waitFor(nativeRowHash(saved.receipts[review.commandIndex]))))throw new Error('Keep the complete original action review, source and receipts.');
   result.push({review,entry:saved,command});
  }
  return result.sort((a,b)=>a.entry.sequence-b.entry.sequence||a.review.commandIndex-b.review.commandIndex);
 });
}
/** Image bytes follow their accepted metadata. Retries retain every original queue record. */
export async function deliverLocalInboxImages(db:MiseDatabase,targetHash:string,put:(image:SyncImageDescriptor,blob:Blob,signal?:AbortSignal)=>Promise<InboxImageUploadReceipt>,signal?:AbortSignal):Promise<number>{
 const initial=parseLocalCloudState(await db.cloudState.get('binding'));
 if(initial.targetHash!==targetHash||!hasOriginalAdmission(initial))throw new Error('Use the original image connection.');
 const originalScope=deliveryToken(initial,await joinedOperator(db,initial));
 const rows=await db.outbox.where('uploadId').equals(initial.uploadId).sortBy('sequence');
 if(rows.length!==initial.sequence||rows.some((row,index)=>row.sequence!==index+1))throw new Error('Keep the complete original image queue.');
 if(!rows.some(row=>row.commands.some(command=>command.type==='inbox.capture'&&command.input.images.length)))return 0;
 const canonical=await db.syncCanonical.get('active')?await readCanonicalState(db):null;
 if(!canonical&&initial.version!==1)throw new Error('Keep the original device admission.');
 let delivered=0;
 for(const raw of rows){
  const saved=entry(raw,initial);let sourceHash:string|undefined;
  for(const [index,command] of saved.commands.entries()){
   if(command.type!=='inbox.capture'||!command.input.images.length)continue;
   if(!saved.receipts[index])throw new Error('Confirm the original image metadata before sending its bytes.');
   const source=saved.changes.find(change=>change.table==='inboxItems'&&change.key===command.itemId)?.after as StoredInboxItem|undefined;
   if(!source||source.outletId!==initial.outletId||source.id!==command.itemId||source.images.length!==command.input.images.length)throw new Error('Keep the complete original image source.');
   async function current(){
    signal?.throwIfAborted();
    return db.transaction('r',db.cloudState,db.operatorState,db.outbox,async()=>{
     const state=parseLocalCloudState(await db.cloudState.get('binding'));
     if(deliveryToken(state,await joinedOperator(db,state))!==originalScope)throw new Error('The original image operator changed.');
     const row=entry((await db.outbox.get(saved.id))!,state);
     if(await Dexie.waitFor(nativeRowHash(originalEntry(row)))!==sourceHash||!row.receipts[index])throw new Error('Keep the original image action and receipt.');
    });
   }
   for(const [position,image] of command.input.images.entries()){
    const confirmed=canonical?.base.snapshot.records.find(row=>row.table==='inbox_images'&&row.id===image.id&&row.operation==='upsert')?.row;
    if(confirmed&&confirmed.business_id===initial.businessId&&confirmed.outlet_id===initial.outletId&&confirmed.inbox_item_id===command.itemId&&confirmed.position===position&&confirmed.sha256===image.sha256&&confirmed.size===image.size&&confirmed.type===image.type&&typeof confirmed.uploaded_at==='number')continue;
    sourceHash??=await nativeRowHash(originalEntry(saved));
    await current();const stored=source.images[position];
    if(!stored||stored.id!==image.id||stored.name!==image.name||stored.size!==image.size||stored.type!==image.type||!(stored.blob instanceof Blob)||stored.blob.size!==image.size||stored.blob.type!==image.type||await syncHash(new Uint8Array(await stored.blob.arrayBuffer()))!==image.sha256)throw new Error('Keep the complete original image bytes.');
    const receipt=await put({id:image.id,businessId:initial.businessId,outletId:initial.outletId,inboxId:command.itemId,type:image.type,size:image.size,sha256:image.sha256},stored.blob,signal);
    if(receipt.id!==image.id||!Number.isSafeInteger(receipt.uploadedAt)||receipt.uploadedAt<0)throw new Error('The original image upload is unconfirmed.');
    await current();assertCommandReceipt(receipt);delivered++;
   }
  }
 }
 return delivered;
}
