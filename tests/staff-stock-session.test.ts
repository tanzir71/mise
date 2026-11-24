import {beforeAll,beforeEach,afterAll,afterEach,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createStaffStockNativeFixture,stockTaskChoices,stockRequest} from './staff-stock-native-fixture';
import {staffDeviceConnection} from './staff-device-fixture';
import {deviceId as id} from './device-pairing-fixture';
import {openScreenJournal,type ScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {createDeviceScreenSession} from '../apps/web/src/data/device-screen-session';
import {createStaffStockSession,type StaffStockSession} from '../apps/web/src/data/staff-stock-session';
import {createDeviceScreenRemote} from '../apps/web/src/data/device-screen-remote';
import {staffStockIntentHash,type StaffStockPrepared,type StaffStockCommand} from '../packages/core/staff-stock-actions';
import {newInboxId} from '../packages/core/inbox';
import type {StaffStockPage} from '../packages/core/staff-stock';
let f:Awaited<ReturnType<typeof createStaffStockNativeFixture>>;const opened:ScreenJournal[]=[],running:StaffStockSession[]=[];
beforeAll(async()=>{f=await createStaffStockNativeFixture();},30000);beforeEach(async()=>{await f.seed();await f.configure(id(105),{permissions:stockTaskChoices});await f.stock();});
afterEach(()=>{running.splice(0).forEach(s=>s.stop());opened.splice(0).forEach(j=>j.close());vi.restoreAllMocks();});afterAll(async()=>{await f?.db.close();});
async function setup(now:()=>number=Date.now){
 const factory=new IDBFactory(),journal=await openScreenJournal('/mise/app/',factory);opened.push(journal);let send:typeof fetch=f.transport();const fetcher:typeof fetch=(u,o)=>send(u,o),blank=vi.fn(async()=>{}),screen=createDeviceScreenSession(journal,{blank,send:fetcher});
 const {pairing}=await f.start(),prepared=await screen.prepare(await screen.load(),staffDeviceConnection,pairing.code,pairing.id),waiting=await screen.pair(prepared);if(waiting.saved.state.phase!=='pairing')throw Error();
 await f.asRole(1,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairing.id,waiting.saved.state.source.requestId,waiting.saved.state.receipt!.verification,newInboxId()]);
 const paired=await screen.pair(waiting.saved),signed=await screen.signIn(paired.saved,id(105),'0042'),stock=await createStaffStockSession(journal,signed,{blank,send:fetcher,now});running.push(stock);
 async function resume(source=signed,j=journal){const next=await createStaffStockSession(j,source,{blank,send:fetcher,now});running.push(next);return next;}
 return {factory,journal,screen,signed,stock,blank,fetcher,resume,setSend:(next:typeof fetch)=>{send=next;}};
}
async function original(t:Awaited<ReturnType<typeof setup>>,reason:'used'|'received'|'waste'|'count'='used',quantity=1.005){const page=await t.stock.read();return t.stock.capture(stockRequest(page,reason,quantity),[page]);}
async function comparison(stock:StaffStockSession,actionId:string):Promise<StaffStockPrepared>{const quote=await stock.review(actionId);if(quote.state!=='review')throw Error('Expected the actual current comparison');return quote;}
it('journals the complete original before HTTP, then requires a separate genuine current comparison and confirmation',async()=>{
 const t=await setup(),intent=await original(t),saved=(await t.journal.readStock(t.signed))!;expect(saved.actions[0]).toMatchObject({intent,outcome:null,closeRequested:false,intentHash:await staffStockIntentHash(intent)});
 expect(await f.quantities()).toMatchObject({moves:0,receipts:0,quantity:10.005});const quote=await comparison(t.stock,intent.command.id);expect(await f.quantities()).toMatchObject({moves:0});
 const outcome=await t.stock.confirm(intent.command.id,quote);expect(outcome.state).toBe('applied');expect(await f.quantities()).toMatchObject({moves:1,receipts:1,quantity:9});expect(t.stock.saved().actions[0]).toMatchObject({intent,outcome});
 expect(JSON.stringify(await t.journal.readStock(t.signed))).not.toMatch(/sessionToken|sb_publishable|"token"|supplierId|"pin"/);
});
it('recovers the actual original outcome after a lost completion and full native reopen without sending a second change',async()=>{
 const t=await setup(),intent=await original(t),quote=await comparison(t.stock,intent.command.id),normal=f.transport();t.setSend(async(u,o)=>{const r=await normal(u,o);if(JSON.parse(String(o?.body)).operation==='commit')throw Error('PRIVATE lost reply');return r;});
 await expect(t.stock.confirm(intent.command.id,quote)).rejects.toThrow();expect(t.stock.saved().actions[0].outcome).toBeNull();t.stock.stop();t.setSend(normal);const next=await t.resume();
 await expect(next.confirm(intent.command.id,JSON.parse(JSON.stringify(quote)))).rejects.toMatchObject({kind:'review'});expect((await next.recover(intent.command.id)).state).toBe('applied');expect(await f.quantities()).toMatchObject({moves:1,receipts:1,quantity:9});expect(next.saved().actions[0].intent).toEqual(intent);
});
it('closes offline before HTTP and fences a late prepared confirmation without synthesizing a movement or count',async()=>{
 const t=await setup(),intent=await original(t,'count',0),quote=await comparison(t.stock,intent.command.id),normal=f.transport();t.setSend(async()=>{throw Error('offline');});await expect(t.stock.recover(intent.command.id,'close')).rejects.toThrow();expect(t.stock.saved().actions[0]).toMatchObject({intent,closeRequested:true,outcome:null});
 await expect(t.stock.confirm(intent.command.id,quote)).rejects.toMatchObject({kind:'review'});t.stock.stop();t.setSend(normal);const next=await t.resume();expect((await next.recover(intent.command.id)).state).toBe('closed');
 if(t.signed.state.phase!=='signed-in')throw Error();const remote=createDeviceScreenRemote({connection:staffDeviceConnection,requestId:t.signed.state.credential.device.id,token:t.signed.state.credential.token},()=>{},normal);
 expect((await remote.stockAction(t.signed.state.credential.device,t.signed.state.session,intent,'commit',quote)).state).toBe('closed');expect(await f.quantities()).toMatchObject({moves:0,receipts:0,closures:1,quantity:10.005});
});
it('a later own PIN inspects an older request after all work permission is removed, without rewriting its original session',async()=>{
 const t=await setup(),intent=await original(t),quote=await comparison(t.stock,intent.command.id);await t.stock.confirm(intent.command.id,quote);t.stock.stop();await f.configure(id(105),{permissions:{...stockTaskChoices,updateStock:false},methods:[]});
 const reset=await t.screen.reset(t.signed),signed=await t.screen.signIn(reset,id(105),'0042'),next=await t.resume(signed);await expect(next.read()).rejects.toMatchObject({kind:'auth'});const actual=await next.recover(intent.command.id);expect(actual.state).toBe('applied');expect(actual.receipt?.sessionId).toBe(intent.origin.sessionId);expect(next.saved().actions[0].intent).toEqual(intent);
});
it('a new PIN can deliberately review an own pending request, but an old or serialized quote never grants confirmation',async()=>{
 const t=await setup(),intent=await original(t),old=await comparison(t.stock,intent.command.id);t.stock.stop();const signed=await t.screen.signIn(await t.screen.reset(t.signed),id(105),'0042'),next=await t.resume(signed);
 await expect(next.confirm(intent.command.id,old)).rejects.toMatchObject({kind:'review'});const current=await comparison(next,intent.command.id);expect(current.review.access.sessionId).not.toBe(intent.origin.sessionId);
 await expect(next.confirm(intent.command.id,structuredClone(current))).rejects.toMatchObject({kind:'review'});expect(await f.quantities()).toMatchObject({moves:0});expect((await next.confirm(intent.command.id,await comparison(next,intent.command.id))).state).toBe('applied');
});
it('another PIN member cannot read, inspect or close the prior member’s originals',async()=>{
 const t=await setup(),intent=await original(t);t.stock.stop();await f.configure(id(104),{role:'staff',permissions:stockTaskChoices});const signed=await t.screen.signIn(await t.screen.reset(t.signed),id(104),'0042'),other=await t.resume(signed);expect(other.saved().actions).toEqual([]);await expect(other.recover(intent.command.id,'close')).rejects.toMatchObject({kind:'changed'});expect(await f.quantities()).toMatchObject({closures:0});
});
it('two native connections retain only the first pending original',async()=>{
 const t=await setup(),otherJournal=await openScreenJournal('/mise/app/',t.factory);opened.push(otherJournal);const other=await t.resume(t.signed,otherJournal),a=await t.stock.read(),b=await other.read();
 const results=await Promise.allSettled([t.stock.capture(stockRequest(a),[a]),other.capture(stockRequest(b),[b])]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await t.journal.readStock(t.signed))?.actions).toHaveLength(1);expect(await f.quantities()).toMatchObject({moves:0});
});
it('quota failure retains the old native journal and prevents a new request from reaching HTTP',async()=>{
 const t=await setup(),page=await t.stock.read(),before=await t.journal.readStock(t.signed),send=vi.fn(f.transport());t.setSend(send);const put=IDBObjectStore.prototype.put;
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,v:unknown,k?:IDBValidKey){if(this.name==='stock')throw new DOMException('PRIVATE quota','QuotaExceededError');return k===undefined?put.call(this,v):put.call(this,v,k);});
 await expect(t.stock.capture(stockRequest(page),[page])).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(await t.journal.readStock(t.signed)).toEqual(before);expect(await f.quantities()).toMatchObject({moves:0});
});
it('rejects forged or edited read pages and copies the selected source before its first asynchronous boundary',async()=>{
 const t=await setup(),page=await t.stock.read(),command=stockRequest(page);await expect(t.stock.capture(command,[structuredClone(page)])).rejects.toMatchObject({kind:'review'});const name=page.items[0].name,work=t.stock.capture(command,[page]);page.items[0].name='Edited while saving';const intent=await work;expect(intent.items[0].name).toBe(name);expect(t.stock.saved().actions[0].intent).toEqual(intent);
});
it('a later denial in another tab survives reload and rejects an earlier successful read arriving late',async()=>{
 const t=await setup(),intent=await original(t),normal=f.transport();let release!:()=>void,reached!:()=>void;const entered=new Promise<void>(r=>{reached=r;}),wait=new Promise<void>(r=>{release=r;});t.setSend(async(u,o)=>{const r=await normal(u,o);if(new URL(String(u)).pathname.endsWith('/staff-stock')&&r.ok){reached();await wait;}return r;});
 const work=t.stock.read(),checked=expect(work).rejects.toThrow();await entered;await f.configure(id(105),{permissions:{...stockTaskChoices,updateStock:false}});const other=await createStaffStockSession(t.journal,t.signed,{blank:t.blank,send:normal});running.push(other);await expect(other.read()).rejects.toMatchObject({kind:'auth'});release();await checked;
 t.stock.stop();t.setSend(normal);const next=await t.resume();expect(next.saved().readDenied).toBe(true);expect(next.saved().actions[0].intent).toEqual(intent);expect((await next.recover(intent.command.id,'close')).state).toBe('closed');
});
it('No then Yes invalidates an old comparison; a new explicit comparison retains the reported original count and time',async()=>{
 const t=await setup(),intent=await original(t,'count',3.125),first=await comparison(t.stock,intent.command.id);await f.configure(id(105),{permissions:{...stockTaskChoices,updateStock:false}});await f.configure(id(105),{permissions:stockTaskChoices});await expect(t.stock.confirm(intent.command.id,first)).rejects.toMatchObject({kind:'review'});
 const current=await comparison(t.stock,intent.command.id);expect((await t.stock.confirm(intent.command.id,current)).state).toBe('applied');expect(t.stock.saved().actions[0].intent).toEqual(intent);expect(await f.quantities()).toMatchObject({quantity:3.125,moves:1});
});
it('an own movement can be undone once through a newly read quantity and actual stored parent receipt',async()=>{
 const t=await setup(),intent=await original(t),outcome=await t.stock.confirm(intent.command.id,await comparison(t.stock,intent.command.id)),page=await t.stock.read();
 const parentMove=outcome.receipt!.command.results[0].moveId;if(!parentMove)throw Error();
 const command:Extract<StaffStockCommand,{type:'stock.undo'}>={id:newInboxId(),type:'stock.undo',outletId:page.access.outletId,occurredAt:Date.now(),stockItemId:page.items[0].id,revision:page.items[0].revision,undoMoveId:parentMove,moveId:newInboxId()};
 const undo=await t.stock.capture(command,[page],intent.command.id);expect((await t.stock.confirm(undo.command.id,await comparison(t.stock,undo.command.id))).state).toBe('applied');expect(await f.quantities()).toMatchObject({moves:2,quantity:10.005});expect(t.stock.saved().actions[1].intent.undo).toEqual(outcome.receipt);
 const fresh=await t.stock.read(),again=await t.stock.capture({...command,id:newInboxId(),moveId:newInboxId(),occurredAt:Date.now(),revision:fresh.items[0].revision},[fresh],intent.command.id);await expect(t.stock.review(again.command.id)).rejects.toMatchObject({kind:'review'});expect(await f.quantities()).toMatchObject({moves:2});
});
it('refuses native history removal, original rewriting, terminal rewriting and serialized outcome authority',async()=>{
 const t=await setup(),intent=await original(t),before=(await t.journal.readStock(t.signed))!,pending={v:1 as const,id:intent.command.id,state:'pending' as const,intentHash:before.actions[0].intentHash,receipt:null,at:null};
 await expect(t.journal.replaceStock(t.signed,before,{...before,revision:newInboxId(),actions:[{...before.actions[0],outcome:pending}]},{authorization:{}})).rejects.toThrow();
 const forged=structuredClone(before);forged.revision=newInboxId();forged.actions[0].intent.outletName='Altered original';forged.actions[0].intentHash=await staffStockIntentHash(forged.actions[0].intent);await expect(t.journal.replaceStock(t.signed,before,forged)).rejects.toThrow();
 await t.stock.confirm(intent.command.id,await comparison(t.stock,intent.command.id));const terminal=(await t.journal.readStock(t.signed))!;
 await expect(t.journal.replaceStock(t.signed,terminal,{...terminal,revision:newInboxId(),actions:[]})).rejects.toThrow();
 await expect(t.journal.replaceStock(t.signed,terminal,{...terminal,revision:newInboxId(),actions:[{...terminal.actions[0],outcome:{...pending,state:'closed',at:Date.now()}}]})).rejects.toThrow();expect(await t.journal.readStock(t.signed)).toEqual(terminal);
});
it('a native enrollment or owner-profile change stops HTTP and cannot discard the original',async()=>{
 const t=await setup(),intent=await original(t),send=vi.fn(f.transport());t.setSend(send);t.blank.mockRejectedValueOnce(Error('Owner profile'));await expect(t.stock.review(intent.command.id)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(t.stock.saved().actions[0].intent).toEqual(intent);await t.screen.reset(t.signed);await expect(t.stock.recover(intent.command.id)).rejects.toMatchObject({kind:'changed'});expect(send.mock.calls.every(([u])=>!String(u).endsWith('/staff-stock-actions'))).toBe(true);
});
it('retains and confirms all one thousand physical-count lines through actual transport, native storage and SQL',async()=>{
 await f.stock(999,302);const t=await setup(),pages:StaffStockPage[]=[];let after:string|null=null;
 do{const page=await t.stock.read(after);pages.push(page);after=page.next;}while(after);expect(pages).toHaveLength(10);const items=pages.flatMap(p=>p.items);
 const command:StaffStockCommand={id:newInboxId(),type:'stock.batch',outletId:pages[0].access.outletId,occurredAt:Date.now(),count:true,batchId:newInboxId(),changes:items.map((item,i)=>({id:item.id,revision:item.revision,reason:'count',quantity:0.125,source:'count',note:' original count '+i,moveId:newInboxId(),eventId:newInboxId()}))};
 if(command.type!=='stock.batch')throw Error();command.changes[0].eventId=command.id;
 const intent=await t.stock.capture(command,pages),actual=await t.stock.confirm(intent.command.id,await comparison(t.stock,intent.command.id));expect(actual.receipt?.command.results).toHaveLength(1000);expect(t.stock.saved().actions[0].intent).toEqual(intent);
 expect((await f.db.query<{n:number;total:number}>('select count(*)::integer n,sum(on_hand)::double precision total from public.stock_items')).rows[0]).toEqual({n:1000,total:125});expect(await f.quantities()).toMatchObject({moves:1000,receipts:1});
},60000);
it('complete million-character NUL labels and surrogate units survive native reopen and canonical SQL audits',async()=>{
 const label='\u0000'.repeat(1000000),unit='\ud800'.repeat(1000000);await f.db.query('update public.stock_items set name=$1::json,unit=$2::json where id=$3',[JSON.stringify(label),JSON.stringify(unit),id(301)]);const t=await setup(),intent=await original(t);expect(intent.items[0].name).toBe(label);expect(intent.items[0].unit).toBe(unit);t.stock.stop();const next=await t.resume();expect(next.saved().actions[0].intent).toEqual(intent);
 const outcome=await next.confirm(intent.command.id,await comparison(next,intent.command.id));expect(outcome.state).toBe('applied');
 const audit=(await f.db.query<{before_data:string;after_data:string}>('select before_data::text,after_data::text from public.events where id=$1',[intent.command.id])).rows[0],before=JSON.parse(audit.before_data),after=JSON.parse(audit.after_data);expect(before.name===label,'complete before label').toBe(true);expect(after.item.name===label,'complete after label').toBe(true);expect(after.item.unit===unit,'complete after unit').toBe(true);expect(after.move.name===label,'complete movement label').toBe(true);expect(next.saved().actions[0].intent).toEqual(intent);
},60000);
it('an expired in-memory comparison cannot start HTTP even while the saved original remains intact',async()=>{
 let clock=Date.now();const t=await setup(()=>clock),intent=await original(t),quote=await comparison(t.stock,intent.command.id),send=vi.fn(f.transport());t.setSend(send);clock=quote.review.expiresAt;
 await expect(t.stock.confirm(intent.command.id,quote)).rejects.toMatchObject({kind:'review'});expect(send).not.toHaveBeenCalled();expect(t.stock.saved().actions[0].intent).toEqual(intent);expect(await f.quantities()).toMatchObject({moves:0});
});
it('a genuine applied response arriving after local closure retains the physical truth and the original close choice',async()=>{
 const t=await setup(),intent=await original(t),quote=await comparison(t.stock,intent.command.id),normal=f.transport();let release!:()=>void,reached!:()=>void;const entered=new Promise<void>(r=>{reached=r;}),wait=new Promise<void>(r=>{release=r;});
 t.setSend(async(u,o)=>{const r=await normal(u,o);if(JSON.parse(String(o?.body)).operation==='commit'){reached();await wait;}return r;});const work=t.stock.confirm(intent.command.id,quote);await entered;
 const other=await createStaffStockSession(t.journal,t.signed,{blank:t.blank,send:normal});running.push(other);expect((await other.recover(intent.command.id,'close')).state).toBe('applied');release();expect((await work).state).toBe('applied');expect(t.stock.saved().actions[0]).toMatchObject({intent,closeRequested:true,outcome:{state:'applied'}});expect(await f.quantities()).toMatchObject({moves:1,receipts:1,closures:0});
});
it('a response after sign-out cannot attach to another PIN, and the same member later recovers the actual original receipt',async()=>{
 const t=await setup(),intent=await original(t),quote=await comparison(t.stock,intent.command.id),normal=f.transport();let release!:()=>void,reached!:()=>void;const entered=new Promise<void>(r=>{reached=r;}),wait=new Promise<void>(r=>{release=r;});
 t.setSend(async(u,o)=>{const r=await normal(u,o);if(JSON.parse(String(o?.body)).operation==='commit'){reached();await wait;}return r;});const work=t.stock.confirm(intent.command.id,quote),checked=expect(work).rejects.toThrow();await entered;const reset=await t.screen.reset(t.signed);release();await checked;t.stock.stop();t.setSend(normal);
 const signed=await t.screen.signIn(reset,id(105),'0042'),next=await t.resume(signed);expect(next.saved().actions[0].outcome).toBeNull();expect((await next.recover(intent.command.id)).state).toBe('applied');expect(next.saved().actions[0].intent).toEqual(intent);expect(await f.quantities()).toMatchObject({moves:1,receipts:1});
});
