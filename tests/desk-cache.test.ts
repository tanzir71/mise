import {IDBFactory,IDBKeyRange,IDBObjectStore as NativeObjectStore} from 'fake-indexeddb';
import {afterEach,expect,it,vi} from 'vitest';
import {DeskCache,deskDatabaseName,deskProfileScope,type DeskBinding} from '../apps/web/src/data/desk-cache';
import {bindDeskReceipt} from '../apps/web/src/data/desk-proof';
import {bindCommandReceipt} from '../apps/web/src/data/command-request';
import {createDeskRemote} from '../apps/web/src/data/desk-remote';
import {testCommandAccount} from './command-account-fixture';
import {cloudAuthStorageKey} from '../packages/core/cloud-connection';
import {parseDeskTaskPage,completeDeskTaskList} from '../packages/core/desk-tasks';
import {deskPage,deskId as id} from './desk-task-fixture';
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),base='/mise/app/',opened:DeskCache[]=[];
const original:DeskBinding={id:'active',version:1,revision:1,phase:'active',businessId:id(1),outletId:id(2),actorId:id(3),role:'owner',
 connection:{targetHash:'a'.repeat(64),authKey:'mise.cloud.auth.'+'b'.repeat(64),accountHash:'c'.repeat(64),epoch:uuid(9),scopeVersion:uuid(10)}};
const metadata={v:1 as const,id:id(5),businessId:id(1),outletId:id(2),memberId:id(3),createdAt:1000,expiresAt:null,revokedAt:null};
async function fixture(){
 const factory=new IDBFactory(),cache=new DeskCache(base,{indexedDB:factory,IDBKeyRange});opened.push(cache);let revoked=false;
 const guard=()=>{if(revoked)throw Error('Original phone account changed');};
 const receipt=<T extends object>(value:T,binding=original)=>bindDeskReceipt(structuredClone(value),guard,{accountHash:binding.connection.accountHash,targetHash:binding.connection.targetHash,scope:deskProfileScope(binding)});
 const list=(numbers=[1],binding=original,patch:Record<string,unknown>={})=>receipt(completeDeskTaskList(parseDeskTaskPage({...deskPage(numbers),access:deskProfileScope(binding),...patch},deskProfileScope(binding))),binding);
 const pointer=await cache.pointer();return {cache,factory,pointer,list,receipt,revoke:()=>{revoked=true;}};
}
afterEach(()=>{for(const cache of opened)cache.close();opened.length=0;vi.restoreAllMocks();});
it('commits a verified complete list in its private database and recovers it after close and reopen without credentials or capability keys',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1,2,3]));f.cache.close();
 const reopened=new DeskCache(base,{indexedDB:f.factory,IDBKeyRange});opened.push(reopened);expect(await reopened.read(original)).toEqual(saved);
 const stored=JSON.stringify(await reopened.profiles.toArray());expect(stored).not.toMatch(/access_token|refresh_token|jwt|endpoint|p256dh|publishableKey|apiUrl/);expect(reopened.name).toBe('mise.desk.v1:/mise/app/');
});
it('does not activate or replace a profile from serialized metadata or a generic unbound receipt',async()=>{
 const f=await fixture(),list=f.list();await expect(f.cache.activate(f.pointer,original,structuredClone(list))).rejects.toMatchObject({kind:'review'});
 const generic=bindCommandReceipt(structuredClone(list),()=>{});await expect(f.cache.activate(f.pointer,original,generic)).rejects.toMatchObject({kind:'auth'});expect(await f.cache.pointer()).toEqual(f.pointer);expect(await f.cache.read(original)).toBeNull();
});
it.each(['accountHash','targetHash'] as const)('does not activate the same visible IDs with another original %s',async field=>{
 const f=await fixture(),changed={...original,connection:{...original.connection,[field]:'d'.repeat(64)}};
 await expect(f.cache.activate(f.pointer,changed,f.list())).rejects.toMatchObject({kind:'auth'});expect(await f.cache.read(original)).toBeNull();
});
it('does not replace a cached complete list with a partial page or an unverified empty copy',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1,2]));
 const partial=f.receipt(parseDeskTaskPage(deskPage([3],true),deskProfileScope(original)));
 await expect(f.cache.replaceTasks(saved,partial as never)).rejects.toThrow('complete task list');await expect(f.cache.replaceTasks(saved,structuredClone(f.list([])))).rejects.toMatchObject({kind:'review'});
 expect(await f.cache.read(original)).toEqual(saved);
});
it('rejects an older complete response and permits clearing only from a newer verified exhaustive result',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1,2]));await expect(f.cache.replaceTasks(saved,f.list([],original,{version:11}))).rejects.toMatchObject({kind:'changed'});
 expect(await f.cache.read(original)).toEqual(saved);const cleared=await f.cache.replaceTasks(saved,f.list([],original,{version:13,at:4000}));expect(cleared.profile.tasks.tasks).toEqual([]);expect(await f.cache.read(original)).toEqual(cleared);
});
it('rejects a late writer after another account or connection has become active',async()=>{
 const f=await fixture(),initial=await f.cache.activate(f.pointer,original,f.list([1])),saved=await f.cache.setSubscription(initial,f.receipt(metadata),true),other={...original,connection:{...original.connection,targetHash:'d'.repeat(64),accountHash:'e'.repeat(64)}};
 const current=await f.cache.activate(saved.pointer,other,f.list([3],other));expect(await f.cache.read(original)).toBeNull();
 await expect(f.cache.replaceTasks(saved,f.list([]))).rejects.toMatchObject({kind:'changed'});await expect(f.cache.retire(saved.pointer)).rejects.toMatchObject({kind:'changed'});expect(await f.cache.read(other)).toEqual(current);
 expect(await f.cache.profiles.get(saved.profile.id)).toMatchObject({enabled:false,subscription:metadata});
});
it('aborts a real native write when original phone continuity changes inside the table writer',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1]));f.cache.profiles.hook('updating',()=>{f.revoke();});
 await expect(f.cache.replaceTasks(saved,f.list([],original,{version:13,at:4000}))).rejects.toThrow('Original phone account changed');expect(await f.cache.read(original)).toEqual(saved);
});
it('rolls back both profile and active pointer when native quota fails after the first store write',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1])),other={...original,connection:{...original.connection,targetHash:'d'.repeat(64)}};
 const originalPut=NativeObjectStore.prototype.put;
 vi.spyOn(NativeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){if(this.name==='active')throw new DOMException('Native quota reached','QuotaExceededError');return key===undefined?originalPut.call(this,value):originalPut.call(this,value,key);});
 await expect(f.cache.activate(saved.pointer,other,f.list([3],other))).rejects.toThrow('Native quota reached');expect(await f.cache.read(original)).toEqual(saved);expect(await f.cache.profiles.count()).toBe(1);
});
it('requires original scoped subscription metadata and a live HTTP proof before enabling notifications',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list());await expect(f.cache.setSubscription(saved,metadata,true)).rejects.toMatchObject({kind:'review'});
 await expect(f.cache.setSubscription(saved,f.receipt({...metadata,memberId:id(9)}),true)).rejects.toMatchObject({kind:'changed'});
 const enabled=await f.cache.setSubscription(saved,f.receipt(metadata),true);expect(enabled.profile.enabled).toBe(true);expect(enabled.profile.subscription).toEqual(metadata);
 await expect(f.cache.setSubscription(enabled,f.receipt({...metadata,revokedAt:2000}),true)).rejects.toMatchObject({kind:'changed'});
 await expect(f.cache.setSubscription(enabled,f.receipt({id:id(99),subscription:null}),false)).rejects.toMatchObject({kind:'changed'});
 const removed=await f.cache.setSubscription(enabled,f.receipt({id:metadata.id,subscription:{...metadata,revokedAt:2000}}),false);expect(removed.profile.enabled).toBe(false);
});
it('retires notification presentation locally after sign-out without a network token and retains the original cached source',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1])),enabled=await f.cache.setSubscription(saved,f.receipt(metadata),true);f.revoke();
 const retired=await f.cache.retire(enabled.pointer);expect(retired.profileId).toBeNull();expect(await f.cache.read(original)).toBeNull();const stored=await f.cache.profiles.toArray();expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({enabled:false,subscription:metadata});
});
it('separates root and Pages private stores and rejects ambiguous base paths',()=>{
 expect(deskDatabaseName('/app/')).not.toBe(deskDatabaseName('/mise/app/'));for(const value of ['app/','/app','/app/../','/app/?scope','/app/\\'])expect(()=>deskDatabaseName(value)).toThrow();
});
it('commits a complete result from the production account-bound HTTP client without serializing its runtime proof or phone JWT',async()=>{
 const f=await fixture(),config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},account=testCommandAccount(config,async()=> 'original.phone.signature');
 const binding={...original,connection:{...original.connection,accountHash:account.accountHash,targetHash:account.targetHash,authKey:await cloudAuthStorageKey(config,account.scope)}};
 const remote=createDeskRemote(config,account,deskProfileScope(binding),async()=>Response.json(deskPage([1,2]))),list=await remote.tasks();
 const saved=await f.cache.activate(f.pointer,binding,list);expect((await f.cache.read(binding))?.profile.tasks.tasks).toHaveLength(2);
 expect(JSON.stringify(await f.cache.profiles.toArray())).not.toContain('original.phone.signature');await expect(f.cache.replaceTasks(saved,structuredClone(list))).rejects.toMatchObject({kind:'review'});
});
it('does not accept a complete HTTP object that was altered after its actual proof was bound',async()=>{
 const f=await fixture(),saved=await f.cache.activate(f.pointer,original,f.list([1,2])),changed=f.list([1,2],original,{version:13,at:4000});changed.tasks=[];
 await expect(f.cache.replaceTasks(saved,changed)).rejects.toMatchObject({kind:'review'});expect(await f.cache.read(original)).toEqual(saved);
});
