import {localTableNames} from '../packages/core/local-schema';
import {localSchemaVersion} from '../packages/core/local-outbox';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach,expect,it} from 'vitest';
import {backupToken} from '../packages/core/backup';
import {syncDownloadToken} from '../packages/core/sync-download';
import {parseLocalCloudState} from '../packages/core/local-outbox';
import {joinedApplyFixture,coverageFacts} from './sync-apply-fixture';
import {stageScopeRecovery} from './scope-recovery-fixture';
import {prepareScopeRecoveryReview,applyScopeRecoveryReview} from '../apps/web/src/data/cloud-scope-apply';
import {readCanonicalState} from '../apps/web/src/data/cloud-canonical-state';
import {MiseDatabase} from '../apps/web/src/data/db';
import {newInboxId} from '../packages/core/inbox';

for(const kind of ['counter','order','purchase','customer'] as const)it(`scope recovery cannot reinterpret a pending BDT ${kind} action in USD`,async()=>{
 const f=await boot();
 if(kind==='counter')await f.db.recordSale({expression:'37',method:'cash'});
 else if(kind==='purchase')await f.db.recordPurchase({supplierName:'Original supplier',reference:'Original BDT invoice',lines:[{name:'Rice',unit:'kg',qty:2.5,unitPrice:12001}],paid:'due',note:''});
 else if(kind==='customer')await f.db.saveCustomer({name:'Original customer',nickname:'',phone:'',address:'',notes:'Keep original opening',tags:[]},{opening:{amount:12345,occurredAt:1}});
 else await f.db.saveOrder({source:'phone',sourceText:'Original BDT order',name:'Rina',phone:'',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:1,unitPrice:3700}],deliveryFee:0,discount:0,payment:{method:'cash'}});
 const before=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray(),binding=await f.db.cloudState.get('binding'),operator=await f.db.operatorState.toArray(),base=await f.db.syncCanonical.toArray();
 const staged=await stageScopeRecovery(f,{updates:[{table:'outlets',row:{...f.backup.tables.outlets[0],currency:'USD'}}]});
 await expect(prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access)).rejects.toMatchObject({kind:'conflict',commandId:queue[0].commands[0].id});
 expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.cloudState.get('binding')).toEqual(binding);expect(await f.db.operatorState.toArray()).toEqual(operator);expect(await f.db.syncCanonical.toArray()).toEqual(base);expect(await f.db.scopeRecoveries.where('kind').equals('admission').count()).toBe(0);
});
import {applyCanonicalDownload} from '../apps/web/src/data/cloud-sync-apply';
const databases:MiseDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.delete();});
async function boot(){const f=await joinedApplyFixture();databases.push(f.db);return f;}
const absent={get:async(source:Parameters<typeof coverageFacts>[0])=>coverageFacts(source)};
it('recovers a working outlet across a new epoch with original pending cash, image bytes, queue and initial admission intact',async()=>{
 const f=await boot();await f.db.recordSale({expression:'7',method:'cash'});const before=await f.db.readBackup(),binding=(await f.db.cloudState.get('binding'))!,queue=await f.db.outbox.toArray(),staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access);
 expect(review.pending).toBe(1);expect(backupToken(await f.db.readBackup())).toBe(backupToken(before));const admitted=await applyScopeRecoveryReview(f.db,review,staged.access),canonical=await readCanonicalState(f.db);
 expect(admitted.phase).toBe('admitted');expect(canonical.base.snapshot.scope.epoch).toBe(staged.window.epoch);expect(canonical.binding.version).toBe(3);expect(canonical.binding.origin).toEqual(binding);expect(canonical.recoveries).toHaveLength(1);expect(canonical.recoveries[0].admission.source.working).toEqual(expect.objectContaining({tables:before.tables}));expect(await f.db.outbox.toArray()).toEqual(queue);expect((await f.db.readBackup()).tables.sales.map(row=>row.id).sort()).toEqual(before.tables.sales.map(row=>row.id).sort());expect((await f.db.readBackup()).tables.inboxItems).toEqual(before.tables.inboxItems);expect(await f.db.setup()).toMatchObject({owner:{id:f.target.actorId}});
});
it('permits a freshly allowed manager role without rewriting the original owner admission or queued cash',async()=>{
 const f=await boot();await f.db.recordSale({expression:'9',method:'cash'});const queue=await f.db.outbox.toArray(),binding=await f.db.cloudState.get('binding'),staged=await stageScopeRecovery(f,{role:'manager'}),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access);await applyScopeRecoveryReview(f.db,review,staged.access);const current=await readCanonicalState(f.db);expect(current.base.snapshot.scope.role).toBe('manager');expect(current.binding.origin).toEqual(binding);expect((await f.db.setup())?.owner.role).toBe('manager');expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('refuses a stale review after another local cash write, preserving the current working copy and original fence',async()=>{
 const f=await boot();await f.db.recordSale({expression:'3',method:'cash'});const binding=await f.db.cloudState.get('binding'),staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access);await f.db.recordSale({expression:'5',method:'cash'});const current=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray();await expect(applyScopeRecoveryReview(f.db,review,staged.access)).rejects.toThrow();expect(backupToken(await f.db.readBackup())).toBe(current);expect(await f.db.outbox.toArray()).toEqual(queue);expect((await f.db.cloudState.get('binding'))?.version).toBe(binding?.version);expect((await f.db.scopeRecoveries.get('active'))?.kind).toBe('session');expect(await f.db.scopeRecoveries.where('kind').equals('admission').count()).toBe(0);
});
it('rejects invented review objects and changed live scope before domain changes',async()=>{
 const f=await boot(),staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access),before=backupToken(await f.db.readBackup());await expect(applyScopeRecoveryReview(f.db,{...review},staged.access)).rejects.toMatchObject({kind:'integrity'});await expect(applyScopeRecoveryReview(f.db,review,{...staged.access,refresh:async()=>({...staged.context,scopeVersion:crypto.randomUUID()})})).rejects.toMatchObject({kind:'review'});expect(backupToken(await f.db.readBackup())).toBe(before);expect((await f.db.cloudState.get('binding'))?.version).toBe(2);
});
it('rolls domain rows, original bytes, scope and operator back when retaining the original copy runs out of storage',async()=>{
 const f=await boot();await f.db.recordSale({expression:'11',method:'cash'});const staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access),before=backupToken(await f.db.readBackup()),queue=await f.db.outbox.toArray(),binding=await f.db.cloudState.get('binding'),operator=await f.db.operatorState.get('active');const fail=(_key:unknown,row:{kind?:string})=>{if(row.kind==='admission')throw new DOMException('Storage full','QuotaExceededError');};f.db.scopeRecoveries.hook('creating',fail);try{await expect(applyScopeRecoveryReview(f.db,review,staged.access)).rejects.toThrow('Storage full');}finally{f.db.scopeRecoveries.hook('creating').unsubscribe(fail);}expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.toArray()).toEqual(queue);expect(await f.db.cloudState.get('binding')).toEqual(binding);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(await f.db.scopeRecoveries.where('kind').equals('admission').count()).toBe(0);
});
it('rejects a modified recovery chain and original fence while retaining the actual original working copy',async()=>{
 const f=await boot(),staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access);await applyScopeRecoveryReview(f.db,review,staged.access);const current=await readCanonicalState(f.db),record=current.recoveries[0].admission;await f.db.scopeRecoveries.put({...record,source:{...record.source,workingHash:'f'.repeat(64)}});await expect(readCanonicalState(f.db)).rejects.toThrow();await f.db.scopeRecoveries.put(record);const binding=parseLocalCloudState(await f.db.cloudState.get('binding'));expect(syncDownloadToken(binding.origin)).toBe(syncDownloadToken(record.source.binding));expect((await readCanonicalState(f.db)).recoveries).toHaveLength(1);
});
it('continues ordinary canonical application after recovery without losing the scope bridge or new local cash',async()=>{
 const f=await boot();await f.db.recordSale({expression:'13',method:'cash'});const staged=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access);await applyScopeRecoveryReview(f.db,review,staged.access);await f.db.recordSale({expression:'17',method:'cash'});const queue=await f.db.outbox.toArray(),input=await f.stage();await applyCanonicalDownload(f.db,input,absent,staged.access.refresh);const current=await readCanonicalState(f.db);expect(current.application?.recoveryId).toBe(staged.session.operationId);expect(current.recoveries).toHaveLength(1);expect(current.application?.pending).toHaveLength(2);expect(await f.db.outbox.toArray()).toEqual(queue);expect((await f.db.sales.toArray()).filter(row=>[1300,1700].includes(row.amount))).toHaveLength(2);
});
it('retains both original shop copies through repeated scope changes and a later manager permission',async()=>{
 const f=await boot();await f.db.recordSale({expression:'19',method:'cash'});const original=await f.db.cloudState.get('binding'),one=await stageScopeRecovery(f),first=await prepareScopeRecoveryReview(f.db,one.session,absent,one.access);await applyScopeRecoveryReview(f.db,first,one.access);const before=await f.db.readBackup(),two=await stageScopeRecovery(f,{role:'manager'}),second=await prepareScopeRecoveryReview(f.db,two.session,absent,two.access);await applyScopeRecoveryReview(f.db,second,two.access);const current=await readCanonicalState(f.db);expect(current.recoveries).toHaveLength(2);expect(current.recoveries[0].admission.source.working.tables).toEqual(before.tables);expect(current.binding.origin).toEqual(original);expect(current.base.snapshot.scope.role).toBe('manager');expect(current.base.snapshot.scope.epoch).toBe(two.window.epoch);
});
it('requires fresh coverage for previously proven accepted commands instead of carrying old scope coverage forward',async()=>{
 const f=await boot();await f.db.recordSale({expression:'23',method:'cash'});const queue=await f.db.outbox.toArray(),command=queue[0].commands[0],input=await f.stage(queue[0].changes.filter(c=>c.after!==null).map(c=>({table:c.table,row:c.after})));await applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source,{[command.id]:'visible'})},f.refresh);const before=backupToken(await f.db.readBackup()),staged=await stageScopeRecovery(f);await expect(prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access)).rejects.toMatchObject({kind:'review'});expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.toArray()).toEqual(queue);const review=await prepareScopeRecoveryReview(f.db,staged.session,{get:async source=>coverageFacts(source,{[command.id]:'visible'})},staged.access).catch(error=>error);expect(review).toMatchObject({kind:'review'});
});
it('accepts newly visible old commands only from a fresh fixed snapshot, without replaying their money twice',async()=>{
 const f=await boot();await f.db.recordSale({expression:'29',method:'cash'});const queue=await f.db.outbox.toArray(),command=queue[0].commands[0],input=await f.stage(queue[0].changes.filter(c=>c.after!==null).map(c=>({table:c.table,row:c.after})));
 await applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source,{[command.id]:'visible'})},f.refresh);
 const rejected=await stageScopeRecovery(f);await expect(prepareScopeRecoveryReview(f.db,rejected.session,absent,rejected.access)).rejects.toMatchObject({kind:'review'});
 const fresh=await stageScopeRecovery(f),review=await prepareScopeRecoveryReview(f.db,fresh.session,{get:async source=>coverageFacts(source,{[command.id]:'visible'})},fresh.access);
 expect(review.pending).toBe(0);expect(review.covered).toBe(1);await applyScopeRecoveryReview(f.db,review,fresh.access);expect((await f.db.sales.toArray()).filter(row=>row.amount===2900)).toHaveLength(1);expect(await f.db.outbox.toArray()).toEqual(queue);
});
it.each(['unknown','later'] as const)('keeps previously covered money for review when fresh coverage is %s',async state=>{
 const f=await boot();await f.db.recordSale({expression:'31',method:'cash'});const queue=await f.db.outbox.toArray(),command=queue[0].commands[0],input=await f.stage(queue[0].changes.filter(c=>c.after!==null).map(c=>({table:c.table,row:c.after})));
 await applyCanonicalDownload(f.db,input,{get:async source=>coverageFacts(source,{[command.id]:'visible'})},f.refresh);const before=backupToken(await f.db.readBackup()),staged=await stageScopeRecovery(f);
 await expect(prepareScopeRecoveryReview(f.db,staged.session,{get:async source=>coverageFacts(source,{[command.id]:state})},staged.access)).rejects.toMatchObject({kind:'review'});expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('rolls every native write back when live authorization changes during domain replacement',async()=>{
 const f=await boot(),staged=await stageScopeRecovery(f,{updates:[{table:'businesses',row:{...f.backup.tables.businesses[0],name:'Fresh remote business'}}]}),review=await prepareScopeRecoveryReview(f.db,staged.session,absent,staged.access),before=backupToken(await f.db.readBackup()),binding=await f.db.cloudState.get('binding'),operator=await f.db.operatorState.get('active');let allowed=true;
 const revoke=()=>{allowed=false;};f.db.businesses.hook('deleting',revoke);
 try{await expect(applyScopeRecoveryReview(f.db,review,{...staged.access,assertActive:()=>{if(!allowed)throw new Error('Original account changed');}})).rejects.toThrow('Original account changed');}finally{f.db.businesses.hook('deleting').unsubscribe(revoke);}
 expect(allowed).toBe(false);expect(backupToken(await f.db.readBackup())).toBe(before);expect(await f.db.cloudState.get('binding')).toEqual(binding);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(await f.db.scopeRecoveries.where('kind').equals('admission').count()).toBe(0);
});
it('upgrades schema 20 with all 34 original stores, complete images, queue and canonical evidence unchanged',async()=>{
 const f=await boot();await f.db.recordSale({expression:'37',method:'cash'});const before=backupToken(await f.db.readBackup()),name='mise-recovery-upgrade-'+newInboxId(),legacy=new Dexie(name),tables=f.db.tables.filter(table=>!table.name.startsWith('paymentOriginal')&&!['scopeRecoveries','syncActionReviews','orderReviews','moneyReviews','purchaseReviews','stockReviews','customerReviews','closingReviews','payments'].includes(table.name)),saved=await Promise.all(tables.map(table=>table.toArray()));
 legacy.version(20).stores(Object.fromEntries(tables.map(table=>[table.name,[table.schema.primKey.src,...table.schema.indexes.map(index=>index.src)].join(',')])));
 try{await legacy.open();expect(legacy.tables).toHaveLength(34);for(let index=0;index<tables.length;index++)await legacy.table(tables[index].name).bulkPut(saved[index]);}finally{legacy.close();}
 const upgraded=new MiseDatabase(name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.scopeRecoveries.count()).toBe(0);expect(await upgraded.syncActionReviews.count()).toBe(0);expect(await Promise.all(tables.map(table=>upgraded.table(table.name).toArray()))).toEqual(saved);expect(backupToken(await upgraded.readBackup())).toBe(before);expect((await readCanonicalState(upgraded)).binding).toEqual(await f.db.cloudState.get('binding'));
});
