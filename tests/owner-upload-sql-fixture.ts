import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {prepareCloudUpload,cloudUploadManifestHash} from '../packages/core/cloud-upload';
import {prepareCloudMigration} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {cloudUploadFixture} from './cloud-upload-fixture';
import type {CloudUploadProgress} from '../packages/core/cloud-upload-runner';

export const ownerUploadUid=(n=1)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export async function ownerUploadDatabase(legacy=false){
 const db=await PGlite.create();for(const f of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(resolve('tests/fixtures',f),'utf8'));
 const dir=resolve('supabase/migrations'),files=readdirSync(dir).filter(n=>n.endsWith('.sql')).sort(),cut=legacy?files.findIndex(f=>f.endsWith('_sync_owner_upload_admission.sql')):files.length;if(cut<0)throw Error('Missing admission migration.');for(const f of files.slice(0,cut))await db.exec(readFileSync(join(dir,f),'utf8'));
 for(const n of [1,2])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[ownerUploadUid(n),'1415555010'+n]);return db;
}
export async function installOwnerAdmissionMigration(db:PGlite){const dir=resolve('supabase/migrations'),files=readdirSync(dir).filter(n=>n.endsWith('.sql')).sort(),at=files.findIndex(n=>n.endsWith('_sync_owner_upload_admission.sql'));if(at<0)throw Error('Missing owner admission migration.');for(const file of files.slice(at))await db.exec(readFileSync(join(dir,file),'utf8'));}
export async function ownerUploadRole(db:PGlite,n:number|null,role:'authenticated'|'anon'|'service_role',query:string,args:unknown[]=[]){return db.transaction(async sql=>{await sql.exec('set local role '+role);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:ownerUploadUid(n)}:{}),user_metadata:{role:'owner'}})]);return (await sql.query<{data:unknown}>(query,args)).rows[0]?.data;});}
export const ownerUploadRpc=(db:PGlite,name:string,args:unknown[]=[],n=1)=>ownerUploadRole(db,n,'authenticated','select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') data',args);
/** Actual promotion RPC, tickets, immutable source chunks and Storage SQL metadata.
 * The Auth/Storage schemas remain explicit local fixtures, not hosted services.
 */
export async function promoteOwnerUpload(db:PGlite){
 const original=cloudUploadFixture(),plan=await prepareCloudUpload(original,newInboxId()),manifestHash=await cloudUploadManifestHash(plan.manifest),call=(name:string,args:unknown[]=[])=>ownerUploadRpc(db,name,args);
 await call('begin_initial_upload',[JSON.stringify(plan.manifest),manifestHash]);for(const part of plan.manifest.chunks)await call('put_initial_upload_chunk',[plan.manifest.id,part.index,Buffer.from(await plan.chunks[part.index].arrayBuffer()).toString('base64')]);
 const prepared=await call('prepare_initial_upload',[plan.manifest.id,manifestHash,newInboxId()]) as {leaseId:string;token:string;authUserId:string},migration=await prepareCloudMigration(original,prepared.authUserId);
 await db.query("insert into storage.buckets(id,name,public) values('mise-inbox','mise-inbox',false)");for(const record of migration.records.filter(r=>r.table==='inbox_images')){const v=record.values;await db.query("insert into storage.objects(bucket_id,name,metadata,user_metadata) values('mise-inbox',$1,$2,$3)",[[v.business_id,v.outlet_id,v.inbox_item_id,v.id].join('/'),JSON.stringify({size:v.size,mimetype:v.type}),JSON.stringify({sha256:v.sha256})]);}
 const eventId=newInboxId(),progress=await ownerUploadRole(db,null,'service_role','select public.finish_initial_upload($1,$2,$3,$4,$5) data',[plan.manifest.id,prepared.leaseId,prepared.token,JSON.stringify(migration.records),eventId]) as CloudUploadProgress;
 if(!progress.receipt)throw Error('The original fixture upload was not promoted.');return {original,plan,manifestHash,receipt:progress.receipt,progress,eventId,files:migration.files};
}
export async function ownerUploadWindow(db:PGlite,outlet:string,n=1,done=true){const id=newInboxId(),window=await ownerUploadRpc(db,'prepare_sync_read',[id,outlet,null],n);if(done){let index=0;while(true){const page=await ownerUploadRpc(db,'read_sync_page',[id,outlet,index++],n) as {done:boolean};if(page.done)break;}}return {id,window};}
