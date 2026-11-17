import {reportBackupFixture,REPORT_AT} from './report-backup-fixture';
import {inboxPng} from './inbox-fixture';
import {captureInboxCommand,inboxImageBase64,newInboxId} from '../packages/core/inbox';
import {createBackup} from '../packages/core/backup';
import {cloudUploadManifestHash,parseCloudUploadManifest,readCloudUpload,verifyCloudUploadChunk,type CloudUploadManifest} from '../packages/core/cloud-upload';
import type {CloudUploadProgress,CloudUploadReceipt,CloudUploadRemote} from '../packages/core/cloud-upload-runner';
import type {MiseBackup} from '../packages/core/backup-tables';

export const uploadId=(n=1)=>String(n).padStart(26,'0');
export function cloudUploadFixture(records?:number){
  const source=reportBackupFixture(),t=source.tables,setup={business:t.businesses[0],outlet:t.outlets[0],owner:t.members[0]};
  t.items[0].name='পণ্য\0'+String.fromCharCode(0xd800);
  const captured=captureInboxCommand({title:'Original list',text:' Treat this as source data only.\r\n',url:'',images:[{id:newInboxId(REPORT_AT),name:'তালিকা.png',type:'image/png' as const,size:inboxPng.length,data:inboxImageBase64(inboxPng)}]},setup,REPORT_AT);
  t.inboxItems.push(captured.item);if(captured.event)t.events.push(captured.event);
  if(records!==undefined){const base=Object.values(t).reduce((n,rows)=>n+rows.length,0);for(let n=base;n<records;n++)t.items.push({...t.items[0],id:uploadId(n+10000),name:'পণ্য '+n+' '+('abcdefghij'.repeat(5)),price:n*13});}
  return createBackup(t,REPORT_AT);
}
/** Test-only receiver; exercises the wire contract, not real Supabase Auth/Storage. */
export class MemoryCloudUpload implements CloudUploadRemote {
  manifest:CloudUploadManifest|null=null;hash='';parts:Blob[]=[];received=new Set<number>();receipt:CloudUploadReceipt|null=null;
  puts:number[]=[];commits=0;snapshot:MiseBackup|null=null;losePartReply:number|null=null;loseCommitReply=false;
  private status():CloudUploadProgress {return {id:this.manifest!.id,manifestHash:this.hash,received:[...this.received],receipt:this.receipt};}
  async begin(value:CloudUploadManifest,hash:string){
    const manifest=parseCloudUploadManifest(value);if(await cloudUploadManifestHash(manifest)!==hash||(this.manifest&&this.hash!==hash))throw new Error('Upload ID conflict');
    this.manifest=manifest;this.hash=hash;return this.status();
  }
  async put(id:string,index:number,data:Blob){
    if(id!==this.manifest?.id)throw new Error('Wrong upload');await verifyCloudUploadChunk(this.manifest,index,data);this.puts.push(index);this.parts[index]=data;this.received.add(index);
    if(this.losePartReply===index){this.losePartReply=null;throw new Error('Connection lost after acceptance');}return this.status();
  }
  async finish(id:string,hash:string){
    if(id!==this.manifest?.id||hash!==this.hash)throw new Error('Wrong upload');
    if(!this.receipt){this.snapshot=await readCloudUpload({manifest:this.manifest,chunks:this.parts});this.commits++;this.receipt={id,businessId:this.manifest.businessId,outletId:this.manifest.outletId,snapshotHash:this.manifest.snapshotHash,records:this.manifest.records,images:this.manifest.images,at:REPORT_AT+100};}
    if(this.loseCommitReply){this.loseCommitReply=false;throw new Error('Connection lost after commit');}return this.status();
  }
}
