import {createECDH,randomBytes} from 'node:crypto';
import Dexie from 'dexie';
import {IDBFactory,IDBKeyRange,IDBObjectStore as NativeObjectStore} from 'fake-indexeddb';
import {generateVAPIDKeys} from 'web-push';
import {afterEach,expect,it,vi} from 'vitest';
import {DeskCache,deskDatabaseName,deskProfileScope,type DeskBinding} from '../apps/web/src/data/desk-cache';
import {deskRegistrationFingerprint,deskRegistrationPayload,type DeskOperation} from '../apps/web/src/data/desk-operation';
import {bindDeskReceipt} from '../apps/web/src/data/desk-proof';
import {createDeskRemote} from '../apps/web/src/data/desk-remote';
import {cloudAuthStorageKey} from '../packages/core/cloud-connection';
import {completeDeskTaskList,parseDeskTaskPage,deskTaskListWire} from '../packages/core/desk-tasks';
import {testCommandAccount} from './command-account-fixture';
import {deskPage,deskId as id} from './desk-task-fixture';
const base='/mise/app/',opened:Dexie[]=[],uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const original:DeskBinding={id:'active',version:1,revision:1,phase:'active',businessId:id(1),outletId:id(2),actorId:id(3),role:'owner',connection:{targetHash:'a'.repeat(64),authKey:'mise.cloud.auth.'+'b'.repeat(64),accountHash:'c'.repeat(64),epoch:uuid(9),scopeVersion:uuid(10)}};
const metadata=(subscriptionId:string)=>({v:1 as const,id:subscriptionId,businessId:id(1),outletId:id(2),memberId:id(3),createdAt:1000,expiresAt:null,revokedAt:null});
function browserSource(){const point=createECDH('prime256v1');point.generateKeys();return {applicationKey:generateVAPIDKeys().publicKey,subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-only',expirationTime:null,keys:{p256dh:point.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}};}
async function fixture(binding=original){
 const factory=new IDBFactory(),cache=new DeskCache(base,{indexedDB:factory,IDBKeyRange});opened.push(cache);let alive=true;
 const guard=()=>{if(!alive)throw Error('Original phone account changed');};
 const receipt=<T extends object>(value:T,scope=binding)=>bindDeskReceipt(structuredClone(value),guard,{accountHash:scope.connection.accountHash,targetHash:scope.connection.targetHash,scope:deskProfileScope(scope)});
 const list=receipt(completeDeskTaskList(parseDeskTaskPage({...deskPage([1,2]),access:deskProfileScope(binding)},deskProfileScope(binding))));
 const saved=await cache.activate(await cache.pointer(),binding,list),source=browserSource(),fingerprint=await deskRegistrationFingerprint(source);
 const current=async()=>{const result=await cache.read(binding);if(!result)throw Error('No active desk');return result;};
 const register=(event=6,subscriptionId=5)=>({eventId:id(event),request:{kind:'register' as const,subscriptionId:id(subscriptionId),...fingerprint}});
 const registration=(op:DeskOperation)=>{if(op.request.kind!=='register')throw Error('Expected register');return receipt({action:'register' as const,id:op.request.subscriptionId,eventId:op.id,subscription:metadata(op.request.subscriptionId)},op.binding);};
 const withdrawal=(op:DeskOperation)=>{if(op.request.kind!=='revoke')throw Error('Expected withdrawal');return receipt({action:'revoke' as const,id:op.request.subscriptionId,eventId:op.id,subscription:null},op.binding);};
 return {factory,cache,binding,saved,source,fingerprint,guard,receipt,current,register,registration,withdrawal,expire:()=>{alive=false;}};
}
afterEach(()=>{for(const cache of opened)cache.close();opened.length=0;vi.restoreAllMocks();});
it('preserves a version-one private profile and active pointer when adding the durable journal',async()=>{
 const f=await fixture(),factory=new IDBFactory(),old=new Dexie(deskDatabaseName(base),{indexedDB:factory,IDBKeyRange});opened.push(old);old.version(1).stores({profiles:'&id',active:'&id'});
 const {choiceRevision:unused,...legacy}=f.saved.profile;void unused;await old.table('profiles').put({...legacy,v:1,tasks:deskTaskListWire(f.saved.profile.tasks)});await old.table('active').put(f.saved.pointer);old.close();
 const upgraded=new DeskCache(base,{indexedDB:factory,IDBKeyRange});opened.push(upgraded);expect(await upgraded.read(original)).toEqual({...f.saved,profile:{...f.saved.profile,choiceRevision:f.saved.profile.revision}});expect(await upgraded.operations.count()).toBe(0);expect(upgraded.verno).toBe(3);
});
it('upgrades a version-two journal without changing its original pending registration or preventing its genuine confirmation',async()=>{
 const f=await fixture(),operation=await f.cache.queueOperation(f.saved,f.register()),saved=(await f.cache.read(original))!,factory=new IDBFactory(),old=new Dexie(deskDatabaseName(base),{indexedDB:factory,IDBKeyRange});opened.push(old);old.version(1).stores({profiles:'&id',active:'&id'});old.version(2).stores({operations:'&id,profileId,&[profileId+sequence]'});
 const {choiceRevision:unused,...legacy}=saved.profile;void unused;await old.table('profiles').put({...legacy,v:1,tasks:deskTaskListWire(saved.profile.tasks)});await old.table('active').put(saved.pointer);await old.table('operations').put(operation);old.close();
 const upgraded=new DeskCache(base,{indexedDB:factory,IDBKeyRange});opened.push(upgraded);expect(await upgraded.operationHistory(original)).toEqual([operation]);expect((await upgraded.read(original))?.profile.choiceRevision).toBe(operation.id);await upgraded.confirmOperation(operation,f.registration(operation),f.guard);expect((await upgraded.read(original))?.profile.enabled).toBe(true);
});
it('saves original registration fingerprints before delivery and recovers the exact action after close/reopen without copying capabilities',async()=>{
 const f=await fixture(),request=f.register(),operation=await f.cache.queueOperation(f.saved,request,f.guard);f.cache.close();
 const recovered=new DeskCache(base,{indexedDB:f.factory,IDBKeyRange});opened.push(recovered);expect(await recovered.pendingOperations(original)).toEqual([operation]);expect(await recovered.queueOperation(f.saved,request)).toEqual(operation);
 const stored=JSON.stringify(await recovered.operations.toArray());for(const secret of [f.source.applicationKey,f.source.subscription.endpoint,f.source.subscription.keys.auth,f.source.subscription.keys.p256dh])expect(stored).not.toContain(secret);
 expect(stored).not.toMatch(/access_token|refresh_token|jwt|publishableKey|apiUrl/);expect(await deskRegistrationPayload(operation,f.source)).toEqual({id:id(5),eventId:id(6),...f.source});
});
it('mutes offline and journals closure of every possibly registered original setup while retaining the complete Inbox',async()=>{
 const f=await fixture(),first=await f.cache.queueOperation(f.saved,f.register()),second=await f.cache.queueOperation(await f.current(),f.register(8,7));
 const withdrawals=await f.cache.disable(await f.current());expect(withdrawals.map(row=>row.request)).toEqual([{kind:'revoke',subscriptionId:id(5)},{kind:'revoke',subscriptionId:id(7)}]);
 expect((await f.current()).profile).toMatchObject({enabled:false,subscription:null});expect((await f.current()).profile.tasks).toEqual(f.saved.profile.tasks);expect((await f.cache.pointer()).profileId).toBe(f.saved.profile.id);
 expect(await f.cache.pendingOperations(original)).toEqual(withdrawals);const history=await f.cache.operationHistory(original);expect(history.slice(0,2)).toEqual([first,second]);
 expect(await f.cache.disable(await f.current())).toEqual(withdrawals);expect(await f.cache.operations.count()).toBe(4);
 f.cache.close();const recovered=new DeskCache(base,{indexedDB:f.factory,IDBKeyRange});opened.push(recovered);expect(await recovered.pendingOperations(original)).toEqual(withdrawals);
});
it('cannot re-enable or replace a newer subscription when the earlier registration result arrives after Disable',async()=>{
 const f=await fixture(),old=await f.cache.queueOperation(f.saved,f.register()),[withdrawal]=await f.cache.disable(await f.current()),newer=await f.cache.queueOperation(await f.current(),f.register(8,7));
 await f.cache.confirmOperation(newer,f.registration(newer),f.guard);expect((await f.current()).profile).toMatchObject({enabled:true,subscription:{id:id(7)}});
 await f.cache.confirmOperation(old,f.registration(old),f.guard);expect((await f.current()).profile).toMatchObject({enabled:true,subscription:{id:id(7)}});
 await f.cache.confirmOperation(withdrawal,f.withdrawal(withdrawal),f.guard);expect((await f.current()).profile).toMatchObject({enabled:true,subscription:{id:id(7)}});
 expect((await f.cache.operationHistory(original)).every(row=>row.receipt!==null)).toBe(true);
});
it('requires a live original mutation receipt and cannot treat read absence, another event, or serialized proof as a completed withdrawal',async()=>{
 const f=await fixture();await f.cache.queueOperation(f.saved,f.register());const [withdrawal]=await f.cache.disable(await f.current()),proof=f.withdrawal(withdrawal);
 await expect(f.cache.confirmOperation(withdrawal,f.receipt({action:'read',id:id(5),subscription:null}))).rejects.toThrow();
 await expect(f.cache.confirmOperation(withdrawal,f.receipt({...proof,eventId:id(99)}))).rejects.toThrow();
 await expect(f.cache.confirmOperation(withdrawal,structuredClone(proof))).rejects.toMatchObject({kind:'review'});
 await f.cache.confirmOperation(withdrawal,proof);expect(await f.cache.pendingOperations(original)).toEqual([]);
});
it('records a genuine registration outcome as history without a native activation guard and requires a new explicit setup to enable',async()=>{
 const f=await fixture(),op=await f.cache.queueOperation(f.saved,f.register()),proof=f.registration(op);await f.cache.confirmOperation(op,proof);
 expect((await f.current()).profile.enabled).toBe(false);await f.cache.confirmOperation(op,proof,f.guard);expect((await f.current()).profile.enabled).toBe(false);
 const next=await f.cache.queueOperation(await f.current(),f.register(8,7));await f.cache.confirmOperation(next,f.registration(next),f.guard);expect((await f.current()).profile.enabled).toBe(true);
});
it('retains an original inactive-account outcome without changing the newer account or its active pointer',async()=>{
 const f=await fixture(),op=await f.cache.queueOperation(f.saved,f.register()),other={...original,connection:{...original.connection,targetHash:'d'.repeat(64),accountHash:'e'.repeat(64)}};
 const list=f.receipt(completeDeskTaskList(parseDeskTaskPage({...deskPage([3]),access:deskProfileScope(other)},deskProfileScope(other))),other),selected=await f.cache.activate((await f.current()).pointer,other,list);
 await f.cache.confirmOperation(op,f.registration(op),f.guard);expect(await f.cache.read(other)).toEqual(selected);expect(await f.cache.read(original)).toBeNull();expect((await f.cache.operationHistory(original))[0].receipt).not.toBeNull();
});
it('does not let a prior setup enable presentation after retirement and reactivation of the same visible account',async()=>{
 const f=await fixture(),op=await f.cache.queueOperation(f.saved,f.register()),empty=await f.cache.retire((await f.current()).pointer);
 const list=f.receipt(completeDeskTaskList(parseDeskTaskPage(deskPage([1,2]),deskProfileScope(original))));await f.cache.activate(empty,original,list);
 await f.cache.confirmOperation(op,f.registration(op),f.guard);expect((await f.current()).profile.enabled).toBe(false);
});
it('rolls back notification activation and its receipt when native phone continuity changes inside the journal writer',async()=>{
 const f=await fixture(),op=await f.cache.queueOperation(f.saved,f.register()),before=await f.current();f.cache.operations.hook('updating',()=>{f.expire();});
 await expect(f.cache.confirmOperation(op,f.registration(op),f.guard)).rejects.toThrow('Original phone account changed');expect(await f.current()).toEqual(before);expect((await f.cache.operationHistory(original))[0].receipt).toBeNull();
});
it('rolls back every new withdrawal if native storage fails while muting the profile',async()=>{
 const f=await fixture(),op=await f.cache.queueOperation(f.saved,f.register());await f.cache.confirmOperation(op,f.registration(op),f.guard);const before=await f.current(),put=NativeObjectStore.prototype.put;
 vi.spyOn(NativeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){if(this.name==='profiles')throw new DOMException('Native quota reached','QuotaExceededError');return key===undefined?put.call(this,value):put.call(this,value,key);});
 await expect(f.cache.disable(before)).rejects.toThrow('Native quota reached');expect(await f.current()).toEqual(before);expect(await f.cache.operations.count()).toBe(1);expect(before.profile.enabled).toBe(true);
});
it('rejects competing stale setup writers without losing the original committed operation',async()=>{
 const f=await fixture(),other=new DeskCache(base,{indexedDB:f.factory,IDBKeyRange});opened.push(other);
 const results=await Promise.allSettled([f.cache.queueOperation(f.saved,f.register()),other.queueOperation(f.saved,f.register(8,7))]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(await f.cache.operations.count()).toBe(1);
});
it('keeps original warning settings and event through a lost reply without manufacturing a newer task snapshot',async()=>{
 const f=await fixture(),input={eventId:id(9),request:{kind:'settings' as const,enabled:true,minutes:4,revision:0}},operation=await f.cache.queueOperation(f.saved,input);input.request.minutes=8;
 expect((await f.cache.pendingOperations(original))[0].request).toEqual({kind:'settings',enabled:true,minutes:4,revision:0});
 const proof=f.receipt({action:'settings',outletId:original.outletId,eventId:id(9),enabled:true,minutes:4,revision:1,expectedRevision:0,updatedAt:4000});
 await expect(f.cache.confirmOperation(operation,f.receipt({...proof,expectedRevision:1}))).rejects.toThrow();await f.cache.confirmOperation(operation,proof,f.guard);
 expect((await f.current()).profile.tasks).toEqual(f.saved.profile.tasks);expect(await f.cache.pendingOperations(original)).toEqual([]);
});
it('never reuses an earlier setup or event for a replacement browser source',async()=>{
 const f=await fixture(),operation=await f.cache.queueOperation(f.saved,f.register()),changed={...f.source,subscription:{...f.source.subscription,endpoint:'https://fcm.googleapis.com/fcm/send/replaced'}};
 await expect(deskRegistrationPayload(operation,changed)).rejects.toThrow();await expect(deskRegistrationPayload(operation,{...f.source,applicationKey:generateVAPIDKeys().publicKey})).rejects.toThrow();
 await expect(f.cache.queueOperation(f.saved,{...f.register(),request:{...f.register().request,subscriptionHash:'d'.repeat(64)}})).rejects.toMatchObject({kind:'changed'});
 await f.cache.disable(await f.current());await expect(f.cache.queueOperation(await f.current(),f.register(8,5))).rejects.toMatchObject({kind:'changed'});
});
it('cannot bypass a durable Disable with a subsequent valid metadata-only refresh',async()=>{
 const f=await fixture(),operation=await f.cache.queueOperation(f.saved,f.register());await f.cache.confirmOperation(operation,f.registration(operation),f.guard);await f.cache.disable(await f.current());
 await expect(f.cache.setSubscription(await f.current(),f.receipt(metadata(id(5))),true,f.guard)).rejects.toMatchObject({kind:'changed'});expect((await f.current()).profile.enabled).toBe(false);
});
it('recovers and confirms an original journal entry using the production account-bound HTTP transport after reload',async()=>{
 const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},account=testCommandAccount(config,async()=> 'original.phone.signature');
 const binding={...original,connection:{...original.connection,accountHash:account.accountHash,targetHash:account.targetHash,authKey:await cloudAuthStorageKey(config,account.scope)}},f=await fixture(binding),operation=await f.cache.queueOperation(f.saved,f.register());
 f.cache.close();const recovered=new DeskCache(base,{indexedDB:f.factory,IDBKeyRange});opened.push(recovered);const send=vi.fn<typeof fetch>(async()=>Response.json(metadata(id(5)))),remote=createDeskRemote(config,account,deskProfileScope(binding),send),[pending]=await recovered.pendingOperations(binding);
 const payload=await deskRegistrationPayload(pending,f.source),result=await remote.register(payload);await recovered.confirmOperation(pending,result,f.guard);
 expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({action:'register',...payload,outletId:binding.outletId});expect((await recovered.read(binding))?.profile).toMatchObject({enabled:true,subscription:{id:id(5)}});
 expect((await recovered.operationHistory(binding))[0].id).toBe(operation.id);expect(JSON.stringify(await recovered.operations.toArray())).not.toContain('original.phone.signature');
});
