import type {BackupTable} from './backup-tables';
import type {ShopCommand,ShopCommandReceipt} from './shop-commands';
import type {CloudUploadReceipt} from './cloud-upload-runner';
import {parseSyncScope,type SyncScope} from './sync-read';
import {syncDownloadToken} from './sync-download';

export const localSchemaVersion=30;
export const localSyncTableNames=['cloudState','outbox'] as const;
export interface LocalCloudState {
 /** uploadId/ownerId are legacy names for the fence identity and selected actor. */
 id:'binding';version:1|2|3;uploadId:string;businessId:string;outletId:string;ownerId:string;
 targetHash:string;manifestHash:string;phase:'uploading'|'ready'|'cancelled';sequence:number;receipt:CloudUploadReceipt|null;
 join?:{kind:'join';readId:string;readSeal:string;cursor:string;accountHash:string;role:'owner'|'manager';epoch:string;scopeVersion:string};
 /** Original admission stays intact when an existing working outlet changes scope. */
 origin?:LocalCloudState;
 recovery?:{id:string;hash:string;scope:SyncScope};
}
/** Recovery evidence only. These row changes must never be sent to a raw-write API. */
export interface LocalRowChange {table:BackupTable;key:string;before:unknown|null;after:unknown|null}
export interface LocalOutboxEntry {
 id:string;version:1;uploadId:string;businessId:string;outletId:string;sequence:number;at:number;
 status:'retained'|'pending'|'accepted';commands:ShopCommand[];receipts:ShopCommandReceipt[];changes:LocalRowChange[];
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parseLocalCloudState(value:unknown):LocalCloudState {
 if(object(value)&&value.version===3){
  const {origin,recovery,...fields}=value;
  if(!object(origin)||![1,2].includes(origin.version as number)||!object(recovery)||Object.keys(recovery).sort().join(',')!=='hash,id,scope'||!id(recovery.id)||!hash(recovery.hash)||!object(recovery.scope)||Object.keys(recovery.scope).sort().join(',')!=='accountHash,actorId,businessId,epoch,outletId,role,scopeVersion')throw new Error('Keep the original scope recovery admission.');
  const original=parseLocalCloudState(origin),current=parseLocalCloudState({...fields,version:original.version}),scope=parseSyncScope(recovery.scope);
  if(original.phase!=='ready'||current.phase!=='ready'||current.sequence<original.sequence||syncDownloadToken({...current,sequence:0})!==syncDownloadToken({...original,sequence:0})||scope.businessId!==current.businessId||scope.outletId!==current.outletId||scope.actorId!==current.ownerId||original.join&&scope.accountHash!==original.join.accountHash)throw new Error('Keep the original outlet, account and admission.');
  return {...current,version:3,origin:original,recovery:{id:recovery.id,hash:recovery.hash,scope}};
 }
 if(object(value)&&value.version===2){
  const {join,...legacy}=value;
  if(!object(join)||Object.keys(join).sort().join(',')!=='accountHash,cursor,epoch,kind,readId,readSeal,role,scopeVersion'||join.kind!=='join'||join.readId!==value.uploadId||!hash(join.readSeal)||!hash(join.accountHash)||!['owner','manager'].includes(join.role as string)||typeof join.cursor!=='string'||!join.cursor.length||join.cursor.length>131072||![join.epoch,join.scopeVersion].every(v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))||value.phase!=='ready'||value.receipt!==null)throw new Error('Keep the original joined-device admission.');
  // Validate all shared fence fields through the unchanged v1 parser, without
  // inventing an upload receipt. A joined device has its own admission evidence.
  parseLocalCloudState({...legacy,version:1,phase:'uploading'});return value as unknown as LocalCloudState;
 }
 if(!object(value)||Object.keys(value).sort().join(',')!=='businessId,id,manifestHash,outletId,ownerId,phase,receipt,sequence,targetHash,uploadId,version'||value.id!=='binding'||value.version!==1||!['uploadId','businessId','outletId','ownerId'].every(k=>id(value[k]))||!hash(value.targetHash)||!hash(value.manifestHash)||!['uploading','ready','cancelled'].includes(value.phase as string)||typeof value.sequence!=='number'||!Number.isSafeInteger(value.sequence)||value.sequence<0||(value.phase==='ready'?!object(value.receipt):value.receipt!==null))throw new Error('The saved cloud connection changed. Keep your local backup.');
 if(value.receipt!==null){const receipt=value.receipt as Record<string,unknown>;if(Object.keys(receipt).sort().join(',')!=='at,businessId,id,images,outletId,records,snapshotHash'||receipt.id!==value.uploadId||receipt.businessId!==value.businessId||receipt.outletId!==value.outletId||!hash(receipt.snapshotHash)||!['at','records','images'].every(key=>typeof receipt[key]==='number'&&Number.isSafeInteger(receipt[key])&&(receipt[key] as number)>=0))throw new Error('Keep the original accepted upload receipt.');}
 return value as unknown as LocalCloudState;
}
export function originalCloudAdmission(binding:LocalCloudState):LocalCloudState {return binding.version===3?parseLocalCloudState(binding.origin):binding;}
