import type {BackupTable} from './backup-tables';
import type {ShopCommand,ShopCommandReceipt} from './shop-commands';
import type {CloudUploadReceipt} from './cloud-upload-runner';

export const localSchemaVersion=11;
export const localSyncTableNames=['cloudState','outbox'] as const;
export interface LocalCloudState {
 id:'binding';version:1;uploadId:string;businessId:string;outletId:string;ownerId:string;
 targetHash:string;manifestHash:string;phase:'uploading'|'ready'|'cancelled';sequence:number;receipt:CloudUploadReceipt|null;
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
 if(!object(value)||Object.keys(value).sort().join(',')!=='businessId,id,manifestHash,outletId,ownerId,phase,receipt,sequence,targetHash,uploadId,version'||value.id!=='binding'||value.version!==1||!['uploadId','businessId','outletId','ownerId'].every(k=>id(value[k]))||!hash(value.targetHash)||!hash(value.manifestHash)||!['uploading','ready','cancelled'].includes(value.phase as string)||typeof value.sequence!=='number'||!Number.isSafeInteger(value.sequence)||value.sequence<0||(value.phase==='ready'?!object(value.receipt):value.receipt!==null))throw new Error('The saved cloud connection changed. Keep your local backup.');
 if(value.receipt!==null){const receipt=value.receipt as Record<string,unknown>;if(Object.keys(receipt).sort().join(',')!=='at,businessId,id,images,outletId,records,snapshotHash'||receipt.id!==value.uploadId||receipt.businessId!==value.businessId||receipt.outletId!==value.outletId||!hash(receipt.snapshotHash)||!['at','records','images'].every(key=>typeof receipt[key]==='number'&&Number.isSafeInteger(receipt[key])&&(receipt[key] as number)>=0))throw new Error('Keep the original accepted upload receipt.');}
 return value as unknown as LocalCloudState;
}
