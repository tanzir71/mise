import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {openScreenJournal,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createKitchenSavedSession} from '../apps/web/src/data/kitchen-saved-session';
import {appendKitchenTap,beginOwnKitchenTapClose,kitchenScreenWire,parseKitchenScreenState,type KitchenTap} from '../packages/core/kitchen-screen';
import {newKitchenId,prepareKitchenAction,type KitchenReceipt} from '../packages/core/kitchen';
import {retainedKitchenTap} from '../packages/core/kitchen-recovery';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
const journals:ScreenJournal[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const journal of journals.splice(0))journal.close();});
async function fixture(){
  const f=await kitchenScreenFixture(),factory=new IDBFactory(),journal=await openScreenJournal('/saved-test/app/',factory);journals.push(journal);
  const record=await journal.replace(await journal.read(),f.screen),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),state=appendKitchenTap(f.state,f.ticket,action,newKitchenId());
  await journal.replaceKitchen(record,null,state);return {...f,factory,journal,record,state,tap:state.taps[0]};
}
function response(f:Awaited<ReturnType<typeof fixture>>,access=f.access,outcome:'pending'|'accepted'|'closed'='pending',extra:object={}){
  return {v:1,access,at:f.now,original:retainedKitchenTap(f.tap),outcome,receipt:null,closure:null,...extra};
}
it('returns only own original taps, including earlier PIN sessions when the cached board belongs to someone else',async()=>{
  const f=await fixture(),otherMember=newKitchenId(),otherSession=newKitchenId(),another={...f.tap,position:2,action:{...f.tap.action,id:newKitchenId()},access:{...f.access,memberId:otherMember,sessionId:otherSession}};
  const mixed={...f.state,nextPosition:3,access:another.access,taps:[f.tap,another]};await f.journal.replaceKitchen(f.record,f.state,mixed);
  if(f.screen.phase!=='signed-in')throw Error();const later=await f.journal.replace(f.record,{...f.screen,attemptId:newKitchenId(),session:{...f.session,id:newKitchenId(),token:'L'.repeat(43)}});
  const send=vi.fn(),reader=createKitchenSavedSession(f.journal,later,{blank:async()=>{},now:()=>f.now,send});
  expect(await reader.load()).toEqual([f.tap]);expect(send).not.toHaveBeenCalled();const rows=await reader.close(f.tap);expect(rows).toHaveLength(1);expect(rows[0].closeIntents?.[0].access).toMatchObject({memberId:f.session.memberId,permissions:[]});
  const saved=(await f.journal.readKitchen(later))!;expect(saved.access).toEqual(mixed.access);expect(saved.tickets).toEqual(f.state.tickets);expect(saved.taps[1]).toMatchObject(another);expect(saved.taps[0].source).toEqual(f.tap.source);
  await expect(reader.close(another)).rejects.toThrow();expect(send).not.toHaveBeenCalled();reader.dispose();
});
it('keeps a native offline No across reload and sends only that exact closure with current PIN authorization',async()=>{
  const f=await fixture(),send=vi.fn(),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});
  const rows=await reader.close(f.tap),intent=rows[0].closeIntents![0];expect(send).not.toHaveBeenCalled();reader.dispose();
  const closure={v:1,id:intent.id,type:'kitchen.tap-closed',businessId:f.access.businessId,outletId:f.access.outletId,deviceId:f.device.id,originalSessionId:f.session.id,originalMemberId:f.session.memberId,action:f.tap.action,sessionId:f.session.id,memberId:f.session.memberId,occurredAt:intent.occurredAt,closedAt:f.now};
  send.mockImplementation(async(url,init)=>{expect(String(url)).toMatch(/\/kitchen-recovery$/);expect(JSON.parse(init.body)).toMatchObject({action:'close',original:retainedKitchenTap(f.tap),resolution:{id:intent.id,occurredAt:intent.occurredAt,memberId:f.session.memberId}});return Response.json(response(f,{...f.access,permissions:[]},'closed',{closure}));});
  const reopened=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send}),done=await reopened.check((await reopened.load())[0]);expect(done[0].closure).toEqual(closure);expect(done[0].source).toEqual(f.tap.source);expect(done[0].action).toEqual(f.tap.action);expect(send).toHaveBeenCalledTimes(1);reopened.dispose();
});
it('looks up an earlier PIN closure without borrowing its reviewer or automatically creating a new choice',async()=>{
  const f=await fixture(),first=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await first.close(f.tap);first.dispose();if(f.screen.phase!=='signed-in')throw Error();
  const session={...f.session,id:newKitchenId(),token:'L'.repeat(43)},record=await f.journal.replace(f.record,{...f.screen,session,attemptId:newKitchenId()}),access={...f.access,sessionId:session.id,permissions:[]};
  const send=vi.fn(async(_url,init)=>{expect(JSON.parse(init!.body as string)).toEqual({action:'lookup',sessionToken:session.token,original:retainedKitchenTap(f.tap)});return Response.json(response(f,access));});
  const reader=createKitchenSavedSession(f.journal,record,{blank:async()=>{},now:()=>f.now,send});await reader.check((await reader.load())[0]);expect((await reader.load())[0].closeIntents).toHaveLength(1);reader.dispose();
});
it('retains a historical accepted receipt when a No raced its lost original reply',async()=>{
  const f=await fixture(),receipt:KitchenReceipt={v:1,id:f.tap.action.id,type:'kitchen.acknowledge',businessId:f.access.businessId,outletId:f.access.outletId,deviceId:f.device.id,sessionId:f.session.id,memberId:f.session.memberId,orderId:f.ticket.id,contentHash:f.ticket.contentHash,parentAckId:null,sourceRevision:f.ticket.revision,revision:f.ticket.revision+1,status:'cooking',occurredAt:f.now,acceptedAt:f.now,transitionEventIds:[]};
  const send=vi.fn(async()=>Response.json(response(f,{...f.access,permissions:[]},'accepted',{receipt}))),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});
  await reader.close(f.tap);const rows=await reader.check((await reader.load())[0]);expect(rows[0].receipt).toEqual(receipt);expect(rows[0].closure).toBeNull();expect(rows[0].closeIntents).toHaveLength(1);reader.dispose();
});
it('cannot close another member through the pure personal-history helper',async()=>{
  const f=await fixture();expect(()=>beginOwnKitchenTapClose(f.state,f.tap,{id:newKitchenId(),access:{...f.access,memberId:newKitchenId(),permissions:[]},occurredAt:f.now},newKitchenId())).toThrow();
});
it.each(['member','device','outlet','business','source'] as const)('rejects a forged original %s without HTTP or a native change',async key=>{
  const f=await fixture(),send=vi.fn(),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send}),tap:KitchenTap=structuredClone(f.tap);
  if(key==='source')tap.source.number='Changed';else tap.access[key==='member'?'memberId':key==='device'?'deviceId':key==='outlet'?'outletId':'businessId']=newKitchenId();
  await expect(reader.close(tap)).rejects.toThrow();await expect(reader.check(tap)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(await f.journal.readKitchen(f.record)).toEqual(f.state);reader.dispose();
});
it('fails closed after a native PIN switch while a confirmation reply is in flight',async()=>{
  const f=await fixture();let release!:(value:Response)=>void;const held=new Promise<Response>(resolve=>{release=resolve;}),send=vi.fn(()=>held),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});
  const waiting=reader.check(f.tap);await vi.waitFor(()=>expect(send).toHaveBeenCalled());if(f.screen.phase!=='signed-in')throw Error();const next=await f.journal.replace(f.record,{...f.screen,attemptId:newKitchenId(),session:{...f.session,id:newKitchenId(),memberId:newKitchenId()}});
  release(Response.json(response(f)));await expect(waiting).rejects.toThrow();await expect(reader.load()).rejects.toThrow();expect(await f.journal.readKitchen(next)).toEqual(f.state);reader.dispose();
});
it('does not send or claim a closure when the native write fails',async()=>{
  const f=await fixture(),send=vi.fn(),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send}),put=IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<typeof put>){if(this.name==='kitchen')throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);});
  await expect(reader.close(f.tap)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(await reader.load()).toEqual([f.tap]);reader.dispose();
});
it('keeps the original and native close after a lost close reply, with no fresh preparation request',async()=>{
  const f=await fixture(),send=vi.fn(async()=>{throw new TypeError('Lost reply');}),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});const rows=await reader.close(f.tap);await expect(reader.check(rows[0])).rejects.toThrow();
  const saved=(await reader.load())[0];expect(saved.closeIntents).toHaveLength(1);expect(saved.receipt).toBeNull();expect(saved.source).toEqual(f.tap.source);reader.dispose();expect(send).toHaveBeenCalledTimes(1);
});
it('strictly roundtrips the original board after a personal closure while never changing its actor or capabilities',async()=>{
  const f=await fixture(),reader=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await reader.close(f.tap);const saved=(await f.journal.readKitchen(f.record))!;
  expect(await parseKitchenScreenState(kitchenScreenWire(saved))).toEqual(saved);expect(saved.access).toEqual(f.access);reader.dispose();
});
it('blocks expired or disposed sessions and an owner browser before reading personal sources',async()=>{
  const f=await fixture(),expired=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.session.expiresAt});await expect(expired.load()).rejects.toThrow();expired.dispose();
  const owner=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{throw Error('Owner profile');},now:()=>f.now});await expect(owner.load()).rejects.toThrow('Owner profile');owner.dispose();
  const stopped=createKitchenSavedSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});stopped.dispose();await expect(stopped.close(f.tap)).rejects.toThrow();
});
