import {syncImagesFixture} from './sync-images-fixture';
import {createBackup} from '../packages/core/backup';
import {cloudRecordMaps,encodeCommandRecord} from '../packages/core/cloud-records';
import {inboxImageBase64,newInboxId} from '../packages/core/inbox';
import {syncHash,type SyncReadPart} from '../packages/core/sync-read';
import {operatorAccountHash} from '../packages/core/operators';

/** Explicit synthetic transport fixture; no hosted identity or admission is claimed. */
export async function syncJoinFixture(manager=false,source?:Awaited<ReturnType<typeof syncImagesFixture>>){
 const f=structuredClone(source??await syncImagesFixture());f.window.id=newInboxId();f.target.accountHash=await operatorAccountHash('00000000-0000-4000-8000-000000000001');f.window.accountHash=f.target.accountHash;
 if(!manager){for(const page of f.pages){page.id=f.window.id;page.accountHash=f.window.accountHash;}return f;}
 const owner=f.backup.tables.members[0],member={...owner,id:newInboxId(),name:'Mina manager',role:'manager' as const,phone:'+8801812345482',outletIds:[f.target.outletId]};
 owner.active=false;owner.outletIds=[];delete owner.phone;f.backup.tables.members.push(member);f.backup=createBackup(f.backup.tables,f.backup.exportedAt);f.target.actorId=member.id;f.target.role='manager';f.window.actorId=member.id;f.window.role='manager';
 const parts:SyncReadPart[]=[];
 async function part(original:SyncReadPart,row:unknown,table=original.table){const bytes=new TextEncoder().encode(JSON.stringify(row));return {...original,table,totalBytes:bytes.length,sha256:await syncHash(bytes),offset:0,data:inboxImageBase64(bytes)};}
 for(const original of f.pages.flatMap(p=>p.parts)){
  if(original.offset!==0||atob(original.data).length!==original.totalBytes)throw Error('Expected complete small fixture records.');
  if(original.table==='member_outlets'&&original.id===owner.id)continue;
  if(original.table==='members'&&original.id===owner.id){const row=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(original.data),c=>c.charCodeAt(0))));parts.push(await part(original,Object.fromEntries(['id','business_id','created_at','updated_at','name','role'].map(k=>[k,row[k]])),'member_refs'));}else parts.push(original);
 }
 let ordinal=parts.reduce((n,p)=>BigInt(p.changeId)>n?BigInt(p.changeId):n,0n);
 const values=encodeCommandRecord('members',member,f.target.businessId).values,fields=cloudRecordMaps.members.fields as Record<string,string>,row=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,fields[k]?.startsWith('j:')&&v!==null?JSON.parse(v as string):v]));
 parts.push(await part({...parts[0],changeId:String(++ordinal),table:'members',id:member.id},row));
 parts.push(await part({...parts[0],changeId:String(++ordinal),table:'member_outlets',id:member.id},{business_id:f.target.businessId,member_id:member.id,outlet_id:f.target.outletId}));
 const {createdAt:_,expiresAt:__,...scope}=f.window;void _;void __;f.pages=[{...scope,index:0,parts,done:true,cursor:'synthetic-received-cursor'}];return f;
}
