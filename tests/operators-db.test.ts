import {localTableNames} from '../packages/core/local-schema';
import {localSchemaVersion} from '../packages/core/local-outbox';
import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import Dexie from 'dexie';
import {MiseDatabase} from '../apps/web/src/data/db';
import {LocalStore} from '../apps/web/src/data/local-store';
import {readLocalWorkspace,selectLocalOperator,selectCloudOperator,lockLocalOperator} from '../apps/web/src/data/operator-state';
import {reconcileOperatorAuth,reviewStoredOperatorAuth,publishOperatorAuth} from '../apps/web/src/data/operator-auth';
import {operatorAccountHash,parseOperatorContext,parseLocalOperatorState,type OperatorContext,type LocalOperatorState} from '../packages/core/operators';
import {backupToken,createBackup,parseBackup} from '../packages/core/backup';
import {backupTableNames} from '../packages/core/backup-tables';
import {newInboxId} from '../packages/core/inbox';
import {defaultCreditTerms} from '../packages/core/khata';
import {captureDatabaseInbox} from '../apps/web/src/data/inbox';
import {orderFixture} from './order-fixture';
import type {Member} from '../packages/core/models';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {syncDownloadFixture} from './sync-download-fixture';
import {prepareSyncDownload,runSyncDownload} from '../apps/web/src/data/cloud-sync-journal';

const databases:LocalStore[]=[],targetHash='a'.repeat(64),authKey='mise.cloud.auth.'+'c'.repeat(64),accountHash='b'.repeat(64);
const input={businessType:'corner_shop',marketCode:'BD',name:'Operator shop',phone:'01712345482'}as const;
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(multiple=true){
 const db=new MiseDatabase('mise-operators-'+randomUUID());databases.push(db);await db.saveSetup(input);const setup=(await db.setup())!;
 await db.members.update(setup.owner.id,{outletIds:[]});setup.owner.outletIds=[];
 const branch={...setup.outlet,id:newInboxId(),name:'Branch'},manager:Member={...setup.owner,id:'00000000000000000000000001',name:'Manager',role:'manager',outletIds:[setup.outlet.id]};delete manager.phone;
 if(multiple){await db.outlets.add(branch);await db.members.bulkAdd([manager,{...manager,id:newInboxId(),name:'Staff',role:'staff'},{...manager,id:newInboxId(),name:'Former owner',role:'owner',active:false}]);}
 return {db,setup,branch,manager};
}
const choose=(f:Awaited<ReturnType<typeof boot>>,member=f.manager,outlet=f.setup.outlet,revision:number|null=null)=>selectLocalOperator(f.db,{businessId:f.setup.business.id,outletId:outlet.id,actorId:member.id},revision);
function context(f:Awaited<ReturnType<typeof boot>>,actor=f.manager):OperatorContext{return {version:1,businessId:f.setup.business.id,outletId:f.setup.outlet.id,actorId:actor.id,role:actor.role as 'owner'|'manager',accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:f.setup.business.name,outletName:f.setup.outlet.name,actorName:actor.name};}
async function activeCloud(f:Awaited<ReturnType<typeof boot>>){const s=await choose(f,f.setup.owner);const state:LocalOperatorState={...s,connection:{targetHash,authKey,accountHash,epoch:context(f).epoch,scopeVersion:context(f).scopeVersion}};await f.db.operatorState.put(state);return state;}

it('keeps one-device legacy owners working with implicit outlet access and no fabricated assignment',async()=>{
 const f=await boot(false);expect((await f.db.setup())?.owner.id).toBe(f.setup.owner.id);const sale=await f.db.recordSale({expression:'12',method:'cash'});expect(sale.createdBy).toBe(f.setup.owner.id);expect((await f.db.members.get(f.setup.owner.id))?.outletIds).toEqual([]);
});
it('requires an explicit actor even when the first member is a manager, with only assigned manager choices',async()=>{
 const f=await boot(),workspace=await readLocalWorkspace(f.db);expect((await f.db.members.toArray())[0].id).toBe(f.manager.id);expect(workspace.requiresSelection).toBe(true);expect(workspace.choices.filter(c=>c.role==='owner')).toHaveLength(2);expect(workspace.choices.filter(c=>c.role==='manager')).toHaveLength(1);expect(workspace.choices).toHaveLength(3);await expect(f.db.recordSale({expression:'5',method:'cash'})).rejects.toThrow(/Choose/);expect(await f.db.sales.count()).toBe(0);
});
it('attributes real cash, credit, order and worker history to the selected manager without adding a phone or changing role',async()=>{
 const f=await boot();await choose(f);const sale=await f.db.recordSale({expression:'12',method:'cash'});expect(sale.createdBy).toBe(f.manager.id);
 const customer=await f.db.saveCustomer({name:'Customer',nickname:'',phone:'',address:'',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}}),account=(await f.db.creditAccounts.toArray())[0];
 const credit=await f.db.recordCreditSale({expression:'8',customerId:customer.id,accountId:account.id});expect(credit.createdBy).toBe(f.manager.id);
 const order=await f.db.saveOrder({...orderFixture().input,customerId:customer.id});expect(order.createdBy).toBe(f.manager.id);
 const worker=new LocalStore(f.db.name);try{const item=await captureDatabaseInbox(worker,{text:'Manager capture'});expect(item.outletId).toBe(f.setup.outlet.id);expect((await f.db.events.where('inboxId').equals(item.id).first())?.actor).toEqual({type:'member',id:f.manager.id});}finally{worker.close();}
 const events=await f.db.events.toArray();expect(events.filter(e=>e.command!=='setup.create').every(e=>e.actor.type==='member'&&e.actor.id===f.manager.id)).toBe(true);
 expect(await f.db.members.get(f.manager.id)).toEqual(f.manager);expect(parseBackup(await f.db.readBackup()).tables.members.find(m=>m.id===f.manager.id)).toEqual(f.manager);
});
it('allows an owner to select another outlet without manufacturing member_outlets and keeps credit scoped',async()=>{
 const f=await boot();await choose(f);const customer=await f.db.saveCustomer({name:'Customer',nickname:'',phone:'',address:'',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}}),account=(await f.db.creditAccounts.toArray())[0];
 await choose(f,f.setup.owner,f.branch,1);expect((await f.db.recordSale({expression:'4',method:'cash'})).outletId).toBe(f.branch.id);
 await expect(f.db.recordCreditSale({expression:'3',customerId:customer.id,accountId:account.id})).rejects.toThrow();expect((await f.db.members.get(f.setup.owner.id))?.outletIds).toEqual([]);
});
it('rejects stale choices across actual database connections and retains the current operator on reload',async()=>{
 const f=await boot(),other=new LocalStore(f.db.name);try{await choose(f);await expect(selectLocalOperator(other,{businessId:f.setup.business.id,outletId:f.branch.id,actorId:f.setup.owner.id},null)).rejects.toThrow(/another tab/);}finally{other.close();}
 f.db.close();await f.db.open();expect((await f.db.setup())?.owner.id).toBe(f.manager.id);
});
it('reads selected identity through a narrow parent transaction without weakening nested transaction checks',async()=>{
 const f=await boot();await choose(f);await f.db.transaction('rw',f.db.businesses,f.db.outlets,f.db.members,async()=>{expect((await f.db.setup())?.owner.id).toBe(f.manager.id);});
 await expect(f.db.transaction('r',f.db.sales,()=>f.db.setup())).rejects.toThrow(/not included/);
});
it('revoked assignments, inactive members and role changes stop the next real write without falling back to owner',async()=>{
 for(const update of [{outletIds:[]},{active:false},{role:'staff' as const}]){const f=await boot();await choose(f);await f.db.members.update(f.manager.id,update);await expect(f.db.recordSale({expression:'5',method:'cash'})).rejects.toThrow(/no longer active/);expect(await f.db.sales.count()).toBe(0);expect((await readLocalWorkspace(f.db)).requiresSelection).toBe(true);}
});
it('refuses owner profile changes by a manager and leaves the complete backup untouched',async()=>{
 const f=await boot();await choose(f);const before=backupToken(await f.db.readBackup());await expect(f.db.saveSetup({...input,name:'Changed by manager'})).rejects.toThrow(/Only an owner/);expect(backupToken(await f.db.readBackup())).toBe(before);
});
it('keeps a failed manager audit and its money write atomic',async()=>{
 const f=await boot();await choose(f);const before=backupToken(await f.db.readBackup()),fail=()=>{throw new DOMException('Quota','QuotaExceededError');};f.db.events.hook('creating',fail);try{await expect(f.db.recordSale({expression:'10',method:'cash'})).rejects.toThrow();}finally{f.db.events.hook('creating').unsubscribe(fail);}expect(backupToken(await f.db.readBackup())).toBe(before);expect((await f.db.setup())?.owner.id).toBe(f.manager.id);
});
it('round-trips multiple businesses/outlets, inactive roles and missing phone numbers, with explicit recovery selection',async()=>{
 const a=await boot(),b=await boot(false);await choose(a);await a.db.recordSale({expression:'5',method:'cash'});const ta=(await a.db.readBackup()).tables,tb=(await b.db.readBackup()).tables;
 for(const table of backupTableNames)(ta[table] as unknown[]).push(...tb[table]);const source=createBackup(ta),target=new MiseDatabase('mise-operators-restore-'+randomUUID());databases.push(target);
 expect((await target.previewRestore(source)).shopName).toBe('2 shops');expect(await target.restoreBackup(source,await target.previewRestore(source))).toBeNull();expect((await readLocalWorkspace(target)).requiresSelection).toBe(true);
 await selectLocalOperator(target,{businessId:a.setup.business.id,outletId:a.setup.outlet.id,actorId:a.manager.id},null);expect((await target.recordSale({expression:'3',method:'cash'})).createdBy).toBe(a.manager.id);
 const result=await target.readBackup();expect(result.schemaVersion).toBe(11);expect(Object.keys(result.tables)).toHaveLength(22);expect(result.tables.members.find(m=>m.id===a.manager.id)).toEqual(a.manager);expect(JSON.stringify(result)).not.toContain('operatorState');
});
it('rejects foreign business actors and cross-outlet event links before replacing any data',async()=>{
 const f=await boot();await choose(f);await f.db.recordSale({expression:'5',method:'cash'});const saved=await f.db.readBackup(),before=backupToken(saved);
 const wrongOutlet=structuredClone(saved);wrongOutlet.tables.sales[0].outletId=f.branch.id;expect(()=>parseBackup(wrongOutlet)).toThrow(/foreign outlet/);
 const foreign=await boot(false),other=(await foreign.db.readBackup()).tables,wrongActor=structuredClone(saved);wrongActor.tables.businesses.push(...other.businesses);wrongActor.tables.outlets.push(...other.outlets);wrongActor.tables.members.push(...other.members);wrongActor.tables.sales[0].createdBy=other.members[0].id;expect(()=>parseBackup(wrongActor)).toThrow(/foreign outlet or business/);expect(backupToken(await f.db.readBackup())).toBe(before);
});
it('keeps new-device manager discovery pending without inventing an upload receipt or changing shop data',async()=>{
 const f=await boot(),before=backupToken(await f.db.readBackup()),c=context(f),selected=await selectCloudOperator(f.db,c,{targetHash,authKey},null,async original=>original);
 expect(selected.phase).toBe('pending');expect(await f.db.cloudState.count()).toBe(0);expect(await f.db.outbox.count()).toBe(0);expect(backupToken(await f.db.readBackup())).toBe(before);await expect(f.db.setup()).rejects.toThrow(/Finish the connection/);await expect(choose(f,f.setup.owner,f.setup.outlet,1)).rejects.toThrow(/verified cloud account/);
 const blank=new MiseDatabase('mise-operator-empty-'+randomUUID());databases.push(blank);await selectCloudOperator(blank,c,{targetHash,authKey},null,async original=>original);expect((await readLocalWorkspace(blank)).requiresSelection).toBe(true);expect(await blank.members.count()).toBe(0);
});
it('does not accept a refreshed foreign account, actor or outlet and retains the prior local selection',async()=>{
 const f=await boot();await choose(f);for(const patch of [{accountHash:'d'.repeat(64)},{actorId:f.setup.owner.id},{outletId:f.branch.id}])await expect(selectCloudOperator(f.db,context(f),{targetHash,authKey},1,async original=>({...original,...patch}))).rejects.toThrow(/changed/);expect((await f.db.setup())?.owner.id).toBe(f.manager.id);
});
it('locks explicit cloud selection on sign-out/account change while preserving every shop record and original scope',async()=>{
 const f=await boot(),state=await activeCloud(f),before=backupToken(await f.db.readBackup());await reconcileOperatorAuth(f.db,authKey,null);expect(await f.db.operatorState.get('active')).toEqual({...state,phase:'locked',revision:2});await expect(f.db.recordSale({expression:'7',method:'cash'})).rejects.toThrow(/Choose an operator/);expect(backupToken(await f.db.readBackup())).toBe(before);await expect(choose(f,f.setup.owner,f.setup.outlet,2)).rejects.toThrow(/verified cloud account/);
});
it('ignores a different session key and stale notifications without treating matching hashes as new authorization',async()=>{
 const f=await boot(),state=await activeCloud(f);await reconcileOperatorAuth(f.db,'mise.cloud.auth.'+'d'.repeat(64),null);await reconcileOperatorAuth(f.db,authKey,accountHash);await reconcileOperatorAuth(f.db,authKey,null,()=>false);expect(await f.db.operatorState.get('active')).toEqual(state);
 await lockLocalOperator(f.db,1);await reconcileOperatorAuth(f.db,authKey,accountHash);expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');
});
it('reviews saved session continuity on startup without putting raw UUIDs or session values into operator state',async()=>{
 const f=await boot(),uuid='00000000-0000-4000-8000-000000000071',hash=await operatorAccountHash(uuid),state=await activeCloud(f);state.connection!.accountHash=hash;await f.db.operatorState.put(state);
 const storage={getItem:()=>JSON.stringify({user:{id:uuid},access_token:'synthetic'}),setItem(){},removeItem(){}};await reviewStoredOperatorAuth(f.db,storage);expect((await f.db.operatorState.get('active'))?.phase).toBe('active');
 await reviewStoredOperatorAuth(f.db,{...storage,getItem:()=>null});expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');expect(JSON.stringify(await f.db.operatorState.toArray())).not.toContain(uuid);
});
it('retains a memory-only verified identity until its explicit sign-out notice',async()=>{
 const f=await boot(),state=await activeCloud(f);const uniqueKey='mise.cloud.auth.'+createHash('sha256').update(f.db.name).digest('hex');await f.db.operatorState.put({...state,connection:{...state.connection!,authKey:uniqueKey}});publishOperatorAuth(uniqueKey,accountHash);const unavailable={getItem(){throw new Error('Unavailable');},setItem(){},removeItem(){}};await reviewStoredOperatorAuth(f.db,unavailable);expect((await f.db.operatorState.get('active'))?.phase).toBe('active');publishOperatorAuth(uniqueKey,null);await reviewStoredOperatorAuth(f.db,unavailable);expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');
});
it('matches PostgreSQL account fingerprints over UUID bytes and rejects credentials in identity records',async()=>{
 const uuid='00000000-0000-4000-8000-000000000071',expected=createHash('sha256').update(Buffer.from(uuid.replaceAll('-',''),'hex')).digest('hex');expect(await operatorAccountHash(uuid)).toBe(expected);expect(expected).not.toBe(createHash('sha256').update(uuid).digest('hex'));
 const f=await boot(),state=await choose(f);expect(()=>parseLocalOperatorState({...state,token:'synthetic'})).toThrow();expect(()=>parseOperatorContext({...context(f),authUserId:uuid})).toThrow();
});
it('activates an existing genuine local upload fence only for the freshly reviewed matching actor and outlet',async()=>{
 const f=await boot(false),journal=new CloudUploadJournal('mise-operator-ready-'+randomUUID());try{const snapshot=await journal.prepare(f.db,uploadId());await beginLocalUpload(f.db,snapshot,targetHash);await uploadWithLocalOutbox(f.db,journal,snapshot.manifest.id,targetHash,new MemoryCloudUpload());const c=context(f,f.setup.owner),selected=await selectCloudOperator(f.db,c,{targetHash,authKey},null,async original=>original);expect(selected.phase).toBe('active');expect((await f.db.setup())?.owner.id).toBe(f.setup.owner.id);const fence=await f.db.cloudState.get('binding');expect(fence?.receipt).toBeTruthy();expect(fence?.phase).toBe('ready');}finally{await journal.delete();}
},15000);
it('upgrades schema 12 with exact original images, queued cash, upload receipts and staged downloads while leaving selection empty',async()=>{
 const fixture=await syncDownloadFixture(),db=new MiseDatabase('mise-operator-upgrade-source-'+randomUUID());databases.push(db);await db.restoreBackup(fixture.backup,await db.previewRestore(fixture.backup));const journal=new CloudUploadJournal('mise-operator-upgrade-journal-'+randomUUID()),legacy=new Dexie('mise-operator-upgrade-legacy-'+randomUUID());
 try{const snapshot=await journal.prepare(db,uploadId());await beginLocalUpload(db,snapshot,targetHash);await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,targetHash,new MemoryCloudUpload());await db.recordSale({expression:'5',method:'cash'});const remote={begin:async()=>fixture.window,page:async(_window:unknown,index:number)=>fixture.pages[index]},request=await prepareSyncDownload(db,{id:fixture.window.id,target:fixture.target,previousCursor:null});await runSyncDownload(db,request.id,fixture.target,remote);const before=backupToken(await db.readBackup()),internal=await Promise.all(['cloudState','outbox','syncReads','syncPages','syncRecords'].map(t=>db.table(t).toArray()));
  legacy.version(12).stores(Object.fromEntries(db.tables.filter(t=>!['operatorState','syncImages','syncCoverage','syncCanonical','syncApplications','syncAdmissions','syncSessions','joinSessions','scopeRecoveries'].includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(const t of legacy.tables)await legacy.table(t.name).bulkPut(await db.table(t.name).toArray());legacy.close();const upgraded=new MiseDatabase(legacy.name);databases.push(upgraded);expect(backupToken(await upgraded.readBackup())).toBe(before);expect(await Promise.all(['cloudState','outbox','syncReads','syncPages','syncRecords'].map(t=>upgraded.table(t).toArray()))).toEqual(internal);expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.operatorState.count()).toBe(0);expect((await upgraded.setup())?.owner.id).toBe(fixture.target.actorId);
 }finally{await journal.delete();legacy.close();if(!databases.some(db=>db.name===legacy.name))await legacy.delete();}
},15000);
