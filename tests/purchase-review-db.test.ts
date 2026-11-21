import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {type CommandAuthorization} from '../apps/web/src/data/command-request';
import {prepareSavedPurchaseReview,decideSavedPurchaseReview,readPurchaseReviewWorkspace,hasSavedPurchaseReview} from '../apps/web/src/data/purchase-review-session';
import {preparePurchaseReviewSource} from '../apps/web/src/data/purchase-review-source';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {originalPurchaseFacts,reviewedPurchaseProposal,type PurchaseReviewRequest,type PurchaseResolutionReceipt,type PreparedPurchaseReview} from '../packages/core/purchase-review';
import {parseLocalPurchaseReview} from '../packages/core/purchase-review-journal';
import {purchaseFingerprint} from '../packages/core/purchase-replay';
import {parsePurchaseCommandReceipt,type PurchaseCommandReceipt} from '../packages/core/purchase-commands';
import {backupToken} from '../packages/core/backup';
import {localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {testCommandAccount} from './command-account-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},databases:Dexie[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});
/** Native storage/account proofs. This gateway is synthetic; the separate
 * purchase protocol suite exercises actual scoped PostgreSQL and HTTP handlers. */
async function boot(undo=false){
 const db=new MiseDatabase('mise-purchase-review-'+randomUUID()),journal=new CloudUploadJournal('mise-purchase-review-upload-'+randomUUID());databases.push(db,journal);const source=cloudUploadFixture();await db.restoreBackup(source,await db.previewRestore(source));
 let authorization:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};
 const account={...testCommandAccount(config,async()=>authorization.jwt),getAuth:async()=>({...authorization}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==authorization.generation||value.userId!==authorization.userId)throw Error('Original account changed');}};
 const input={supplierName:'Original supplier',reference:'Original invoice · বাংলা',lines:[{name:'Rice',unit:'kg',qty:2.5,unitPrice:12001}],paid:'due' as const,note:'Original literal\0\ud800'},parent=undo?await db.recordPurchase(input):null;
 const plan=await journal.prepare(db,uploadId());await uploadWithLocalOutbox(db,journal,plan.manifest.id,account.targetHash,new MemoryCloudUpload());if(parent)await db.undoPurchase(parent.id);else await db.recordPurchase(input);
 const original=await db.outbox.toArray(),backup=backupToken(await db.readBackup());await expect(deliverLocalOutbox(db,account.targetHash,createCloudCommandRemote(config,account,async()=>new Response('Private provider detail',{status:409})))).rejects.toMatchObject({kind:'review'});
 const workspace=await readPurchaseReviewWorkspace(db);if(!workspace)throw Error('Expected original rejected invoice');const facts=originalPurchaseFacts(await preparePurchaseReviewSource(workspace.source.entry,0,uploadId(91),uploadId(92))),{eventId:_eventId,createdBy:_createdBy,...savedInvoice}=facts;
 void _eventId;void _createdBy;
 let profileCurrency='BDT',profileTimezone='Asia/Dhaka',lost=false,calls=0,done:PurchaseCommandReceipt|PurchaseResolutionReceipt|null=null;
 let onRead:(()=>Promise<void>)|null=null,onResolve:(()=>Promise<void>)|null=null;
 const receiptFor=(packet:PurchaseReviewRequest,id=packet.command.id):PurchaseCommandReceipt=>{const c=packet.command;return parsePurchaseCommandReceipt({id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:Date.now(),supplierId:facts.supplierId,purchaseId:c.purchaseId,revision:null,total:facts.total,updatedAt:Date.now(),voidedAt:c.type==='purchase.undo'?c.occurredAt:null,undoOf:c.type==='purchase.undo'?c.purchaseId:null},id===c.id?c:reviewedPurchaseProposal(c,id));};
 const send:typeof fetch=async(url,init)=>{
  const packet=JSON.parse(String(init?.body)) as PurchaseReviewRequest&{outcome:'withdrawn'|'replaced'},c=packet.command;
  if(new URL(String(url)).searchParams.get('review')==='purchase-resolve'){
   calls++;done={id:packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:workspace.source.review.commandHash,sourceHash:packet.sourceHash,at:Date.now(),outcome:packet.outcome,replacement:packet.outcome==='withdrawn'?null:{id:packet.replacementId,commandHash:await purchaseFingerprint(reviewedPurchaseProposal(c,packet.replacementId)),receipt:receiptFor(packet,packet.replacementId)}};
   await onResolve?.();if(lost){lost=false;throw Error('Lost reply after actual completion');}return Response.json(done);
  }
  if(done)return Response.json({done:true,receipt:done});const r=workspace.source.review,at=Date.now();
  const review:PreparedPurchaseReview={v:1,id:packet.id,replacementId:packet.replacementId,commandId:c.id,commandHash:r.commandHash,sourceHash:packet.sourceHash,businessId:r.businessId,outletId:r.outletId,actorId:r.actorId,token:'x'.repeat(43),at,expiresAt:at+120000,current:{profileCurrency,profileTimezone,supplier:null,invoice:parent?{...savedInvoice,voided:false}:null},proposal:profileCurrency!==facts.currency&&c.type==='purchase.record'?{enabled:false,reason:'currency'}:{enabled:true,invoice:{...savedInvoice,timezone:c.type==='purchase.record'?profileTimezone:savedInvoice.timezone}}};
  await onRead?.();return Response.json({done:false,review});
 };
 return {db,journal,original,backup,id:workspace.source.review.id,options:{config,account,send},facts,calls:()=>calls,setCurrency:(value:string)=>{profileCurrency=value;},setTimezone:(value:string)=>{profileTimezone=value;},lose:()=>{lost=true;},setAuth:()=>{authorization={...authorization,generation:authorization.generation+1};},onRead:(value:typeof onRead)=>{onRead=value;},onResolve:(value:typeof onResolve)=>{onResolve=value;},setDone:(value:typeof done)=>{done=value;},done:()=>done,receiptFor};
}
const withdraw={outcome:'withdrawn'} as const,replacement={outcome:'replaced'} as const;
it('journals withdrawal before HTTP and acknowledges only its actual outcome with original invoice and images intact',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.onResolve(async()=>{const saved=await f.db.purchaseReviews.get(f.id);expect(saved).toMatchObject({phase:'deciding',choice:withdraw});expect(saved?.attempts).toHaveLength(1);expect(await f.db.outbox.toArray()).toEqual(f.original);});
 const result=await decideSavedPurchaseReview(f.db,f.id,r.revision,withdraw,f.options);expect(result.record).toMatchObject({phase:'confirmed',receipt:{type:'command.resolved',outcome:'withdrawn',replacement:null}});expect(f.calls()).toBe(1);expect((await f.db.outbox.toArray()).map(row=>row.changes)).toEqual(f.original.map(row=>row.changes));expect(backupToken(await f.db.readBackup())).toBe(f.backup);expect(JSON.stringify(result.record)).not.toContain('"token"');expect(Object.keys((await f.db.readBackup()).tables)).toHaveLength(21);
});
it('accepts a distinct invoice replacement without rewriting the original ID, price, source, note or local rows',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options),result=await decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options);expect(result.record.receipt).toMatchObject({outcome:'replaced',replacement:{id:r.packet.replacementId,receipt:{purchaseId:r.packet.command.purchaseId,total:30003}}});const [row]=await f.db.outbox.toArray();expect(row.commands).toEqual(f.original[0].commands);expect(row.changes).toEqual(f.original[0].changes);expect(row.status).toBe('accepted');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('recovers a lost completion after reopening IndexedDB with a single actual resolution request',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);const name=f.db.name;f.db.close();const reopened=new MiseDatabase(name);databases.push(reopened);const saved=(await reopened.purchaseReviews.get(f.id))!;expect(saved.phase).toBe('unconfirmed');expect(saved.attempts).toHaveLength(1);expect(JSON.stringify(saved)).not.toContain('"token"');const result=await prepareSavedPurchaseReview(reopened,f.id,saved.revision,f.options);expect(result.phase).toBe('confirmed');expect(f.calls()).toBe(1);
});
it('a changed timezone requires a new explicit choice without reusing the old displayed comparison',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.setTimezone('UTC');const changed=await decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options);expect(changed.changed).toBe(true);expect(changed.record.choice).toBeNull();expect(changed.record.quote?.proposal).toMatchObject({enabled:true,invoice:{timezone:'UTC',createdAt:f.facts.createdAt,total:30003}});expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);const result=await decideSavedPurchaseReview(f.db,f.id,changed.record.revision,replacement,f.options);expect(result.record.phase).toBe('confirmed');expect(result.record.attempts).toHaveLength(2);
});
it('changed currency offers withdrawal and cannot silently reinterpret the original invoice',async()=>{
 const f=await boot();f.setCurrency('USD');const r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);expect(r.quote?.proposal).toEqual({enabled:false,reason:'currency'});await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await decideSavedPurchaseReview(f.db,f.id,r.revision,withdraw,f.options)).record.phase).toBe('confirmed');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('historical BDT undo remains BDT under a later USD profile',async()=>{
 const f=await boot(true);f.setCurrency('USD');const r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);expect(r.quote?.proposal).toMatchObject({enabled:true,invoice:{currency:'BDT',total:30003,voided:true}});const result=await decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options);expect(result.record.receipt).toMatchObject({replacement:{receipt:{voidedAt:r.packet.command.occurredAt,undoOf:r.packet.command.purchaseId}}});expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a completed ordinary invoice is recovered without inventing a resolution',async()=>{
 const f=await boot(),workspace=(await readPurchaseReviewWorkspace(f.db,f.id))!,packet=await preparePurchaseReviewSource(workspace.source.entry,0,uploadId(91),uploadId(92));f.setDone(f.receiptFor(packet));const r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);expect(r.phase).toBe('confirmed');expect(r.receipt?.type).toBe('purchase.record');expect(f.calls()).toBe(0);
});
it('a genuine outcome completed elsewhere wins even when it differs from the local choice and nonce',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow();const saved=(await f.db.purchaseReviews.get(f.id))!,otherId=uploadId(89),actual={...f.done()!,id:uploadId(90),outcome:'replaced' as const,replacement:{id:otherId,commandHash:await purchaseFingerprint(reviewedPurchaseProposal(r.packet.command,otherId)),receipt:f.receiptFor(r.packet,otherId)}};f.setDone(actual);const result=await prepareSavedPurchaseReview(f.db,f.id,saved.revision,f.options);expect(result.receipt).toEqual(actual);expect(result.choice).toEqual(withdraw);expect(f.calls()).toBe(1);
});
it('another source cannot confirm the original invoice or remove its pending work',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();const saved=(await f.db.purchaseReviews.get(f.id))!;f.setDone({...f.done()!,sourceHash:'b'.repeat(64)} as PurchaseResolutionReceipt);await expect(prepareSavedPurchaseReview(f.db,f.id,saved.revision,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('an account change after remote completion retains the complete original choice and source',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.onResolve(async()=>{f.setAuth();});await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect((await f.db.purchaseReviews.get(f.id))?.choice).toEqual(replacement);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a newer native comparison supersedes an older decision before any resolve call',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options),newer=await prepareSavedPurchaseReview(f.db,f.id,r.revision,f.options);await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect((await f.db.purchaseReviews.get(f.id))?.revision).toBe(newer.revision);expect(f.calls()).toBe(0);
});
it('an account change inside a native journal writer rolls the review back before HTTP',async()=>{
 const f=await boot(),before=await f.db.purchaseReviews.toArray(),change=()=>{f.setAuth();};f.db.purchaseReviews.hook('creating',change);try{await expect(prepareSavedPurchaseReview(f.db,f.id,null,f.options)).rejects.toThrow();expect(await f.db.purchaseReviews.toArray()).toEqual(before);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);}finally{f.db.purchaseReviews.hook('creating').unsubscribe(change);}
});
it('an original outbox change inside the journal writer rolls both records back without a decision',async()=>{
 const f=await boot(),before=await f.db.purchaseReviews.toArray();let changed=false;const mutate=()=>{void f.db.outbox.update(f.original[0].id,{at:f.original[0].at+1}).then(()=>{changed=true;}).catch(()=>{});};f.db.purchaseReviews.hook('creating',mutate);
 try{await expect(prepareSavedPurchaseReview(f.db,f.id,null,f.options)).rejects.toThrow();expect(changed).toBe(true);expect(await f.db.purchaseReviews.toArray()).toEqual(before);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);expect(backupToken(await f.db.readBackup())).toBe(f.backup);}finally{f.db.purchaseReviews.hook('creating').unsubscribe(mutate);}
});
it('rejects tokens and forged completed choices in the durable invoice journal',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);expect(()=>parseLocalPurchaseReview({...r,quote:{...r.quote,token:'x'.repeat(43)}})).toThrow();expect(()=>parseLocalPurchaseReview({...r,phase:'confirmed'})).toThrow();expect(()=>parseLocalPurchaseReview({...r,choice:{...replacement,confirmCredit:false}})).toThrow();expect(await hasSavedPurchaseReview(f.db,r.uploadId)).toBe(true);
});
it('a schema-24 upgrade preserves every original store and full image, adding only an empty private invoice journal',async()=>{
 const f=await boot(),old=new Dexie('mise-purchase-review-v24-'+randomUUID()),tables=f.db.tables.filter(t=>t.name!=='purchaseReviews'&&t.name!=='stockReviews'),saved=await Promise.all(tables.map(t=>t.toArray()));databases.push(old);old.version(24).stores(Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(let i=0;i<tables.length;i++)await old.table(tables[i].name).bulkPut(saved[i]);old.close();const upgraded=new MiseDatabase(old.name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.purchaseReviews.count()).toBe(0);expect(await Promise.all(tables.map(t=>upgraded.table(t.name).toArray()))).toEqual(saved);expect(backupToken(await upgraded.readBackup())).toBe(f.backup);expect(Object.keys((await upgraded.readBackup()).tables)).toHaveLength(21);
});
async function activateOriginalOwner(f:Awaited<ReturnType<typeof boot>>){const setup=(await f.db.setup())!;return selectCloudOperator(f.db,{version:1,role:'owner',businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,accountHash:f.options.account.accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:setup.business.name,outletName:setup.outlet.name,actorName:setup.owner.name??null},{targetHash:f.options.account.targetHash,authKey:'mise.cloud.auth.'+'e'.repeat(64)},null,async value=>value);}
async function acknowledgedFixture(){const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedPurchaseReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();await activateOriginalOwner(f);await deliverLocalOutbox(f.db,f.options.account.targetHash,createCloudCommandRemote(config,f.options.account,async()=>Response.json(f.done())));const record=(await f.db.purchaseReviews.get(f.id))!;return {...f,record,accepted:await f.db.outbox.toArray(),operator:await f.db.operatorState.get('active')};}
it('rechecks an outcome already acknowledged under a fresh original-owner generation without reviving its decision',async()=>{
 const f=await acknowledgedFixture();expect((await readPurchaseReviewWorkspace(f.db,f.id))?.acknowledged).toBe(true);await expect(decideSavedPurchaseReview(f.db,f.id,f.record.revision,replacement,f.options)).rejects.toThrow('original');const actual=await prepareSavedPurchaseReview(f.db,f.id,f.record.revision,f.options);expect(actual.phase).toBe('confirmed');expect(actual.receipt).toEqual(f.done());expect(actual.identityHash).toBe(f.record.identityHash);expect(actual.packet).toEqual(f.record.packet);expect(actual.attempts).toEqual(f.record.attempts);expect(f.calls()).toBe(1);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a later generation cannot submit an old pending choice before a genuine acknowledgement',async()=>{
 const f=await boot(),r=await prepareSavedPurchaseReview(f.db,f.id,null,f.options);await activateOriginalOwner(f);expect(await readPurchaseReviewWorkspace(f.db,f.id)).toBeNull();await expect(prepareSavedPurchaseReview(f.db,f.id,r.revision,f.options)).rejects.toThrow('original');expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('cached acknowledgement cannot invent a confirmed history or resubmit an invoice',async()=>{
 const f=await acknowledgedFixture();f.setDone(null);await expect(prepareSavedPurchaseReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('actual acknowledged');expect(await f.db.purchaseReviews.get(f.id)).toEqual(f.record);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(f.calls()).toBe(1);
});
it('a different restored phone account cannot adopt the acknowledged invoice history',async()=>{
 const f=await acknowledgedFixture(),operator=f.operator!;await f.db.operatorState.put({...operator,connection:{...operator.connection!,accountHash:'d'.repeat(64)}});expect(await readPurchaseReviewWorkspace(f.db,f.id)).toBeNull();await expect(prepareSavedPurchaseReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('original');expect(await f.db.outbox.toArray()).toEqual(f.accepted);
});
