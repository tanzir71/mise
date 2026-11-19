import Dexie from 'dexie';
import {backupTableNames,emptyBackupTables,type BackupTable} from '@mise/core/backup-tables';
import {backupToken,createBackup} from '@mise/core/backup';
import {parseLocalCloudState,type LocalCloudState,type LocalOutboxEntry} from '@mise/core/local-outbox';
import {parseShopCommand,parseShopCommandReceipt,type ShopCommand,type ShopCommandReceipt} from '@mise/core/shop-commands';
import {assertCloudUploadCurrent,cloudUploadManifestHash,readCloudUpload,type CloudUploadPlan} from '@mise/core/cloud-upload';
import {parseCloudUploadProgress,type CloudUploadReceipt} from '@mise/core/cloud-upload-runner';
import type {MiseDatabase} from './db';
import {portableInboxItems,type StoredInboxItem} from './inbox';
import {readDatabaseBackup} from './backup';
import {parseLocalOperatorState,type LocalOperatorState} from '@mise/core/operators';
import {nativeRowHash} from './canonical-writes';
import {assertCommandReceipt} from './command-request';

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
 if(state.phase!=='active'||state.businessId!==binding.businessId||state.outletId!==binding.outletId||state.actorId!==binding.ownerId||binding.version===1&&(state.role!=='owner'||state.connection&&state.connection.targetHash!==binding.targetHash)||binding.version===2&&(!join||state.role!==join.role||state.connection?.targetHash!==binding.targetHash||state.connection.accountHash!==join.accountHash||state.connection.epoch!==join.epoch||state.connection.scopeVersion!==join.scopeVersion))throw new Error('Verify the original joined operator before sending local changes.');
 return state;
}
const deliveryToken=(binding:LocalCloudState,operator:LocalOperatorState|null)=>token({binding:{...binding,sequence:0},operator});
const originalEntry=(value:LocalOutboxEntry)=>({...value,status:'pending',receipts:[]});

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
export async function deliverLocalOutbox(db:MiseDatabase,targetHash:string,send:(command:ShopCommand)=>Promise<ShopCommandReceipt>):Promise<{accepted:number;retained:number;pending:number}>{
 const {initial,operator,rows}=await db.transaction('r',db.cloudState,db.operatorState,db.outbox,async()=>{const initial=parseLocalCloudState(await db.cloudState.get('binding'));if(initial.targetHash!==targetHash||initial.phase!=='ready'||(initial.version===1?!initial.receipt:!initial.join))throw new Error('Finish the original upload or device join before sending local changes.');return {initial,operator:await joinedOperator(db,initial),rows:(await db.outbox.where('uploadId').equals(initial.uploadId).toArray()).sort((a,b)=>a.sequence-b.sequence)};});
 const originalOperator=deliveryToken(initial,operator);
 async function currentOperator(){const state=parseLocalCloudState(await db.cloudState.get('binding'));if(deliveryToken(state,await joinedOperator(db,state))!==originalOperator)throw new Error('The original operator changed. Keep the local action and its receipt unconfirmed.');return state;}
 if(rows.length!==initial.sequence||rows.some((row,index)=>row.sequence!==index+1))throw new Error('A local change is missing from the delivery queue. Keep a backup.');
 for(const row of rows){
  let saved=entry(row,initial);if(saved.status==='accepted')continue;if(saved.status==='retained')break;
  for(let index=saved.receipts.length;index<saved.commands.length;index++){
   if(index<saved.receipts.length)continue;
   const sourceHash=await nativeRowHash(originalEntry(saved));await db.transaction('r',db.cloudState,db.operatorState,currentOperator);
   const command=parseShopCommand(JSON.parse(JSON.stringify(saved.commands[index]))),confirmed=await send(command),receipt=parseShopCommandReceipt(confirmed,saved.commands[index]);assertCommandReceipt(confirmed);
   saved=await db.transaction('rw',db.cloudState,db.operatorState,db.outbox,async()=>{
    const tx=Dexie.currentTransaction;
    const state=await currentOperator();
    const current=entry((await db.outbox.get(row.id))!,state);if(await Dexie.waitFor(nativeRowHash(originalEntry(current)))!==sourceHash)throw new Error('A queued action changed. Keep its server receipt.');
    if(current.receipts[index]){if(token(current.receipts[index])!==token(receipt))throw new Error('Keep the original action receipt.');return current;}
    if(current.receipts.length!==index)throw new Error('Keep action receipts in their original order.');
    const receipts=[...current.receipts,receipt],next={...current,receipts,status:receipts.length===current.commands.length?'accepted' as const:'pending' as const};assertCommandReceipt(confirmed);if(!tx||Dexie.currentTransaction!==tx||!tx.active||tx.db!==db||tx.mode!=='readwrite')throw new Error('The receipt transaction changed. Keep the original action unconfirmed.');await db.outbox.put(next);return next;
   });
  }
 }
 const latest=await db.outbox.where('uploadId').equals(initial.uploadId).toArray();return {accepted:latest.filter(r=>r.status==='accepted').length,retained:latest.filter(r=>r.status==='retained').length,pending:latest.filter(r=>r.status==='pending').length};
}
