import {beforeAll,beforeEach,afterAll,afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createStaffDeviceFixture,staffDeviceConnection} from './staff-device-fixture';
import {deviceId} from './device-pairing-fixture';
import {openScreenJournal,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createDeviceScreenSession} from '../apps/web/src/data/device-screen-session';
import {createStaffDeviceSession} from '../apps/web/src/data/staff-device-session';
import {newInboxId} from '../packages/core/inbox';
import type {ScreenJournalRecord} from '../packages/core/device-screen-state';
let f:Awaited<ReturnType<typeof createStaffDeviceFixture>>;const opened:ScreenJournal[]=[];
beforeAll(async()=>{f=await createStaffDeviceFixture();},30000);beforeEach(async()=>{await f.seed();await f.configure();});afterEach(()=>{opened.splice(0).forEach(j=>j.close());vi.restoreAllMocks();});afterAll(async()=>{await f?.db.close();});
async function setup(){
 const factory=new IDBFactory(),journal=await openScreenJournal('/mise/app/',factory);opened.push(journal);let send:typeof fetch=f.transport();const fetcher:typeof fetch=(u,o)=>send(u,o),blank=vi.fn(async()=>{}),screen=createDeviceScreenSession(journal,{blank,send:fetcher});
 const {pairing}=await f.start(),prepared=await screen.prepare(await screen.load(),staffDeviceConnection,pairing.code,pairing.id),waiting=await screen.pair(prepared);if(waiting.saved.state.phase!=='pairing')throw Error();
 await f.asRole(1,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairing.id,waiting.saved.state.source.requestId,waiting.saved.state.receipt!.verification,newInboxId()]);
 const paired=await screen.pair(waiting.saved),signed=await screen.signIn(paired.saved,deviceId(105),'0042'),attendance=await createStaffDeviceSession(journal,signed,{blank,send:fetcher});
 return {factory,journal,screen,signed,attendance,blank,fetcher,setSend:(next:typeof fetch)=>{send=next;}};
}
it('reads actual own history and outlet roster, then commits one native original, check-in and audit',async()=>{
 const t=await setup(),view=await t.attendance.read(),board=await t.attendance.board();expect(board.members.map(m=>m.name)).toContain('Karim Uddin');expect(t.attendance.canPrepare).toBe(true);
 const intent=await t.attendance.prepare(view,'in'),before=await t.journal.readAttendance(t.signed);expect(before?.actions[0].intent).toEqual(intent);expect(before?.actions[0].outcome).toBeNull();
 const outcome=await t.attendance.call(intent.id,'submit');expect(outcome.state).toBe('applied');expect(await t.attendance.call(intent.id,'submit')).toEqual(outcome);expect((await t.attendance.read()).latest).toEqual(outcome.checkIn);
 const saved=await t.journal.readAttendance(t.signed);expect(saved?.actions[0]).toMatchObject({intent,outcome,origin:{memberId:deviceId(105)},screenRevision:t.signed.revision});expect(JSON.stringify(saved)).not.toContain('"pin":');expect(JSON.stringify(saved)).not.toContain('sb_publishable');
 expect((await f.db.query<{n:number}>('select count(*)::int n from public.check_ins')).rows[0].n).toBe(1);
});
it('retains an unknown original after lost completion and recovers its exact outcome across reload',async()=>{
 const t=await setup(),view=await t.attendance.read(),intent=await t.attendance.prepare(view,'in'),normal=f.transport();let lost=true;
 t.setSend(async(u,o)=>{const response=await normal(u,o);if(lost){lost=false;throw Error('PRIVATE lost reply');}return response;});await expect(t.attendance.call(intent.id,'submit')).rejects.toThrow();
 expect(t.attendance.saved().actions[0].outcome).toBeNull();t.attendance.stop();t.setSend(normal);const resumed=await createStaffDeviceSession(t.journal,t.signed,{blank:t.blank,send:t.fetcher});expect(resumed.canPrepare).toBe(false);expect((await resumed.call(intent.id,'inspect')).state).toBe('applied');expect((await f.db.query<{n:number}>('select count(*)::int n from public.check_ins')).rows[0].n).toBe(1);resumed.stop();
});
it('saves closure offline before HTTP, fences delayed submission and keeps all original fields',async()=>{
 const t=await setup(),view=await t.attendance.read(),intent=await t.attendance.prepare(view,'in'),original=t.attendance.saved().actions[0];t.setSend(async()=>{throw Error('offline');});await expect(t.attendance.call(intent.id,'close')).rejects.toThrow();expect(t.attendance.saved().actions[0]).toEqual({...original,closeRequested:true});
 t.attendance.stop();t.setSend(f.transport());const next=await createStaffDeviceSession(t.journal,t.signed,{blank:t.blank,send:t.fetcher});expect((await next.call(intent.id,'submit')).state).toBe('closed');expect((await f.db.query<{n:number}>('select count(*)::int n from public.check_ins')).rows[0].n).toBe(0);next.stop();
});
it('a fresh PIN for the same member can inspect or close an old original but cannot silently submit it',async()=>{
 const t=await setup(),intent=await t.attendance.prepare(await t.attendance.read(),'in');t.attendance.stop();const reset=await t.screen.reset(t.signed),nextSource=await t.screen.signIn(reset,deviceId(105),'0042'),next=await createStaffDeviceSession(t.journal,nextSource,{blank:t.blank,send:t.fetcher});expect(next.saved().view).toBeNull();expect(next.saved().actions[0].intent).toEqual(intent);expect(next.canRetry(intent.id)).toBe(false);
 await expect(next.call(intent.id,'submit')).rejects.toMatchObject({kind:'review'});expect((await next.call(intent.id,'inspect')).state).toBe('pending');expect((await next.call(intent.id,'close')).state).toBe('closed');next.stop();
});
it('a different PIN member sees none of the prior member’s private originals or cached shift',async()=>{
 const t=await setup(),intent=await t.attendance.prepare(await t.attendance.read(),'in');await f.configure(deviceId(104),{role:'staff'});t.attendance.stop();const reset=await t.screen.reset(t.signed),signed=await t.screen.signIn(reset,deviceId(104),'0042'),other=await createStaffDeviceSession(t.journal,signed,{blank:t.blank,send:t.fetcher});expect(other.saved()).toMatchObject({view:null,actions:[]});await expect(other.call(intent.id,'inspect')).rejects.toMatchObject({kind:'changed'});other.stop();
 const raw=await t.journal.read();expect(raw.state.phase).toBe('signed-in');
});
it('two native connections retain the first original and cannot append a second pending tap',async()=>{
 const t=await setup(),otherJournal=await openScreenJournal('/mise/app/',t.factory);opened.push(otherJournal);const other=await createStaffDeviceSession(otherJournal,t.signed,{blank:t.blank,send:t.fetcher}),a=await t.attendance.read(),b=await other.read();const results=await Promise.allSettled([t.attendance.prepare(a,'in'),other.prepare(b,'in')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await t.journal.readAttendance(t.signed))?.actions).toHaveLength(1);other.stop();
});
it('quota failure prevents a new HTTP effect and retains the old native record',async()=>{
 const t=await setup(),view=await t.attendance.read(),before=await t.journal.readAttendance(t.signed),send=vi.fn(f.transport());t.setSend(send);const original=IDBObjectStore.prototype.put;
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,v:unknown,k?:IDBValidKey){if(this.name==='attendance')throw new DOMException('PRIVATE quota','QuotaExceededError');return k===undefined?original.call(this,v):original.call(this,v,k);});
 await expect(t.attendance.prepare(view,'in')).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(await t.journal.readAttendance(t.signed)).toEqual(before);
});
it('a response completing after sign-out or profile ownership change cannot attach a receipt to another session',async()=>{
 const t=await setup(),intent=await t.attendance.prepare(await t.attendance.read(),'in'),normal=f.transport();let release!:()=>void,reached!:()=>void;const entered=new Promise<void>(r=>{reached=r;}),wait=new Promise<void>(r=>{release=r;});t.setSend(async(u,o)=>{const r=await normal(u,o);if(new URL(String(u)).pathname.endsWith('/staff-device')){reached();await wait;}return r;});
 const work=t.attendance.call(intent.id,'submit'),checked=expect(work).rejects.toThrow();await entered;await t.screen.reset(t.signed);release();await checked;
 const setupNow=await t.journal.read();expect(setupNow.state.phase).toBe('enrolled');
});
it('removing the live method denies fresh roster and taps while retaining the saved original',async()=>{
 const t=await setup(),intent=await t.attendance.prepare(await t.attendance.read(),'in');await f.configure(deviceId(105),{methods:[]});await expect(t.attendance.board()).rejects.toMatchObject({kind:'auth'});await expect(t.attendance.call(intent.id,'submit')).rejects.toMatchObject({kind:'auth'});expect(t.attendance.saved().actions[0].intent).toEqual(intent);expect((await t.attendance.call(intent.id,'close')).state).toBe('closed');
});
it('an owner profile blocks before HTTP without discarding a pending attendance original',async()=>{
 const t=await setup(),intent=await t.attendance.prepare(await t.attendance.read(),'in'),send=vi.fn(f.transport());t.setSend(send);t.blank.mockRejectedValueOnce(Error('Owner profile'));
 await expect(t.attendance.call(intent.id,'submit')).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(t.attendance.saved().actions[0].intent).toEqual(intent);
});
it('refuses altered cached scope and schema fields without overwriting the complete retained data',async()=>{
 const t=await setup();await t.attendance.read();const before=(await t.journal.readAttendance(t.signed))!;await expect(t.journal.replaceAttendance(t.signed,before,{...before,id:'different'})).rejects.toThrow();expect(await t.journal.readAttendance(t.signed)).toEqual(before);
 const changed=structuredClone(t.signed) as ScreenJournalRecord;if(changed.state.phase!=='signed-in')throw Error();changed.state.session.memberId=deviceId(104);await expect(t.journal.readAttendance(changed)).rejects.toMatchObject({kind:'changed'});
});
