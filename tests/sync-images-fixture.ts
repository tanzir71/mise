import {reportBackupFixture,REPORT_AT} from './report-backup-fixture';
import {captureInboxCommand,inboxImageBase64,newInboxId} from '../packages/core/inbox';
import {createBackup} from '../packages/core/backup';
import {syncHash} from '../packages/core/sync-read';
import {syncDownloadFixture} from './sync-download-fixture';
import {inboxPng} from './inbox-fixture';

/** Full metadata and original bytes, never a signed-in hosted account. */
export async function syncImagesFixture(options:{count?:number;size?:number}={}){
 const backup=reportBackupFixture(),t=backup.tables,setup={business:t.businesses[0],outlet:t.outlets[0],owner:t.members[0]},bytes=new Uint8Array(options.size??inboxPng.length);bytes.set(inboxPng);
 const captured=captureInboxCommand({title:'Original image sources',text:'Keep the original images.\0\ud800',url:'',images:Array.from({length:options.count??2},(_,index)=>({id:newInboxId(REPORT_AT),name:`তালিকা ${index}\0\ud800.png`,type:'image/png' as const,size:bytes.length,data:inboxImageBase64(bytes)}))},setup,REPORT_AT);
 t.inboxItems.push(captured.item);if(captured.event)t.events.push(captured.event);const fixture=await syncDownloadFixture({source:createBackup(t,REPORT_AT)});
 return {...fixture,imageBytes:bytes,imageIds:captured.item.images.map(i=>i.id),inboxId:captured.item.id};
}
/** Rewrite a complete synthetic image record, retaining a valid wire hash. */
export async function rewriteImagePart(f:Awaited<ReturnType<typeof syncImagesFixture>>,change:(row:Record<string,unknown>)=>Record<string,unknown>|null){
 for(const page of f.pages)for(const part of page.parts){if(part.table!=='inbox_images')continue;if(part.offset!==0||part.totalBytes!==atob(part.data).length)throw Error('Expected a complete small image descriptor.');const row=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.data),c=>c.charCodeAt(0)))),value=change(row),bytes=new TextEncoder().encode(JSON.stringify(value));part.data=inboxImageBase64(bytes);part.sha256=await syncHash(bytes);part.totalBytes=bytes.length;if(value===null)part.operation='delete';}
}
