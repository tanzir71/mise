import {backupCounts,backupToken,parseBackup,type BackupCounts} from './backup.ts';
import {MAX_BACKUP_BYTES,backupTableNames,type MiseBackup} from './backup-tables.ts';

export const CLOUD_UPLOAD_CHUNK_BYTES=256*1024;
export const CLOUD_UPLOAD_MAX_CHUNK_BYTES=384*1024;
export interface CloudUploadChunk {index:number;rawBytes:number;bytes:number;sha256:string}
/** Only ASCII scope/integrity metadata; customer text stays inside compressed chunks. */
export interface CloudUploadManifest {
  version:1;id:string;businessId:string;outletId:string;ownerId:string;exportedAt:number;
  counts:BackupCounts;records:number;images:number;imageBytes:number;
  snapshotBytes:number;snapshotHash:string;reviewHash:string;chunks:CloudUploadChunk[];
}
export interface CloudUploadPlan {manifest:CloudUploadManifest;chunks:Blob[]}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const integer=(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const ulid=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
export async function cloudUploadHash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');}
const textHash=(text:string)=>cloudUploadHash(new TextEncoder().encode(text));

/** Parse into a canonical field order before hashing or trusting server progress. */
export function parseCloudUploadManifest(value:unknown):CloudUploadManifest {
  if(!object(value)||!keys(value,['version','id','businessId','outletId','ownerId','exportedAt','counts','records','images','imageBytes','snapshotBytes','snapshotHash','reviewHash','chunks'])||value.version!==1||!ulid(value.id)||!ulid(value.businessId)||!ulid(value.outletId)||!ulid(value.ownerId)||!integer(value.exportedAt,8640000000000000)||!object(value.counts)||!keys(value.counts,[...backupTableNames])||!integer(value.records)||!integer(value.images)||!integer(value.imageBytes,MAX_BACKUP_BYTES)||!integer(value.snapshotBytes,MAX_BACKUP_BYTES)||value.snapshotBytes===0||!digest(value.snapshotHash)||!digest(value.reviewHash)||!Array.isArray(value.chunks))throw new Error('Invalid cloud upload manifest.');
  const counts={} as BackupCounts;let records=0;
  for(const name of backupTableNames){const count=value.counts[name];if(!integer(count))throw new Error('Invalid upload counts.');counts[name]=count;records+=count;}
  if(!Number.isSafeInteger(records)||records!==value.records||counts.businesses!==1||counts.outlets!==1||counts.members!==1)throw new Error('Review one local shop and owner before uploading.');
  const total=value.snapshotBytes,parts=Math.ceil(total/CLOUD_UPLOAD_CHUNK_BYTES);
  if(value.chunks.length!==parts)throw new Error('Incomplete upload chunk manifest.');
  const chunks=Array.from(value.chunks,(chunk,index)=>{
    const rawBytes=Math.min(CLOUD_UPLOAD_CHUNK_BYTES,total-index*CLOUD_UPLOAD_CHUNK_BYTES);
    if(!object(chunk)||!keys(chunk,['index','rawBytes','bytes','sha256'])||chunk.index!==index||chunk.rawBytes!==rawBytes||!integer(chunk.bytes,CLOUD_UPLOAD_MAX_CHUNK_BYTES)||chunk.bytes===0||!digest(chunk.sha256))throw new Error('Invalid cloud upload chunk.');
    return {index,rawBytes,bytes:chunk.bytes,sha256:chunk.sha256};
  });
  const result:CloudUploadManifest={version:1,id:value.id,businessId:value.businessId,outletId:value.outletId,ownerId:value.ownerId,exportedAt:value.exportedAt,counts,records,images:value.images,imageBytes:value.imageBytes,snapshotBytes:total,snapshotHash:value.snapshotHash,reviewHash:value.reviewHash,chunks};
  Object.freeze(counts);chunks.forEach(Object.freeze);Object.freeze(chunks);return Object.freeze(result);
}
export async function cloudUploadManifestHash(manifest:CloudUploadManifest){return textHash(JSON.stringify(parseCloudUploadManifest(manifest)));}
function summary(backup:MiseBackup){
  const t=backup.tables;
  if(t.businesses.length!==1||t.outlets.length!==1||t.members.length!==1||!t.members[0].active||t.members[0].role!=='owner')throw new Error('Set up one local shop and owner before turning on sync.');
  if(t.inboxItems.some(item=>item.outletId===null))throw new Error('Claim pending Inbox items before turning on sync.');
  const counts=backupCounts(backup),images=t.inboxItems.flatMap(item=>item.images);
  return {businessId:t.businesses[0].id,outletId:t.outlets[0].id,ownerId:t.members[0].id,exportedAt:backup.exportedAt,counts,records:Object.values(counts).reduce((a,b)=>a+b,0),images:images.length,imageBytes:images.reduce((n,image)=>n+image.size,0)};
}
async function compress(bytes:Uint8Array):Promise<Blob>{
  if(typeof CompressionStream==='undefined')throw new Error('Update this browser to prepare uploads. Keep a JSON backup.');
  return new Response(new Blob([new Uint8Array(bytes).buffer]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
/** Snapshot synchronously before the first await; later device edits cannot alter it. */
export async function prepareCloudUpload(source:MiseBackup,id:string):Promise<CloudUploadPlan>{
  if(!ulid(id))throw new Error('Use a valid upload ID.');
  parseBackup(source);const text=JSON.stringify(source),backup=parseBackup(text),info=summary(backup),bytes=new TextEncoder().encode(text);
  const reviewText=backupToken(backup),chunks:Blob[]=[],parts:CloudUploadChunk[]=[];
  for(let offset=0;offset<bytes.length;offset+=CLOUD_UPLOAD_CHUNK_BYTES){
    const raw=bytes.subarray(offset,offset+CLOUD_UPLOAD_CHUNK_BYTES),blob=await compress(raw),data=new Uint8Array(await blob.arrayBuffer());
    parts.push({index:parts.length,rawBytes:raw.byteLength,bytes:data.byteLength,sha256:await cloudUploadHash(data)});chunks.push(blob);
  }
  const manifest=parseCloudUploadManifest({version:1,id,...info,snapshotBytes:bytes.byteLength,snapshotHash:await cloudUploadHash(bytes),reviewHash:await textHash(reviewText),chunks:parts});
  Object.freeze(chunks);return Object.freeze({manifest,chunks});
}
export async function verifyCloudUploadChunk(manifest:CloudUploadManifest,index:number,blob:Blob):Promise<void>{
  const part=manifest.chunks[index];if(!part||part.index!==index||!(blob instanceof Blob)||blob.size!==part.bytes||await cloudUploadHash(new Uint8Array(await blob.arrayBuffer()))!==part.sha256)throw new Error('An upload chunk changed. Keep the original snapshot.');
}
async function expand(blob:Blob,limit:number):Promise<Uint8Array>{
  if(typeof DecompressionStream==='undefined')throw new Error('Compressed uploads are unavailable.');
  const reader=blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader(),parts:Uint8Array[]=[];let length=0;
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>limit)throw new Error('Expanded upload exceeds its reviewed size.');parts.push(part.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  if(length!==limit)throw new Error('Incomplete expanded upload.');const result=new Uint8Array(length);let at=0;for(const part of parts){result.set(part,at);at+=part.length;}return result;
}
/** Receiver-side verification, before any domain record may be promoted. */
export async function readCloudUpload(input:CloudUploadPlan):Promise<MiseBackup>{
  const manifest=parseCloudUploadManifest(input.manifest),chunks=[...input.chunks];if(chunks.length!==manifest.chunks.length)throw new Error('Incomplete cloud upload.');
  const bytes=new Uint8Array(manifest.snapshotBytes);let offset=0;
  for(const part of manifest.chunks){await verifyCloudUploadChunk(manifest,part.index,chunks[part.index]);const raw=await expand(chunks[part.index],part.rawBytes);bytes.set(raw,offset);offset+=raw.length;}
  if(await cloudUploadHash(bytes)!==manifest.snapshotHash)throw new Error('The uploaded snapshot has changed.');
  const backup=parseBackup(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),info=summary(backup);
  if(JSON.stringify(info)!==JSON.stringify({businessId:manifest.businessId,outletId:manifest.outletId,ownerId:manifest.ownerId,exportedAt:manifest.exportedAt,counts:manifest.counts,records:manifest.records,images:manifest.images,imageBytes:manifest.imageBytes})||await textHash(backupToken(backup))!==manifest.reviewHash)throw new Error('The uploaded data does not match its review.');
  return backup;
}
export async function assertCloudUploadCurrent(manifest:CloudUploadManifest,current:MiseBackup):Promise<void>{
  parseBackup(current);if(await textHash(backupToken(current))!==manifest.reviewHash)throw new Error('This browser’s data changed. Review the latest data before turning on sync.');
}
