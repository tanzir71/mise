import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {openScreenJournal,screenJournalDatabaseName,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createKitchenScreenSession} from '../apps/web/src/data/kitchen-screen-session';
import {appendKitchenTap,finishKitchenTap,kitchenScreenWire,parseKitchenScreenState,receiveKitchenChanges,receiveKitchenPage} from '../packages/core/kitchen-screen';
import {newKitchenId,prepareKitchenAction,type KitchenReceipt} from '../packages/core/kitchen';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
import {beginKitchenTapClose,finishKitchenTapClose} from '../packages/core/kitchen-screen';
import {parseKitchenTapRecovery,retainedKitchenTap,type KitchenTapClosure} from '../packages/core/kitchen-recovery';
const base='/mise/app/',opened:ScreenJournal[]=[];
afterEach(()=>{for(const journal of opened)journal.close();opened.length=0;vi.restoreAllMocks();});
async function fixture(){const f=await kitchenScreenFixture(),factory=new IDBFactory(),journal=await openScreenJournal(base,factory);opened.push(journal);const record=await journal.replace(await journal.read(),f.screen);await journal.replaceKitchen(record,null,f.state);return {...f,factory,journal,record};}
function receipt(f:Awaited<ReturnType<typeof kitchenScreenFixture>>,action:Awaited<ReturnType<typeof prepareKitchenAction>>):KitchenReceipt{
 return {v:1,id:action.id,type:action.type,businessId:f.access.businessId,outletId:action.outletId,orderId:action.orderId,deviceId:f.device.id,sessionId:f.session.id,memberId:f.session.memberId,
  sourceRevision:action.revision,revision:action.revision+1,contentHash:action.contentHash,parentAckId:action.parentAckId,occurredAt:action.occurredAt,acceptedAt:f.now,status:'kitchen_seen',transitionEventIds:action.transitionEventIds.slice(0,1)};
}
it('retains complete offline source and FIFO Got it/Ready identities through close/reopen',async()=>{
 const f=await fixture(),screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});
 await screen.tap(f.ticket,'kitchen.acknowledge');await screen.tap(f.ticket,'kitchen.ready');
 const before=await f.journal.readKitchen(f.record);expect(before!.taps.map(t=>t.position)).toEqual([1,2]);expect(before!.taps[1].action.parentAckId).toBe(before!.taps[0].action.id);expect(before!.taps.every(t=>t.receipt===null)).toBe(true);
 screen.dispose();f.journal.close();const reopened=await openScreenJournal(base,f.factory);opened.push(reopened);expect(await reopened.readKitchen(f.record)).toEqual(before);
 const wire=JSON.stringify(kitchenScreenWire(before!));for(const key of ['token','publishableKey','customer','unitPrice','payment'])expect(wire).not.toContain('"'+key+'":');
});
it('only a matching actual receipt finishes a tap; status and cursor changes retain its complete original source',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),queued=appendKitchenTap(f.state,f.ticket,action,newKitchenId());
 const changed=receiveKitchenChanges(queued,{...f.page,tickets:[{...f.ticket,status:'kitchen_seen',revision:2}],nextSeq:9,watermark:9,removed:[]},newKitchenId());
 expect(changed.taps[0]).toEqual(queued.taps[0]);expect(changed.taps[0].receipt).toBeNull();
 expect(()=>finishKitchenTap(changed,queued.taps[0],{...receipt(f,action),memberId:newKitchenId()},newKitchenId())).toThrow();
 const finished=finishKitchenTap(changed,queued.taps[0],receipt(f,action),newKitchenId());expect(finished.taps[0].source).toEqual(f.ticket);expect(finished.taps[0].receipt?.id).toBe(action.id);
 expect(finishKitchenTap(finished,queued.taps[0],receipt(f,action),newKitchenId())).toBe(finished);
});
it('keeps the first bootstrap watermark and a finite delta window while pages and new taps arrive',async()=>{
 const f=await kitchenScreenFixture(),first=receiveKitchenPage(null,{...f.page,next:{createdAt:f.ticket.createdAt,id:f.ticket.id}},newKitchenId());
 const queued=appendKitchenTap(first,f.ticket,await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),newKitchenId());
 const loaded=receiveKitchenPage(queued,{...f.page,tickets:[],watermark:20},newKitchenId());expect(loaded.cursor).toBe(7);expect(loaded.taps).toEqual(queued.taps);
 const partial=receiveKitchenChanges(loaded,{...f.page,tickets:[],watermark:20,nextSeq:12,removed:[]},newKitchenId());expect(partial.until).toBe(20);
 expect(()=>receiveKitchenChanges(partial,{...f.page,tickets:[],watermark:21,nextSeq:20,removed:[]},newKitchenId())).toThrow();
});
it('native cache CAS and enrollment CAS both retain the original queue on stale writes',async()=>{
 const f=await fixture(),old=await f.journal.readKitchen(f.record),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),next=appendKitchenTap(old!,f.ticket,action,newKitchenId());
 await f.journal.replaceKitchen(f.record,old,next);await expect(f.journal.replaceKitchen(f.record,old,{...old!,revision:newKitchenId()})).rejects.toMatchObject({kind:'changed'});
 await f.journal.replace(f.record,{phase:'empty'});await expect(f.journal.replaceKitchen(f.record,next,{...next,revision:newKitchenId()})).rejects.toMatchObject({kind:'changed'});
 const enrolled=await f.journal.replace(await f.journal.read(),f.screen);expect(await f.journal.readKitchen(enrolled)).toEqual(next);
});
it('quota failure and stopped route leave complete tickets and saved taps untouched',async()=>{
 const f=await fixture(),before=await f.journal.readKitchen(f.record),next={...before!,revision:newKitchenId()};
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});await expect(f.journal.replaceKitchen(f.record,before,next)).rejects.toMatchObject({kind:'unavailable'});vi.restoreAllMocks();
 await expect(f.journal.replaceKitchen(f.record,before,next,{assertCurrent:()=>{throw Error('Route closed');}})).rejects.toMatchObject({kind:'changed'});expect(await f.journal.readKitchen(f.record)).toEqual(before);
});
it('upgrades the real version-1 journal without replacing its pairing source or revision',async()=>{
 const factory=new IDBFactory(),f=await kitchenScreenFixture(),original={v:1,id:'current',revision:newKitchenId(),state:f.screen};
 await new Promise<void>((resolve,reject)=>{const request=factory.open(screenJournalDatabaseName(base),1);request.onupgradeneeded=()=>request.result.createObjectStore('state',{keyPath:'id'}).put(original);request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
 const journal=await openScreenJournal(base,factory);opened.push(journal);expect(await journal.read()).toEqual(original);expect(await journal.readKitchen(await journal.read())).toBeNull();expect((await factory.databases())[0].version).toBe(2);
});
it('delivers queued acknowledgement before Ready and retries the same saved tap after a lost reply',async()=>{
 const f=await fixture(),sent:string[]=[],accepted=new Map<string,KitchenReceipt>();let lose=true;
 const screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send:async(url,init)=>{
  expect(String(url)).toBe('https://screen.test/functions/v1/kitchen-actions');const body=JSON.parse(init!.body as string),action=body.action;
  sent.push(action.id);if(!accepted.has(action.id))accepted.set(action.id,{...receipt(f,action),status:action.type==='kitchen.ready'?'ready':'kitchen_seen'});
  if(lose){lose=false;throw Error('Lost actual reply');}return new Response(JSON.stringify(accepted.get(action.id)));
 }});
 await screen.tap(f.ticket,'kitchen.acknowledge');await screen.tap(f.ticket,'kitchen.ready');await expect(screen.deliver()).rejects.toMatchObject({kind:'retry'});
 const retained=await f.journal.readKitchen(f.record);expect(retained!.taps.every(t=>t.receipt===null)).toBe(true);await screen.deliver();
 expect(sent).toEqual([retained!.taps[0].action.id,retained!.taps[0].action.id,retained!.taps[1].action.id]);expect(accepted.size).toBe(2);expect((await f.journal.readKitchen(f.record))!.taps.every(t=>t.receipt)).toBe(true);screen.dispose();
});
it('a different PIN session cannot display or send an earlier staff member’s cached work',async()=>{
 const f=await fixture(),old=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await old.tap(f.ticket,'kitchen.acknowledge');old.dispose();
 if(f.screen.phase!=='signed-in')throw Error();const newRecord=await f.journal.replace(f.record,{...f.screen,session:{...f.session,id:newKitchenId(),memberId:newKitchenId()}}),send=vi.fn(async()=>new Response('{}'));
 const next=createKitchenScreenSession(f.journal,newRecord,{blank:async()=>{},now:()=>f.now,send});expect(await next.load()).toBeNull();await next.deliver();expect(send).not.toHaveBeenCalled();expect((await f.journal.readKitchen(newRecord))!.taps).toHaveLength(1);next.dispose();
});
it('a slow cursor read does not block offline taps or receipt delivery, and its later page retains both',async()=>{
 const f=await fixture();let started!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send:async(url,init)=>{
  const body=JSON.parse(init!.body as string);
  if(String(url).endsWith('/kitchen-tickets')){started();await gate;return Response.json({v:1,access:f.access,outletName:f.page.outletName,at:f.now,warningMinutes:2,watermark:7,tickets:f.wire.tickets,nextSeq:7,removed:[]});}
  return Response.json(receipt(f,body.action));
 }});
 const pull=screen.pull();await reached;await screen.tap(f.ticket,'kitchen.acknowledge');await screen.deliver();const before=await f.journal.readKitchen(f.record);expect(before!.taps[0].receipt?.id).toBe(before!.taps[0].action.id);
 release();await pull;const after=await f.journal.readKitchen(f.record);expect(after!.taps).toEqual(before!.taps);expect(after!.cursor).toBe(7);screen.dispose();
});
it('captures the displayed ticket bytes and gesture clock before its first asynchronous read',async()=>{
 const f=await fixture(),displayed=structuredClone(f.ticket);let release!:()=>void,started!:()=>void,clock=f.now;
 const gate=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{started=resolve;});let hold=true;
 const screen=createKitchenScreenSession(f.journal,f.record,{now:()=>clock,blank:async()=>{if(hold){hold=false;started();await gate;}}});
 const tapping=screen.tap(displayed,'kitchen.acknowledge');await reached;displayed.lines[0].note='A later object mutation';clock+=60000;release();await tapping;
 const saved=await f.journal.readKitchen(f.record);expect(saved!.taps[0].source).toEqual(f.ticket);expect(saved!.taps[0].action.occurredAt).toBe(f.now);screen.dispose();
});
it('an unseen preparation edit before the native read cannot become the acknowledged ticket',async()=>{
 const f=await fixture(),displayed=structuredClone(f.ticket);let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{started=resolve;});let hold=true;
 const screen=createKitchenScreenSession(f.journal,f.record,{now:()=>f.now,blank:async()=>{if(hold){hold=false;started();await gate;}}});
 const tapping=screen.tap(displayed,'kitchen.acknowledge'),rejected=expect(tapping).rejects.toThrow();await reached;
 const changed=structuredClone(f.state);changed.revision=newKitchenId();changed.tickets[0].lines[0].note='New preparation instruction';changed.tickets[0].revision++;
 const {kitchenContentHash}=await import('../packages/core/kitchen');changed.tickets[0].contentHash=await kitchenContentHash(changed.tickets[0]);
 await f.journal.replaceKitchen(f.record,f.state,changed);release();await rejected;const saved=await f.journal.readKitchen(f.record);expect(saved!.tickets).toEqual(changed.tickets);expect(saved!.taps).toEqual([]);screen.dispose();
});
it('refuses a duplicate offline tap and preserves literal preparation text without truncation',async()=>{
 const f=await kitchenScreenFixture(),note='বাংলা\0'+String.fromCharCode(0xd800)+'x'.repeat(1000000);
 const {kitchenContentHash}=await import('../packages/core/kitchen');f.ticket.lines[0].note=note;f.ticket.contentHash=await kitchenContentHash(f.ticket);f.state.tickets=[f.ticket];
 const action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),queued=appendKitchenTap(f.state,f.ticket,action,newKitchenId());
 const parsed=await parseKitchenScreenState(kitchenScreenWire(queued));expect(parsed.taps[0].source.lines[0].note).toBe(note);expect(()=>appendKitchenTap(parsed,f.ticket,{...action,id:newKitchenId(),transitionEventIds:[newKitchenId(),newKitchenId(),newKitchenId()]},newKitchenId())).toThrow();
 await expect(parseKitchenScreenState({...kitchenScreenWire(queued),token:'PRIVATE'})).rejects.toThrow();
});

function closureFor(f:Awaited<ReturnType<typeof kitchenScreenFixture>>,tap:NonNullable<Awaited<ReturnType<ScreenJournal['readKitchen']>>>['taps'][number],id=newKitchenId()):KitchenTapClosure{
 return {v:1,id,type:'kitchen.tap-closed',businessId:f.access.businessId,outletId:f.access.outletId,deviceId:f.access.deviceId,
  originalSessionId:tap.access.sessionId,originalMemberId:tap.access.memberId,action:tap.action,sessionId:f.access.sessionId,memberId:f.access.memberId,occurredAt:f.now,closedAt:f.now};
}
it('keeps legacy cache bytes comparable and upgrades review fields only with an explicit close request',async()=>{
 const f=await fixture(),screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await screen.tap(f.ticket,'kitchen.acknowledge');
 const before=(await f.journal.readKitchen(f.record))!,wire=kitchenScreenWire(before);expect(before.v).toBe(1);expect(await parseKitchenScreenState(wire)).toEqual(before);
 const intent={id:newKitchenId(),access:f.access,occurredAt:f.now},next=beginKitchenTapClose(before,before.taps[0],intent,newKitchenId());
 expect(next.v).toBe(2);await f.journal.replaceKitchen(f.record,before,next);const saved=(await f.journal.readKitchen(f.record))!;
 expect(saved.taps[0].source).toEqual(before.taps[0].source);expect(saved.taps[0].closeIntents).toEqual([intent]);expect(saved.taps[0].closure).toBeNull();
 expect(beginKitchenTapClose(saved,saved.taps[0],{...intent,id:newKitchenId(),occurredAt:f.now+1000},newKitchenId())).toBe(saved);screen.dispose();
});
it('a close request is journaled offline before HTTP and blocks a replacement until actual outcome proof',async()=>{
 const f=await fixture(),send=vi.fn(async()=>{throw Error('Offline');}),screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});
 await screen.tap(f.ticket,'kitchen.acknowledge');const original=(await f.journal.readKitchen(f.record))!.taps[0];await screen.closeTap(original);
 expect(send).not.toHaveBeenCalled();const closing=(await f.journal.readKitchen(f.record))!;expect(closing.taps[0].closeIntents).toHaveLength(1);expect(closing.taps[0].receipt).toBeNull();
 await expect(screen.tap(f.ticket,'kitchen.acknowledge')).rejects.toThrow();
 const closed=finishKitchenTapClose(closing,original,closureFor(f,original,closing.taps[0].closeIntents![0].id),newKitchenId());
 expect(closed.taps[0].source).toEqual(original.source);expect(closed.taps[0].receipt).toBeNull();expect(closed.taps[0].closure).toBeTruthy();
 expect(finishKitchenTapClose(closed,original,closed.taps[0].closure!,newKitchenId())).toBe(closed);
 expect(()=>appendKitchenTap(closed,f.ticket,{...original.action,id:newKitchenId(),transitionEventIds:[newKitchenId(),newKitchenId(),newKitchenId()]},newKitchenId())).not.toThrow();screen.dispose();
});
it('quota failure leaves the original tap and no close request or HTTP write',async()=>{
 const f=await fixture(),send=vi.fn(async()=>Response.json({})),screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});await screen.tap(f.ticket,'kitchen.acknowledge');
 const before=(await f.journal.readKitchen(f.record))!;vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});
 await expect(screen.closeTap(before.taps[0])).rejects.toMatchObject({kind:'unavailable'});vi.restoreAllMocks();expect(await f.journal.readKitchen(f.record)).toEqual(before);expect(send).not.toHaveBeenCalled();screen.dispose();
});
it('a lost close reply resumes the same stored review ID, actor and time after native reload',async()=>{
 const f=await fixture(),bodies:Record<string,unknown>[]=[],screen=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});
 await screen.tap(f.ticket,'kitchen.acknowledge');await screen.closeTap((await f.journal.readKitchen(f.record))!.taps[0]);screen.dispose();
 const before=(await f.journal.readKitchen(f.record))!,original=before.taps[0],actual=closureFor(f,original,original.closeIntents![0].id);let lose=true;
 const send:typeof fetch=async(url,init)=>{expect(String(url)).toBe('https://screen.test/functions/v1/kitchen-recovery');const body=JSON.parse(init!.body as string);bodies.push(body);if(lose){lose=false;throw Error('Lost reply');}return Response.json({v:1,access:f.access,at:f.now,original:retainedKitchenTap(original),outcome:'closed',receipt:null,closure:actual});};
 const first=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now,send});await expect(first.recover()).rejects.toMatchObject({kind:'retry'});first.dispose();expect(await f.journal.readKitchen(f.record)).toEqual(before);
 f.journal.close();const journal=await openScreenJournal(base,f.factory);opened.push(journal);const resumed=createKitchenScreenSession(journal,f.record,{blank:async()=>{},now:()=>f.now+1000,send});await resumed.recover();
 expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);expect((await journal.readKitchen(f.record))!.taps[0]).toMatchObject({receipt:null,closure:actual,source:original.source,closeIntents:original.closeIntents});resumed.dispose();
});
it('a fresh PIN recovers an actual older receipt with its original actor and sends no new preparation action',async()=>{
 const f=await fixture(),first=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await first.tap(f.ticket,'kitchen.acknowledge');first.dispose();
 const saved=(await f.journal.readKitchen(f.record))!,original=saved.taps[0],later=f.session.expiresAt+1,nextSession={...f.session,id:newKitchenId(),memberId:newKitchenId(),token:'N'.repeat(43),createdAt:later,expiresAt:later+43200000};
 if(f.screen.phase!=='signed-in')throw Error();const nextRecord=await f.journal.replace(f.record,{...f.screen,session:nextSession}),access={...f.access,sessionId:nextSession.id,memberId:nextSession.memberId,expiresAt:nextSession.expiresAt},calls:string[]=[];
 const send:typeof fetch=async(url,init)=>{calls.push(String(url));const body=JSON.parse(init!.body as string);if(String(url).endsWith('/kitchen-tickets'))return Response.json(body.action==='page'?{...f.wire,access,at:later}:{v:1,access,at:later,outletName:f.page.outletName,warningMinutes:2,watermark:7,nextSeq:7,tickets:[],removed:[]});expect(body.action).toBe('lookup');return Response.json({v:1,access,at:later,original:retainedKitchenTap(original),outcome:'accepted',receipt:receipt(f,original.action),closure:null});};
 const current=createKitchenScreenSession(f.journal,nextRecord,{blank:async()=>{},now:()=>later,send});expect(await current.load()).toBeNull();await current.pull();await current.recover();
 const recovered=(await f.journal.readKitchen(nextRecord))!;expect(recovered.access.memberId).toBe(nextSession.memberId);expect(recovered.taps[0].receipt?.memberId).toBe(f.session.memberId);expect(recovered.taps[0].source).toEqual(original.source);expect(calls.some(url=>url.endsWith('/kitchen-actions'))).toBe(false);
 await current.tap(recovered.tickets[0],'kitchen.ready');const ready=(await f.journal.readKitchen(nextRecord))!.taps[1];expect(ready.action.parentAckId).toBe(original.action.id);expect(ready.access.memberId).toBe(nextSession.memberId);current.dispose();
});
it('a different reviewing PIN only looks up an earlier close intent until that member explicitly chooses to close',async()=>{
 const f=await fixture(),first=createKitchenScreenSession(f.journal,f.record,{blank:async()=>{},now:()=>f.now});await first.tap(f.ticket,'kitchen.acknowledge');await first.closeTap((await f.journal.readKitchen(f.record))!.taps[0]);first.dispose();
 const old=(await f.journal.readKitchen(f.record))!,nextSession={...f.session,id:newKitchenId(),memberId:newKitchenId(),token:'N'.repeat(43)};
 if(f.screen.phase!=='signed-in')throw Error();const nextRecord=await f.journal.replace(f.record,{...f.screen,session:nextSession}),access={...f.access,sessionId:nextSession.id,memberId:nextSession.memberId};
 const seen:string[]=[];const send:typeof fetch=async(url,init)=>{const body=JSON.parse(init!.body as string);if(String(url).endsWith('/kitchen-tickets'))return Response.json(body.action==='page'?{...f.wire,access}:{v:1,access,at:f.now,outletName:f.page.outletName,warningMinutes:2,watermark:7,nextSeq:7,tickets:[],removed:[]});seen.push(body.action);return Response.json({v:1,access,at:f.now,original:retainedKitchenTap(old.taps[0]),outcome:'pending',receipt:null,closure:null});};
 const current=createKitchenScreenSession(f.journal,nextRecord,{blank:async()=>{},now:()=>f.now,send});await current.pull();await current.recover();expect(seen).toEqual(['lookup']);
 const before=(await f.journal.readKitchen(nextRecord))!;expect(before.taps[0].closeIntents).toEqual(old.taps[0].closeIntents);await current.closeTap(before.taps[0]);
 const after=(await f.journal.readKitchen(nextRecord))!;expect(after.taps[0].closeIntents).toHaveLength(2);expect(after.taps[0].closeIntents![0]).toEqual(old.taps[0].closeIntents![0]);expect(after.taps[0].closeIntents![1].access.memberId).toBe(nextSession.memberId);expect(after.taps[0].action).toEqual(old.taps[0].action);current.dispose();
});
it('actual acceptance arriving after a close request retains the receipt and never labels it closed',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),queued=appendKitchenTap(f.state,f.ticket,action,newKitchenId()),original=queued.taps[0];
 const closing=beginKitchenTapClose(queued,original,{id:newKitchenId(),access:f.access,occurredAt:f.now},newKitchenId());
 const accepted=finishKitchenTap(closing,original,receipt(f,action),newKitchenId());expect(accepted.taps[0].receipt?.id).toBe(action.id);expect(accepted.taps[0].closure).toBeNull();expect(accepted.taps[0].closeIntents).toEqual(closing.taps[0].closeIntents);
 expect(()=>finishKitchenTapClose(accepted,original,closureFor(f,original),newKitchenId())).toThrow();
});
it('recovery rejects forged outcomes and keeps arbitrary extra authority or data outside the response contract',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),original={action,sessionId:f.session.id,memberId:f.session.memberId};
 const pending={v:1,access:f.access,at:f.now,original,outcome:'pending',receipt:null,closure:null};expect(parseKitchenTapRecovery(pending,original).outcome).toBe('pending');
 for(const patch of [{receipt:receipt(f,action)},{token:'PRIVATE'},{outcome:'accepted',receipt:{...receipt(f,action),memberId:newKitchenId()}},{original:{...original,action:{...action,occurredAt:action.occurredAt+1}}}])expect(()=>parseKitchenTapRecovery({...pending,...patch},original)).toThrow();
});
