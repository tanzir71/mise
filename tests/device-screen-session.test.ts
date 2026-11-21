import {beforeAll,beforeEach,afterAll,afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createPairingDatabase,deviceId,type PairingDatabase} from './device-pairing-fixture';
import {createDeviceAccessHandler,type DeviceAccessStore} from '../supabase/functions/_shared/device-access-handler';
import {createDevicePinHandler} from '../supabase/functions/_shared/device-pin-handler';
import {openScreenJournal,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createDeviceScreenSession} from '../apps/web/src/data/device-screen-session';
import {newInboxId} from '../packages/core/inbox';
import type {ScreenJournalRecord} from '../packages/core/device-screen-state';
let f:PairingDatabase;const connection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'},base='/mise/app/',origin='https://shop.test';
const opened:ScreenJournal[]=[];
beforeAll(async()=>{f=await createPairingDatabase();},30_000);beforeEach(async()=>{await f.seed();});afterEach(()=>{for(const j of opened.splice(0))j.close();vi.restoreAllMocks();});afterAll(async()=>{await f?.db.close();});
function server(){
 const store:DeviceAccessStore={request:(id,code,parent,hash)=>f.asRole(null,'service_role','select public.request_device_pairing($1,$2,$3,$4) data',[id,code,parent,hash]),poll:(id,secret)=>f.asRole(null,'service_role','select public.read_device_pairing($1,$2) data',[id,secret]),directory:f.directoryRead,session:(secret,token)=>f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[secret,token]),logout:(secret,token,event)=>f.asRole(null,'service_role','select public.end_device_session($1,$2,$3) data',[secret,token,event]),reset:(secret,id,attempt)=>f.asRole(null,'service_role','select public.reset_device_signins($1,$2,$3) data',[secret,id,attempt])},access=createDeviceAccessHandler({store,origins:new Set([origin])}),pin=createDevicePinHandler({store:{begin:(attempt,secret,member)=>f.asRole(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attempt,secret,member]),finish:(secret,attempt,proof,session,event)=>f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[secret,attempt,proof,session,event])},origins:new Set([origin]),peppers:new Map([['v1',f.pepper]])});
 return vi.fn<typeof fetch>(async(url,options)=>{const headers=new Headers(options?.headers);headers.set('Origin',origin);const request=new Request(String(url),{...options,headers});return new URL(String(url)).pathname.endsWith('/device-pin')?pin(request):access(request);});
}
async function boot(){
 const factory=new IDBFactory(),journal=await openScreenJournal(base,factory);opened.push(journal);const send=server(),blank=vi.fn(async()=>{}),screen=createDeviceScreenSession(journal,{blank,send});return {factory,journal,send,blank,screen};
}
async function paired(){
 const fixture=await boot(),{pairing}=await f.start(),empty=await fixture.screen.load(),prepared=await fixture.screen.prepare(empty,connection,pairing.code,pairing.id),waiting=await fixture.screen.pair(prepared);if(prepared.state.phase!=='pairing')throw Error();
 await f.asRole(1,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairing.id,prepared.state.source.requestId,waiting.saved.state.phase==='pairing'?waiting.saved.state.receipt!.verification:'',newInboxId()]);
 const ready=(await fixture.screen.pair(waiting.saved)).saved;expect(ready.state.phase).toBe('enrolled');return {...fixture,ready,prepared};
}
it('the complete flow saves the original screen secret before HTTP, pairs by comparison, signs in and clears server/local access',async()=>{
 const t=await boot(),{pairing}=await f.start(),prepared=await t.screen.prepare(await t.screen.load(),connection,pairing.code,pairing.id);expect(t.send).not.toHaveBeenCalled();expect(await t.journal.read()).toEqual(prepared);
 const real=t.send.getMockImplementation()!;t.send.mockImplementation(async(...args)=>{expect((await t.journal.read()).state.phase).toBe('pairing');return real(...args);});
 const waiting=await t.screen.pair(prepared);if(waiting.saved.state.phase!=='pairing')throw Error();await f.asRole(1,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairing.id,waiting.saved.state.source.requestId,waiting.saved.state.receipt!.verification,newInboxId()]);const ready=(await t.screen.pair(waiting.saved)).saved;t.send.mockImplementation(real);
 expect((await t.screen.directory(ready)).members.map(m=>m.id)).toEqual([deviceId(104),deviceId(105)]);const signed=await t.screen.signIn(ready,deviceId(105),'0042');expect((await t.screen.access(signed)).permissions).toEqual(['orders.acknowledge','orders.read','orders.ready']);expect(JSON.stringify(signed)).not.toContain('"pin"');
 const ended=await t.screen.reset(signed);expect(ended.state.phase).toBe('enrolled');await expect(t.screen.access(signed)).rejects.toMatchObject({kind:'changed'});expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions where revoked_at is null')).rows[0].n).toBe(0);
});
it('lost request/approval responses recover the original pending identity without generating another secret or invitation',async()=>{
 const t=await boot(),{pairing}=await f.start(),prepared=await t.screen.prepare(await t.screen.load(),connection,pairing.code,pairing.id),real=t.send.getMockImplementation()!;t.send.mockImplementation(async(...args)=>{const result=await real(...args);if(JSON.parse(args[1]?.body as string).action==='request')throw Error('Lost reply');return result;});
 await expect(t.screen.pair(prepared)).rejects.toMatchObject({kind:'retry'});expect(await t.journal.read()).toEqual(prepared);if(prepared.state.phase!=='pairing')throw Error();const claims=await f.asRole<{requests:{verification:string}[]}>(1,'authenticated','select public.inspect_device_pairing($1) data',[pairing.id]);await f.asRole(1,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairing.id,prepared.state.source.requestId,claims.requests[0].verification,newInboxId()]);
 t.send.mockImplementation(real);const recovered=await t.screen.pair(prepared);expect(recovered.outcome).toBe('approved');if(recovered.saved.state.phase!=='enrolled')throw Error();expect(recovered.saved.state.credential.token).toBe(prepared.state.source.token);expect(t.send.mock.calls.filter(([,options])=>JSON.parse(options?.body as string).action==='request')).toHaveLength(1);
});
it('a PIN response lost after SQL finish retains a PIN-free recovery source, and lost reset replies retry the same sign-out ID',async()=>{
 const t=await paired(),real=t.send.getMockImplementation()!;t.send.mockImplementation(async(...args)=>{const result=await real(...args);if(String(args[0]).endsWith('/device-pin'))throw Error('Lost successful PIN response');return result;});
 await expect(t.screen.signIn(t.ready,deviceId(105),'0042')).rejects.toMatchObject({kind:'retry'});const pending=await t.journal.read();expect(pending.state.phase).toBe('signing-in');expect(JSON.stringify(pending)).not.toContain('"pin"');
 t.send.mockImplementation(async(...args)=>{await real(...args);throw Error('Lost successful reset response');});await expect(t.screen.reset(pending)).rejects.toMatchObject({kind:'retry'});const reset=await t.journal.read();expect(reset.state.phase).toBe('resetting');const firstBody=t.send.mock.calls.at(-1)![1]?.body;
 t.send.mockImplementation(real);const ready=await t.screen.reset(reset);expect(t.send.mock.calls.at(-1)![1]?.body).toBe(firstBody);expect(ready.state.phase).toBe('enrolled');expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions where revoked_at is null')).rows[0].n).toBe(0);expect((await t.screen.signIn(ready,deviceId(105),'0042')).state.phase).toBe('signed-in');
});
it('another tab can retire a durable PIN attempt before its delayed HTTP reaches SQL',async()=>{
 const t=await paired(),real=t.send.getMockImplementation()!;let release!:()=>void,started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.send.mockImplementation(async(...args)=>{if(String(args[0]).endsWith('/device-pin')){started();await gate;}return real(...args);});
 const signing=t.screen.signIn(t.ready,deviceId(105),'0042'),checked=expect(signing).rejects.toThrow();await reached;const other=await openScreenJournal(base,t.factory);opened.push(other);const replacement=createDeviceScreenSession(other,{blank:t.blank,send:t.send}),current=await replacement.load(),reset=await replacement.reset(current);expect(reset.state.phase).toBe('enrolled');release();await checked;
 expect(await t.journal.read()).toEqual(reset);expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions')).rows[0].n).toBe(0);replacement.dispose();
});
it('a native quota failure after successful PIN authentication keeps the attempt recoverable and clears its orphaned server session',async()=>{
 const t=await paired(),original=IDBObjectStore.prototype.put,spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){if(value&&typeof value==='object'&&'state'in value&&(value as ScreenJournalRecord).state.phase==='signed-in')throw new DOMException('Full','QuotaExceededError');return key===undefined?original.call(this,value):original.call(this,value,key);});
 await expect(t.screen.signIn(t.ready,deviceId(105),'0042')).rejects.toMatchObject({kind:'unavailable'});spy.mockRestore();const pending=await t.journal.read();expect(pending.state.phase).toBe('signing-in');expect((await t.screen.reset(pending)).state.phase).toBe('enrolled');expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions where revoked_at is null')).rows[0].n).toBe(0);
});
it('an owner profile appearing mid-request cannot receive a local staff grant, but cleanup can still retire the attempt',async()=>{
 const t=await paired(),real=t.send.getMockImplementation()!;let mixed=false;t.blank.mockImplementation(async()=>{if(mixed)throw Object.assign(Error('Use separate profile'),{kind:'owner'});});t.send.mockImplementation(async(...args)=>{const result=await real(...args);if(String(args[0]).endsWith('/device-pin'))mixed=true;return result;});
 await expect(t.screen.signIn(t.ready,deviceId(105),'0042')).rejects.toMatchObject({kind:'owner'});await expect(t.screen.load()).rejects.toMatchObject({kind:'owner'});const pending=await t.screen.loadForCleanup();expect(pending.state.phase).toBe('signing-in');expect((await t.screen.reset(pending,true)).state.phase).toBe('empty');expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions where revoked_at is null')).rows[0].n).toBe(0);
});
it('a stopped route and stale source cannot save late approval or use already-signed staff access',async()=>{
 const t=await paired(),signed=await t.screen.signIn(t.ready,deviceId(105),'0042');t.screen.dispose();await expect(t.screen.access(signed)).rejects.toMatchObject({kind:'changed'});const next=createDeviceScreenSession(t.journal,{blank:t.blank,send:t.send});expect((await next.access(signed)).memberId).toBe(deviceId(105));await next.reset(signed,true);await expect(next.access(signed)).rejects.toMatchObject({kind:'changed'});next.dispose();
});
it('closing the route during a delayed PIN request retains recovery and a later reset prevents its server grant',async()=>{
 const t=await paired(),real=t.send.getMockImplementation()!;let started!:()=>void,release!:()=>void,finished!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),terminal=new Promise<void>(resolve=>{finished=resolve;});
 t.send.mockImplementation(async(...args)=>{if(String(args[0]).endsWith('/device-pin')){started();await gate;try{return await real(...args);}finally{finished();}}return real(...args);});
 const signing=t.screen.signIn(t.ready,deviceId(105),'0042'),checked=expect(signing).rejects.toThrow();await reached;t.screen.dispose();await checked;const retained=await t.journal.read();expect(retained.state.phase).toBe('signing-in');
 const resumed=createDeviceScreenSession(t.journal,{blank:t.blank,send:t.send});expect((await resumed.reset(retained)).state.phase).toBe('enrolled');release();await terminal;expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions')).rows[0].n).toBe(0);resumed.dispose();
});
