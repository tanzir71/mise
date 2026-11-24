import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {openScreenJournal,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createKitchenScreenSession} from '../apps/web/src/data/kitchen-screen-session';
import {createKitchenSavedSession} from '../apps/web/src/data/kitchen-saved-session';
import {kitchenReadScope,parseKitchenReadStatus} from '../packages/core/kitchen-read-status';
import {appendKitchenTap} from '../packages/core/kitchen-screen';
import {newKitchenId,prepareKitchenAction} from '../packages/core/kitchen';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
import {bindCommandReceipt} from '../apps/web/src/data/command-request';
const opened:ScreenJournal[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const journal of opened.splice(0))journal.close();});
async function fixture(){const f=await kitchenScreenFixture(),factory=new IDBFactory(),journal=await openScreenJournal('/denial/app/',factory);opened.push(journal);const record=await journal.replace(await journal.read(),f.screen);await journal.replaceKitchen(record,null,f.state);return {...f,factory,journal,record};}
function changes(f:Awaited<ReturnType<typeof fixture>>){return {v:1,access:f.access,at:f.now,outletName:f.page.outletName,warningMinutes:f.page.warningMinutes,watermark:7,nextSeq:7,tickets:[],removed:[]};}
it('an actual read denial persists through native reload and blocks cached display, gestures and delivery without discarding originals',async()=>{
 const f=await fixture(),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),queued=appendKitchenTap(f.state,f.ticket,action,newKitchenId());await f.journal.replaceKitchen(f.record,f.state,queued);
 const send=vi.fn(async()=>new Response('{}',{status:403})),first=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});await expect(first.pull()).rejects.toMatchObject({kind:'auth'});first.dispose();
 const status=await f.journal.readKitchenReadStatus(f.record);expect(status).toMatchObject({...kitchenReadScope(f.record),denied:true});expect(await f.journal.readKitchen(f.record)).toEqual(queued);f.journal.close();
 const journal=await openScreenJournal('/denial/app/',f.factory);opened.push(journal);send.mockClear();const reader=createKitchenScreenSession(journal,f.record,{blank:async()=>{},now:()=>f.now,send});
 await expect(reader.load()).rejects.toMatchObject({kind:'auth'});await expect(reader.tap(f.ticket,'kitchen.acknowledge')).rejects.toMatchObject({kind:'auth'});await expect(reader.deliver()).rejects.toMatchObject({kind:'auth'});expect(send).not.toHaveBeenCalled();
 const own=createKitchenSavedSession(journal,f.record,{blank:async()=>{},now:()=>f.now,send});expect(await own.load()).toEqual(queued.taps);await own.close(queued.taps[0]);expect((await own.load())[0].closeIntents).toHaveLength(1);expect(send).not.toHaveBeenCalled();own.dispose();reader.dispose();
});
it('clears a known denial only after a newly verified current HTTP read is committed with its source',async()=>{
 const f=await fixture(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send:vi.fn(async()=>Response.json(changes(f)))});await reader.blockRead();const before=await f.journal.readKitchenReadStatus(f.record);
 await expect(reader.load()).rejects.toMatchObject({kind:'auth'});await reader.pull();const after=await f.journal.readKitchenReadStatus(f.record);expect(after).toMatchObject({denied:false});expect(after!.revision).not.toBe(before!.revision);expect(await reader.load()).toMatchObject({access:f.access,tickets:f.state.tickets});reader.dispose();
});
it('does not clear denial from a failed, malformed or permissionless read',async()=>{
 const f=await fixture();for(const result of [()=>new Response('{}',{status:503}),()=>Response.json({...changes(f),extra:true}),()=>Response.json({...changes(f),access:{...f.access,permissions:[]}})]){
  const reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send:vi.fn(async()=>result())});await reader.blockRead();const before=await f.journal.readKitchenReadStatus(f.record);await expect(reader.pull()).rejects.toThrow();expect(await f.journal.readKitchenReadStatus(f.record)).toEqual(before);await expect(reader.load()).rejects.toMatchObject({kind:'auth'});reader.dispose();
 }
});
it.each(['same controller','sibling tab'] as const)('a late authorized response cannot erase a newer denial from the %s',async kind=>{
 const f=await fixture();let release!:(value:Response)=>void;const held=new Promise<Response>(resolve=>{release=resolve;}),send=vi.fn(()=>held),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send}),waiting=reader.pull();
 await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());if(kind==='same controller')await reader.blockRead();else await f.journal.denyKitchenRead(f.record);const denied=await f.journal.readKitchenReadStatus(f.record);
 release(Response.json(changes(f)));await expect(waiting).rejects.toMatchObject({kind:'auth'});expect(await f.journal.readKitchenReadStatus(f.record)).toMatchObject({denied:true});expect((await f.journal.readKitchenReadStatus(f.record))!.revision).not.toBeNull();expect(denied!.denied).toBe(true);expect(await f.journal.readKitchen(f.record)).toEqual(f.state);await expect(reader.load()).rejects.toMatchObject({kind:'auth'});reader.dispose();
});
it('cannot clear a newer native denial with the same old false-status snapshot',async()=>{
 const f=await fixture();await f.journal.denyKitchenRead(f.record);const observed=await f.journal.readKitchenReadStatus(f.record),authorization=bindCommandReceipt(changes(f),()=>{});await f.journal.replaceKitchen(f.record,f.state,f.state,{readFence:{observed,clear:true,authorization}});const prior=await f.journal.readKitchenReadStatus(f.record);expect(prior!.denied).toBe(false);
 await f.journal.denyKitchenRead(f.record);const newer=await f.journal.readKitchenReadStatus(f.record);await expect(f.journal.replaceKitchen(f.record,f.state,{...f.state,revision:newKitchenId()},{readFence:{observed:prior,clear:true,authorization}})).rejects.toMatchObject({kind:'changed'});expect(await f.journal.readKitchenReadStatus(f.record)).toEqual(newer);expect(await f.journal.readKitchen(f.record)).toEqual(f.state);
});
it('cannot clear native denial with a serialized or missing live response proof',async()=>{
 const f=await fixture();await f.journal.denyKitchenRead(f.record);const observed=await f.journal.readKitchenReadStatus(f.record);
 for(const authorization of [undefined,changes(f)])await expect(f.journal.replaceKitchen(f.record,f.state,f.state,{readFence:{observed,clear:true,authorization}})).rejects.toThrow();
 expect(await f.journal.readKitchenReadStatus(f.record)).toEqual(observed);expect(await f.journal.readKitchen(f.record)).toEqual(f.state);
});
it('atomically rolls back both the replacement page and denial clearing when native saving fails',async()=>{
 const f=await fixture(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send:vi.fn(async()=>Response.json(changes(f)))});await reader.blockRead();const before=await f.journal.readKitchenReadStatus(f.record),put=IDBObjectStore.prototype.put;
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<typeof put>){if((args[0] as {denied?:boolean}).denied===false)throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);});
 await expect(reader.pull()).rejects.toMatchObject({kind:'unavailable'});expect(await f.journal.readKitchenReadStatus(f.record)).toEqual(before);expect(await f.journal.readKitchen(f.record)).toEqual(f.state);await expect(reader.load()).rejects.toMatchObject({kind:'auth'});reader.dispose();
});
it('retains the current memory denial when its native status cannot be saved',async()=>{
 const f=await fixture(),send=vi.fn(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});
 await expect(reader.blockRead()).rejects.toMatchObject({kind:'unavailable'});await expect(reader.load()).rejects.toMatchObject({kind:'auth'});await expect(reader.tap(f.ticket,'kitchen.acknowledge')).rejects.toMatchObject({kind:'auth'});expect(send).not.toHaveBeenCalled();expect(await f.journal.readKitchen(f.record)).toEqual(f.state);reader.dispose();
});
it('keeps negative status separate for later PIN sessions and never moves it to another member',async()=>{
 const f=await fixture();await f.journal.denyKitchenRead(f.record);if(f.screen.phase!=='signed-in')throw Error();const later=await f.journal.replace(f.record,{...f.screen,session:{...f.session,id:newKitchenId(),memberId:newKitchenId()},attemptId:newKitchenId()});expect(await f.journal.readKitchenReadStatus(later)).toBeNull();
 await expect(f.journal.denyKitchenRead(f.record)).rejects.toMatchObject({kind:'changed'});await f.journal.denyKitchenRead(later);expect(await f.journal.readKitchenReadStatus(later)).toMatchObject({memberId:later.state.phase==='signed-in'?later.state.session.memberId:null,denied:true});expect(await f.journal.readKitchen(later)).toEqual(f.state);
});
it('a PIN switch while an authorized read is in flight cannot change the next member’s denial or historical cache',async()=>{
 const f=await fixture();let release!:(value:Response)=>void;const held=new Promise<Response>(resolve=>{release=resolve;}),send=vi.fn(()=>held),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send}),waiting=reader.pull();await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());
 if(f.screen.phase!=='signed-in')throw Error();const later=await f.journal.replace(f.record,{...f.screen,session:{...f.session,id:newKitchenId(),memberId:newKitchenId()},attemptId:newKitchenId()});await f.journal.denyKitchenRead(later);const denied=await f.journal.readKitchenReadStatus(later);release(Response.json(changes(f)));await expect(waiting).rejects.toThrow();expect(await f.journal.readKitchenReadStatus(later)).toEqual(denied);expect(await f.journal.readKitchen(later)).toEqual(f.state);reader.dispose();
});
it('strictly parses only complete original-scope metadata and rejects credential or authority extras',async()=>{
 const f=await fixture();await f.journal.denyKitchenRead(f.record);const status=(await f.journal.readKitchenReadStatus(f.record))!;expect(parseKitchenReadStatus(status,f.record)).toEqual(status);
 for(const patch of [{pin:'0042'},{permissions:['orders.read']},{revision:'invalid'},{denied:1},{memberId:newKitchenId()},{businessId:newKitchenId()},{outletId:newKitchenId()},{deviceId:newKitchenId()},{sessionId:newKitchenId()}])expect(()=>parseKitchenReadStatus({...status,...patch},f.record)).toThrow();
});
it('a sibling denial arriving immediately before a native gesture commit cannot admit fresh preparation work',async()=>{
 const f=await fixture(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now}),replace=f.journal.replaceKitchen.bind(f.journal);
 vi.spyOn(f.journal,'replaceKitchen').mockImplementation(async(...args)=>{await f.journal.denyKitchenRead(f.record);return replace(...args);});
 await expect(reader.tap(f.ticket,'kitchen.acknowledge')).rejects.toMatchObject({kind:'auth'});expect(await f.journal.readKitchen(f.record)).toEqual(f.state);reader.dispose();
});
it('an asynchronous native guard cannot clear denial or commit an authorized page',async()=>{
 const f=await fixture();await f.journal.denyKitchenRead(f.record);const observed=await f.journal.readKitchenReadStatus(f.record),authorization=bindCommandReceipt(changes(f),()=>{});
 await expect(f.journal.replaceKitchen(f.record,f.state,{...f.state,revision:newKitchenId()},{assertCurrent:async()=>{},readFence:{observed,clear:true,authorization}})).rejects.toMatchObject({kind:'changed'});expect(await f.journal.readKitchenReadStatus(f.record)).toEqual(observed);expect(await f.journal.readKitchen(f.record)).toEqual(f.state);
});
it('opening another view and closing its journal cannot abort a denial already observed by this current PIN',async()=>{
 const f=await fixture(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now}),saving=reader.blockRead();reader.dispose();f.journal.close();await saving;
 const journal=await openScreenJournal('/denial/app/',f.factory);opened.push(journal);expect(await journal.readKitchenReadStatus(f.record)).toMatchObject({denied:true});expect(await journal.readKitchen(f.record)).toEqual(f.state);
});
it('a denial observed by a view that lost its native PIN cannot mark the next member’s scope',async()=>{
 const f=await fixture(),reader=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});if(f.screen.phase!=='signed-in')throw Error();const later=await f.journal.replace(f.record,{...f.screen,session:{...f.session,id:newKitchenId(),memberId:newKitchenId()},attemptId:newKitchenId()});
 await expect(reader.blockRead()).rejects.toMatchObject({kind:'changed'});expect(await f.journal.readKitchenReadStatus(later)).toBeNull();expect(await f.journal.readKitchen(later)).toEqual(f.state);reader.dispose();
});
