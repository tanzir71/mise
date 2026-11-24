import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {openScreenJournal,assertBlankScreenProfile,screenJournalDatabaseName} from '../apps/web/src/data/device-screen-journal';
import {deviceSecretHash} from '../packages/core/device-access';
import {parseScreenState,type ScreenState} from '../packages/core/device-screen-state';
const base='/mise/app/',connection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'},id=(n:number)=>String(n).padStart(26,'0');
const storage=(entries:Record<string,string>={})=>({get length(){return Object.keys(entries).length;},key:(i:number)=>Object.keys(entries)[i]??null,getItem:(key:string)=>entries[key]??null});
async function pairing():Promise<ScreenState>{const token='D'.repeat(43);return {phase:'pairing',source:{connection,requestId:id(5),token,tokenHash:await deviceSecretHash(token),code:'123456',pairingId:id(10)},receipt:null};}
async function db(factory:IDBFactory,name:string,table='state'){
 return new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open(name);request.onupgradeneeded=()=>request.result.createObjectStore(table,{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function write(database:IDBDatabase,table:string,value:unknown){await new Promise<void>((resolve,reject)=>{const tx=database.transaction(table,'readwrite');tx.objectStore(table).put(value);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}
it('upgrades an actual version-two screen without replacing its complete state or kitchen bytes',async()=>{
 const factory=new IDBFactory(),name=screenJournalDatabaseName(base),old=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(name,2);r.onupgradeneeded=()=>{for(const store of ['state','kitchen'])r.result.createObjectStore(store,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const state={v:1,id:'current',revision:id(90),state:await pairing()},kitchen={id:id(5),legacy:['intact',0,'কর্মী'],original:'Do not replace during schema upgrade'};await write(old,'state',state);await write(old,'kitchen',kitchen);old.close();
 const upgraded=await openScreenJournal(base,factory);expect(await upgraded.read()).toEqual(state);const raw=await db(factory,name);expect(raw.version).toBe(4);expect(Array.from(raw.objectStoreNames)).toEqual(['attendance','kitchen','state','stock']);const kept=await new Promise<unknown>(resolve=>{const r=raw.transaction('kitchen').objectStore('kitchen').get(id(5));r.onsuccess=()=>resolve(r.result);});expect(kept).toEqual(kitchen);raw.close();upgraded.close();
});
afterEach(()=>vi.restoreAllMocks());
it('persists the original pairing secret and identity across close/reopen, separate from every owner store',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),empty=await journal.read(),state=await pairing(),saved=await journal.replace(empty,state);journal.close();
 const reopened=await openScreenJournal(base,factory);expect(await reopened.read()).toEqual(saved);expect(saved.revision).not.toBe(empty.revision);expect(await factory.databases()).toEqual([{name:screenJournalDatabaseName(base),version:4}]);reopened.close();
});
it('two tabs competing for one empty screen cannot install different credentials',async()=>{
 const factory=new IDBFactory(),a=await openScreenJournal(base,factory),b=await openScreenJournal(base,factory),old=await a.read(),source=await pairing();
 const outcomes=await Promise.allSettled([a.replace(old,source),b.replace(old,source)]);expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(v=>v.status==='rejected')).toMatchObject([{reason:{kind:'changed'}}]);expect((await a.read()).state).toEqual(source);a.close();b.close();
});
it('retains an empty tombstone revision so an earlier response cannot pass after local forgetting',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),first=await journal.read(),saved=await journal.replace(first,await pairing()),empty=await journal.replace(saved,{phase:'empty'});
 expect(empty.revision).not.toBe(first.revision);await expect(journal.replace(first,await pairing())).rejects.toMatchObject({kind:'changed'});expect(await journal.read()).toEqual(empty);journal.close();
});
it('a quota failure aborts the complete write and preserves the original durable source',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),original=await journal.read(),put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('PRIVATE QUOTA DETAIL','QuotaExceededError');});
 await expect(journal.replace(original,await pairing())).rejects.toMatchObject({kind:'unavailable'});put.mockRestore();expect(await journal.read()).toEqual(original);journal.close();
});
it('a route generation change before the native source read aborts the write and retains the old record',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),empty=await journal.read(),source=await pairing();let active=true;
 const writing=journal.replace(empty,source,{assertCurrent:()=>{if(!active)throw Error('PRIVATE route ended');}});active=false;await expect(writing).rejects.toMatchObject({kind:'changed'});expect(await journal.read()).toEqual(empty);journal.close();
});
it('an aborted native write cannot publish credentials after its route closes',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),empty=await journal.read(),source=await pairing(),controller=new AbortController();
 const writing=journal.replace(empty,source,{signal:controller.signal});controller.abort();await expect(writing).rejects.toMatchObject({kind:'changed'});expect(await journal.read()).toEqual(empty);journal.close();
});
it('complete-source comparison catches changed bytes even if a stale tab retains the same revision',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),saved=await journal.replace(await journal.read(),await pairing()),raw=await db(factory,journal.name),changed=structuredClone(saved);if(changed.state.phase!=='pairing')throw Error();changed.state.source.code='654321';await write(raw,'state',changed);raw.close();
 await expect(journal.assertCurrent(saved)).rejects.toMatchObject({kind:'changed'});await expect(journal.replace(saved,{phase:'empty'})).rejects.toMatchObject({kind:'changed'});expect(await journal.read()).toEqual(changed);journal.close();
});
it('damaged secret/hash bindings cannot silently become a fresh pairing or overwrite the retained record',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),saved=await journal.replace(await journal.read(),await pairing()),raw=await db(factory,journal.name),changed=structuredClone(saved);if(changed.state.phase!=='pairing')throw Error();changed.state.source.token='Z'.repeat(43);await write(raw,'state',changed);raw.close();
 await expect(journal.read()).rejects.toMatchObject({kind:'damaged'});await expect(journal.replace(saved,{phase:'empty'})).rejects.toMatchObject({kind:'changed'});journal.close();
});
it('PINs, owner sessions and hidden extra fields are refused by the dedicated native schema',async()=>{
 const source=await pairing();for(const patch of [{pin:'0042'},{ownerJwt:'PRIVATE'},{phase:'signed-in'},{connection}])expect(()=>parseScreenState({...source,...patch})).toThrow();
 expect(()=>screenJournalDatabaseName('/app/?credential=PRIVATE')).toThrow();expect(screenJournalDatabaseName('/app/')).not.toBe(screenJournalDatabaseName(base));
});
it('blank-profile inspection never creates a shop database and allows an empty existing one',async()=>{
 const factory=new IDBFactory();await assertBlankScreenProfile(storage(),factory);expect(await factory.databases()).toEqual([]);const owner=await db(factory,'mise-local','inboxItems');owner.close();await assertBlankScreenProfile(storage(),factory);expect((await factory.databases()).map(v=>v.name)).toEqual(['mise-local']);
});
it.each(['inboxItems','businesses','outbox'])('existing owner %s rows block enrollment and remain untouched',async table=>{
 const factory=new IDBFactory(),owner=await db(factory,'mise-local',table);await write(owner,table,{id:'kept',content:'Original shop/share data'});owner.close();await expect(assertBlankScreenProfile(storage(),factory)).rejects.toMatchObject({kind:'owner'});
 const reopened=await db(factory,'mise-local',table),read=await new Promise<unknown>(resolve=>{const r=reopened.transaction(table).objectStore(table).get('kept');r.onsuccess=()=>resolve(r.result);});expect(read).toEqual({id:'kept',content:'Original shop/share data'});reopened.close();
});
it.each(['mise-local:/mise/app/','mise-local:/another/app/','mise-cloud-uploads','mise-cloud-uploads:/mise/app/'])('existing production/scoped owner database %s blocks enrollment',async name=>{
 const factory=new IDBFactory(),owner=await db(factory,name,'original');await write(owner,'original',{id:'kept',content:'Original offline shop'});owner.close();await expect(assertBlankScreenProfile(storage(),factory)).rejects.toMatchObject({kind:'owner'});expect((await factory.databases()).map(v=>v.name)).toEqual([name]);
});
it.each(['mise.cloud.connection.v1','mise.cloud.auth.original'])('existing %s prevents shared enrollment without reading or deleting its contents',async key=>{
 const factory=new IDBFactory(),entries={[key]:'PRIVATE runtime value'};await expect(assertBlankScreenProfile(storage(entries),factory)).rejects.toMatchObject({kind:'owner'});expect(entries[key]).toBe('PRIVATE runtime value');expect(await factory.databases()).toEqual([]);
});
it('unsupported or unreadable profile storage blocks a network-capable screen',async()=>{
 const factory=new IDBFactory();vi.spyOn(factory,'databases').mockRejectedValue(Error('PRIVATE database path'));await expect(assertBlankScreenProfile(storage(),factory)).rejects.toMatchObject({kind:'unavailable'});
 await expect(assertBlankScreenProfile({get length():number{throw Error('PRIVATE');},key:()=>null,getItem:()=>null},new IDBFactory())).rejects.toMatchObject({kind:'unavailable'});
});
it('closing a journal blocks writes while a fresh opener can retain and resume the existing record',async()=>{
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory),saved=await journal.replace(await journal.read(),await pairing());journal.close();await expect(journal.replace(saved,{phase:'empty'})).rejects.toMatchObject({kind:'unavailable'});const next=await openScreenJournal(base,factory);expect(await next.read()).toEqual(saved);next.close();
});
