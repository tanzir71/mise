import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {prepareSavedCustomerReview,decideSavedCustomerReview,readCustomerReviewWorkspace,hasSavedCustomerReview} from '../apps/web/src/data/customer-review-session';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {prepareCustomerReviewSource} from '../apps/web/src/data/customer-review-source';
import type {CommandAuthorization} from '../apps/web/src/data/command-request';
import {customerFingerprint,type CustomerCommandReceipt} from '../packages/core/customer-commands';
import type {CustomerReviewRequest} from '../packages/core/customer-review-source';
import {reviewedCustomerProposal,type CustomerResolutionReceipt} from '../packages/core/customer-review';
import {syncHash} from '../packages/core/sync-read';
import {syncDownloadToken} from '../packages/core/sync-download';
import {backupToken} from '../packages/core/backup';
import {localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {testCommandAccount} from './command-account-fixture';
import {input,terms,reviewView,ordinaryCustomerReceipt} from './customer-review-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},databases:Dexie[]=[];
const withdraw={outcome:'withdrawn' as const},replacement={outcome:'replaced' as const};
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});
/** Native journal tests use a synthetic gateway; the completion suite separately
 * verifies the same protocol and exact deployment bundle against PostgreSQL. */
async function boot(group=false){
 const db=new MiseDatabase('mise-customer-review-'+randomUUID()),journal=new CloudUploadJournal('mise-customer-review-upload-'+randomUUID());databases.push(db,journal);const source=cloudUploadFixture();await db.restoreBackup(source,await db.previewRestore(source));
 const customer=await db.saveCustomer({...input,name:'Before review',notes:'Original canonical note',tags:[]}),account=(await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0],setup=(await db.setup())!;
 let authorization:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};
 const runtime={...testCommandAccount(config,async()=>authorization.jwt),getAuth:async()=>({...authorization}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==authorization.generation||value.userId!==authorization.userId)throw Error('Original account changed');}};
 const plan=await journal.prepare(db,uploadId());await uploadWithLocalOutbox(db,journal,plan.manifest.id,runtime.targetHash,new MemoryCloudUpload());
 await db.transaction('rw',db.tables,async()=>{if(group)await db.saveCustomer({...input,name:'Earlier grouped edit'},{id:customer.id,credit:terms});await db.saveCustomer(input,{id:customer.id,credit:terms});});
 if(group){const row=(await db.outbox.toArray())[0],packet=await prepareCustomerReviewSource(row,0,uploadId(91),uploadId(92)),receipt=ordinaryCustomerReceipt({setup,customer,account,command:packet.command,packet,events:[],row});await deliverLocalOutbox(db,runtime.targetHash,async()=>receipt,packet.command.id);}
 const original=await db.outbox.toArray(),backup=backupToken(await db.readBackup());await expect(deliverLocalOutbox(db,runtime.targetHash,createCloudCommandRemote(config,runtime,async()=>new Response('Private provider detail',{status:409})))).rejects.toMatchObject({kind:'review'});
 const workspace=await readCustomerReviewWorkspace(db);if(!workspace)throw Error('Expected the actual rejected customer action');
 let current=customer,lost=false,offline=false,calls=0,done:CustomerCommandReceipt|CustomerResolutionReceipt|null=null,onRead:(()=>Promise<void>)|null=null,onResolve:(()=>Promise<void>)|null=null;
 const build=(packet:CustomerReviewRequest)=>({setup,customer,account,command:packet.command,packet,events:[],row:original[0]});
 const send:typeof fetch=async(url,init)=>{
  if(offline)throw Error('Synthetic offline');const packet=JSON.parse(String(init?.body)) as CustomerReviewRequest&{outcome:'withdrawn'|'replaced'},mode=new URL(String(url)).searchParams.get('review'),c=packet.command;
  if(!mode)return done?Response.json(done):new Response('Private detail',{status:409});
  if(mode==='customer-resolve'){
   calls++;const next=reviewedCustomerProposal(c,packet.replacementId),receipt=packet.outcome==='withdrawn'?null:ordinaryCustomerReceipt(build(packet),next);done={id:packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,customerId:c.customerId,outletId:c.outletId,commandHash:await customerFingerprint(c),sourceHash:packet.sourceHash,at:Math.max(Date.now(),receipt?.at??0),outcome:packet.outcome,replacement:receipt?{id:next.id,commandHash:await customerFingerprint(next),receipt}:null};
   await onResolve?.();if(lost){lost=false;throw Error('Lost reply after actual completion');}return Response.json(done);
  }
  if(done)return Response.json({done:true,receipt:done});const review=await reviewView(build(packet),{customer:current});review.current.stateHash=await syncHash(new TextEncoder().encode(syncDownloadToken(current)));await onRead?.();return Response.json({done:false,review});
 };
 return {db,customer,account,original,backup,id:workspace.source.review.id,options:{config,account:runtime,send},calls:()=>calls,done:()=>done,lose:()=>{lost=true;},offline:(value:boolean)=>{offline=value;},setName:(name:string)=>{current={...current,name};},setAuth:()=>{authorization={...authorization,generation:authorization.generation+1};},onRead:(value:typeof onRead)=>{onRead=value;},onResolve:(value:typeof onResolve)=>{onResolve=value;}};
}
it.each(['withdrawn','replaced'] as const)('confirms a native %s choice without rewriting the original source, account or working data',async outcome=>{
 const f=await boot();expect(await hasSavedCustomerReview(f.db,(await f.db.cloudState.get('binding'))!.uploadId)).toBe(true);const record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);expect(record.phase).toBe('review');expect(record.quote?.proposal.enabled).toBe(true);
 const result=await decideSavedCustomerReview(f.db,f.id,record.revision,{outcome},f.options);expect(result.record.phase).toBe('confirmed');expect(result.record.receipt).toMatchObject({outcome});expect(f.calls()).toBe(1);expect((await f.db.outbox.toArray())[0].status).toBe('accepted');expect(backupToken(await f.db.readBackup())).toBe(f.backup);expect(result.record.packet).toEqual(record.packet);
 const saved=JSON.stringify(await f.db.customerReviews.toArray());expect(saved).not.toMatch(/"token"|publishableKey|apiUrl|Authorization|original\.account\.signature|auth_user_id/);
});
it('recovers a lost reply after close/reload before sending another customer choice',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);const name=f.db.name;f.db.close();const reopened=new MiseDatabase(name);databases.push(reopened);const saved=(await reopened.customerReviews.get(f.id))!;expect(saved.phase).toBe('unconfirmed');expect(saved.attempts).toHaveLength(1);
 const actual=await prepareSavedCustomerReview(reopened,f.id,saved.revision,f.options);expect(actual.phase).toBe('confirmed');expect(f.calls()).toBe(1);expect(backupToken(await reopened.readBackup())).toBe(f.backup);
});
it('requires fresh consent when checked current contact values change',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);f.setName('Changed online');const changed=await decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options);expect(changed.changed).toBe(true);expect(changed.record.choice).toBeNull();expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);const actual=await decideSavedCustomerReview(f.db,f.id,changed.record.revision,replacement,f.options);expect(actual.record.phase).toBe('confirmed');expect(actual.record.attempts).toHaveLength(2);
});
it.each(['read','resolve'] as const)('does not acknowledge a response after the account changes during %s',async stage=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);if(stage==='read')f.onRead(async()=>f.setAuth());else f.onResolve(async()=>f.setAuth());await expect(decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await f.db.customerReviews.get(f.id))?.phase).toBe('unconfirmed');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('persists an offline choice before HTTP and resumes the same source without a fabricated receipt',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);f.offline(true);await expect(decideSavedCustomerReview(f.db,f.id,record.revision,withdraw,f.options)).rejects.toThrow();const saved=(await f.db.customerReviews.get(f.id))!;expect(saved.phase).toBe('unconfirmed');expect(saved.choice).toEqual(withdraw);expect(saved.receipt).toBeNull();expect(f.calls()).toBe(0);f.offline(false);const actual=await decideSavedCustomerReview(f.db,f.id,saved.revision,withdraw,f.options);expect(actual.record.phase).toBe('confirmed');expect(f.calls()).toBe(1);
});
it('lets only one tab submit the selected native revision',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options),results=await Promise.allSettled([decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options),decideSavedCustomerReview(f.db,f.id,record.revision,withdraw,f.options)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.calls()).toBe(1);expect((await f.db.customerReviews.get(f.id))?.phase).toBe('confirmed');
});
it('preserves an accepted grouped prefix and reviews only the first unconfirmed customer action',async()=>{
 const f=await boot(true),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);expect(record.commandIndex).toBe(1);expect(f.original[0].commands).toHaveLength(2);expect(f.original[0].receipts).toHaveLength(1);const first=f.original[0].receipts[0],result=await decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options),row=(await f.db.outbox.toArray())[0];expect(result.record.phase).toBe('confirmed');expect(row.receipts).toHaveLength(2);expect(row.receipts[0]).toEqual(first);expect(row.commands).toEqual(f.original[0].commands);expect(row.changes).toEqual(f.original[0].changes);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('independently rejects a changed live prefix while the stable full-source hash remains the same',async()=>{
 const f=await boot(true),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options),before=await f.db.customerReviews.get(f.id),row=(await f.db.outbox.toArray())[0];await f.db.outbox.put({...row,receipts:row.receipts.map((r,i)=>i? r:{...r,at:r.at+1})});await expect(decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.customerReviews.get(f.id)).toEqual(before);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('refuses altered original audit text instead of borrowing the latest working customer',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options),saved=await f.db.customerReviews.get(f.id),entry=(await f.db.outbox.toArray())[0],event=entry.changes.find(c=>c.table==='events'&&c.key===record.packet.command.id)!;await f.db.outbox.put({...entry,changes:entry.changes.map(c=>c===event?{...c,after:{...(c.after as Record<string,unknown>),at:1}}:c)});await expect(decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.customerReviews.get(f.id)).toEqual(saved);expect(f.calls()).toBe(0);
});
async function activateOriginalOwner(f:Awaited<ReturnType<typeof boot>>){const setup=(await f.db.setup())!;await selectCloudOperator(f.db,{version:1,role:'owner',businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,accountHash:f.options.account.accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:setup.business.name,outletName:setup.outlet.name,actorName:setup.owner.name??null},{targetHash:f.options.account.targetHash,authKey:'mise.cloud.auth.'+'e'.repeat(64)},null,async value=>value);}
it('rechecks an acknowledged outcome after a new owner generation without reviving the old decision',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedCustomerReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();await activateOriginalOwner(f);await deliverLocalOutbox(f.db,f.options.account.targetHash,createCloudCommandRemote(config,f.options.account,async()=>Response.json(f.done())));const saved=(await f.db.customerReviews.get(f.id))!,accepted=await f.db.outbox.toArray();expect((await readCustomerReviewWorkspace(f.db,f.id))?.acknowledged).toBe(true);await expect(decideSavedCustomerReview(f.db,f.id,saved.revision,replacement,f.options)).rejects.toThrow();const actual=await prepareSavedCustomerReview(f.db,f.id,saved.revision,f.options);expect(actual.phase).toBe('confirmed');expect(actual.attempts).toEqual(saved.attempts);expect(f.calls()).toBe(1);expect(await f.db.outbox.toArray()).toEqual(accepted);
});
it('does not submit a previous owner generation before genuine acknowledgement',async()=>{
 const f=await boot(),record=await prepareSavedCustomerReview(f.db,f.id,null,f.options);await activateOriginalOwner(f);expect(await readCustomerReviewWorkspace(f.db,f.id)).toBeNull();await expect(prepareSavedCustomerReview(f.db,f.id,record.revision,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('upgrades schema 26 with original receipts, pending work and every portable row intact',async()=>{
 const f=await boot(),old=new Dexie('mise-customer-review-v26-'+randomUUID()),tables=f.db.tables.filter(t=>t.name!=='payments'&&t.name!=='customerReviews'&&t.name!=='closingReviews'),saved=await Promise.all(tables.map(t=>t.toArray()));databases.push(old);old.version(26).stores(Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(let i=0;i<tables.length;i++)await old.table(tables[i].name).bulkPut(saved[i]);old.close();const upgraded=new MiseDatabase(old.name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.customerReviews.count()).toBe(0);expect(await Promise.all(tables.map(t=>upgraded.table(t.name).toArray()))).toEqual(saved);expect(backupToken(await upgraded.readBackup())).toBe(f.backup);expect(Object.keys((await upgraded.readBackup()).tables)).toHaveLength(22);
});
