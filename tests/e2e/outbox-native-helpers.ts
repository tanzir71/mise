import type {Page} from '@playwright/test';
import {createBackup} from '../../packages/core/backup';
import {backupTableNames,type BackupTables} from '../../packages/core/backup-tables';
import {cloudUploadManifestHash,prepareCloudUpload} from '../../packages/core/cloud-upload';
import type {LocalCloudState,LocalOutboxEntry} from '../../packages/core/local-outbox';

export async function allLocalRecords(page:Page){return page.evaluate(async()=>{const name=`mise-local:${location.pathname.replace(/\/app\/.*$/,'/app/')}`,db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{const rows:Record<string,Record<string,unknown>[]>=Object.create(null);await Promise.all([...db.objectStoreNames].map(store=>new Promise<void>((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>{rows[store]=r.result;resolve();};r.onerror=()=>reject(r.error);})));return rows;}finally{db.close();}});}
export async function writeLocalRecord(page:Page,store:string,row:unknown,remove=false){await page.evaluate(async({store,row,remove})=>{const name=`mise-local:${location.pathname.replace(/\/app\/.*$/,'/app/')}`,db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');if(remove)tx.objectStore(store).delete(row as IDBValidKey);else tx.objectStore(store).put(row);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},{store,row,remove});}
/** Synthetic boundary only; never connects to hosted Auth or uploads shop data. */
export async function armLocalBoundary(page:Page){
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 const rows=await allLocalRecords(page),tables=Object.fromEntries(backupTableNames.map(table=>[table,rows[table]])) as unknown as BackupTables,plan=await prepareCloudUpload(createBackup(tables),'00000000000000000000000800'),m=plan.manifest,state:LocalCloudState={id:'binding',version:1,uploadId:m.id,businessId:m.businessId,outletId:m.outletId,ownerId:m.ownerId,targetHash:'e'.repeat(64),manifestHash:await cloudUploadManifestHash(m),phase:'uploading',sequence:0,receipt:null};await writeLocalRecord(page,'cloudState',state);return state;
}
export const localQueue=(rows:Record<string,unknown>[])=>(rows as unknown as LocalOutboxEntry[]).toSorted((a,b)=>a.sequence-b.sequence);
export function queueConstraint(state:LocalCloudState){return {id:'00000000000000000000000997',version:1,uploadId:state.uploadId,businessId:state.businessId,outletId:state.outletId,sequence:1,at:Date.now(),status:'retained',commands:[],receipts:[],changes:[]};}
