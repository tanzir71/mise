import {MiseDatabase} from '../apps/web/src/data/db';
import {storedInboxItems} from '../apps/web/src/data/inbox';
import {beginLocalUpload,acceptLocalUpload} from '../apps/web/src/data/local-outbox';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {createOperatorRemote} from '../apps/web/src/data/operator-remote';
import {createCloudSyncRemote} from '../apps/web/src/data/cloud-sync-remote';
import {createCloudImageRemote} from '../apps/web/src/data/cloud-image-remote';
import {createCloudCoverageRemote} from '../apps/web/src/data/cloud-coverage-remote';
import {createCloudUploadCoverageRemote} from '../apps/web/src/data/cloud-upload-coverage-remote';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../apps/web/src/data/cloud-sync-images';
import {createSyncReadHandler,createSyncReadStore} from '../supabase/functions/_shared/sync-read-handler';
import {createInboxImageHandler,ImageAccessDenied} from '../supabase/functions/_shared/inbox-image-handler';
import {backupTableNames} from '../packages/core/backup-tables';
import {cloudAuthStorageKey,cloudConnectionTarget} from '../packages/core/cloud-connection';
import {operatorAccountHash} from '../packages/core/operators';
import {inboxImageBytes,newInboxId} from '../packages/core/inbox';
import {ownerUploadDatabase,promoteOwnerUpload,ownerUploadRole,ownerUploadRpc,ownerUploadUid,installOwnerAdmissionMigration} from './owner-upload-sql-fixture';

/** SQL and handlers are real; account verification and object bytes are explicit
 * local fixtures. No hosted phone login or Storage acceptance is claimed.
 */
export async function ownerApplyFixture(cash='7',legacy=false){
 const sql=await ownerUploadDatabase(legacy),db=new MiseDatabase('owner-apply-'+newInboxId());
 try{
  const upload=await promoteOwnerUpload(sql),config={apiUrl:'https://database.test',publishableKey:'sb_publishable_test_only'},scope='owner-original',origin='https://shop.test',auth=async()=>({userId:ownerUploadUid(),jwt:'owner.1.signature'});
  if(legacy)await installOwnerAdmissionMigration(sql);
  const allowed=new Set(['admit_sync_read','prepare_sync_read','read_sync_page','read_sync_coverage','read_sync_upload_coverage','operator_context','operator_contexts']);
  const bridge:typeof fetch=async(url,init)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;if(!allowed.has(name))throw Error('Unexpected fixture RPC');try{const args=JSON.parse(init?.body as string) as Record<string,unknown>;if(Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Invalid fixture fields');const entries=Object.entries(args),data=await ownerUploadRole(sql,1,'authenticated',`select public.${name}(${entries.map(([k],i)=>k+'=>$'+(i+1)).join(',')}) data`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});}catch(error){const code=(error as {code?:string}).code;return new Response(JSON.stringify({code}),{status:code==='42501'?403:code==='PT409'?409:code==='22023'?400:503});}};
  const handler=createSyncReadHandler({origins:new Set([origin]),store:createSyncReadStore(config.apiUrl,config.publishableKey,bridge),cursorKey:'cd'.repeat(32)}),imageHandler=createInboxImageHandler({origins:new Set([origin]),store:{context:async(_jwt,id)=>{try{return await ownerUploadRpc(sql,'inbox_image_context',[id]);}catch{throw new ImageAccessDenied();}},get:async meta=>{const file=upload.files.find(f=>f.path===meta.path),image=upload.original.tables.inboxItems.flatMap(i=>i.images).find(i=>i.id===meta.id);if(!file||!image)throw Error('Missing original bytes');return inboxImageBytes(image);},put:async()=>false,complete:async()=>{throw Error('No uploads in the read fixture');}}});
  const send:typeof fetch=async(url,init)=>{const path=new URL(String(url)).pathname;if(path.startsWith('/rest/v1/rpc/'))return bridge(url,init);const headers=new Headers(init?.headers);headers.set('Origin',origin);const request=new Request(url,{...init,headers});return path==='/functions/v1/inbox-image'?imageHandler(request):handler(request);};
  const targetHash=await cloudConnectionTarget(config,scope,ownerUploadUid()),authKey=await cloudAuthStorageKey(config,scope),target={targetHash,businessId:upload.plan.manifest.businessId,outletId:upload.plan.manifest.outletId,actorId:upload.plan.manifest.ownerId,accountHash:await operatorAccountHash(ownerUploadUid()),role:'owner' as const};
  await db.transaction('rw',db.tables,async()=>{for(const table of backupTableNames)await db.table(table).bulkPut(table==='inboxItems'?storedInboxItems(upload.original.tables.inboxItems):upload.original.tables[table]);});
  await beginLocalUpload(db,upload.plan,targetHash);if(cash)await db.recordSale({expression:cash,method:'cash'});await acceptLocalUpload(db,upload.plan,targetHash,upload.receipt);
  const metadata=createOperatorRemote(config,auth,send),context=(await metadata.list()).contexts[0],refresh=()=>metadata.select(context);if(!context)throw Error('The real original owner context is missing');const selected=await selectCloudOperator(db,context,{authKey,targetHash},null,refresh);
  const read=createCloudSyncRemote(config,async()=>(await auth()).jwt,send),images=createCloudImageRemote(config,scope,auth,send),coverage=createCloudCoverageRemote(config,scope,auth,send),uploadCoverage=createCloudUploadCoverageRemote(config,scope,auth,send);
  async function stage(){const id=newInboxId(),base=await db.syncCanonical.get('active');await prepareSyncDownload(db,{id,target,previousCursor:base?.snapshot.cursor??null});await runSyncDownload(db,id,target,read);await downloadSyncImages(db,id,target,images);return {readId:id,target,authKey,expectedOperatorRevision:(await db.operatorState.get('active'))!.revision};}
  const input=await stage();return {db,sql,upload,config,scope,auth,send,target,context,selected,refresh,input,stage,coverage,uploadCoverage,close:async()=>{await db.delete();await sql.close();}};
 }catch(error){await db.delete();await sql.close();throw error;}
}
