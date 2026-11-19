import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseSyncImageDescriptor,type SyncImageDescriptor} from '@mise/core/sync-images';
import {validateInboxImageBytes} from '@mise/core/inbox';
import {syncHash} from '@mise/core/sync-read';
import {createAccountImageRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';

export interface InboxImageUploadReceipt {id:string;uploadedAt:number}
/** Complete immutable originals, pinned to the same live account as commands. */
export function createCloudInboxImageUploader(input:CloudConnection,account:CommandAccount,send:typeof fetch=fetch){
 const config=parseCloudConnection(input);
 return async(value:SyncImageDescriptor,blob:Blob,signal?:AbortSignal):Promise<InboxImageUploadReceipt>=>{
  const image=parseSyncImageDescriptor(value);
  if(!(blob instanceof Blob)||blob.size!==image.size||blob.type!==image.type)throw new CommandRequestError('review');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  try{validateInboxImageBytes(image.type,bytes);if(await syncHash(bytes)!==image.sha256)throw Error();}catch{throw new CommandRequestError('review');}
  const response=await createAccountImageRequest(config,account,image.id,send)(blob,{'Content-Type':image.type},120000,signal),receipt=response.value;
  if(!receipt||typeof receipt!=='object'||Object.keys(receipt).sort().join(',')!=='id,uploadedAt'||!('id'in receipt)||receipt.id!==image.id||!('uploadedAt'in receipt)||typeof receipt.uploadedAt!=='number'||!Number.isSafeInteger(receipt.uploadedAt)||receipt.uploadedAt<0||receipt.uploadedAt>253402300799999)throw new CommandRequestError('retry');
  response.guard();return bindCommandReceipt({id:image.id,uploadedAt:receipt.uploadedAt},response.guard);
 };
}
