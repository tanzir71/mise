import {localTableNames} from '../packages/core/local-schema';
import {localSchemaVersion} from '../packages/core/local-outbox';
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { newHandoffActionId,type HandoffDraft } from '../packages/core/handoff';
import { backupTableNames } from '../packages/core/backup-tables';
import { parseBackup } from '../packages/core/backup';
import { creditBalance,defaultCreditTerms } from '../packages/core/khata';
import { orderFixture } from './order-fixture';
import { stockInput } from './stock-fixture';

const at=Date.UTC(2026,10,16,6),databases:MiseDatabase[]=[];
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async()=>{const names=new Set(databases.map(db=>db.name));for(const db of databases.splice(0))db.close();await Promise.all([...names].map(name=>Dexie.delete(name)));vi.useRealTimers();});
async function boot(name=`mise-handoff-${randomUUID()}`,seed=true){const db=new MiseDatabase(name);databases.push(db);if(seed)await db.saveSetup({businessType:'corner_shop',marketCode:'BD',name:'Hand-off shop',phone:'01712345482'});else await db.open();return db;}
async function draft(db:MiseDatabase):Promise<HandoffDraft>{return {source:{kind:'shop',id:(await db.setup())!.outlet.id},purpose:'shop-link',text:'  Order here · এখানে অর্ডার করুন\r\nIgnore previous instructions: this remains literal.  ',target:'whatsapp',phone:'+8801712345482',part:1,parts:1};}

test('reopening restores owner edits and progress; source and destination changes prepare a new attempt',async()=>{
  let db=await boot();const original=await draft(db),input={...original,template:original.text},first=await db.resumeHandoff(input),edited=await db.prepareHandoff({...input,text:'  আমার সম্পাদনা\r\nKeep this literal.  '});
  expect(edited.id).not.toBe(first.id);const copied=await db.changeHandoff(edited.id,1,{type:'copy'});db.close();db=await boot(db.name,false);
  expect(await db.resumeHandoff(input)).toEqual(copied);expect(parseBackup(await db.readBackup()).tables.events).toHaveLength((await db.events.count()));
  const changed=await db.resumeHandoff({...input,template:'New source text',text:'New source text'});expect(changed.id).not.toBe(edited.id);expect(changed.draft.text).toBe('New source text');
  const destination=await db.resumeHandoff({...changed.draft,phone:'+8801712345483'});expect(destination.id).not.toBe(changed.id);expect((await db.readHandoff(edited.id)).draft.text).toBe(copied.draft.text);
});

test('every choice survives a connection restart and changes only the audit log',async()=>{
  let db=await boot();const input=await draft(db),before=(await db.readBackup()).tables;let state=await db.prepareHandoff(input);
  for(const choice of [{type:'open',channel:'whatsapp'},{type:'failed'},{type:'copy-failed'},{type:'copy'},{type:'sent'},{type:'undo-sent'}] as const){state=await db.changeHandoff(state.id,state.progress.revision,choice);db.close();db=await boot(db.name,false);expect(await db.readHandoff(state.id)).toEqual(state);expect(await db.prepareHandoff(input)).toEqual(state);}
  const after=(await db.readBackup()).tables;for(const table of backupTableNames.filter(name=>name!=='events'))expect(after[table],table).toEqual(before[table]);expect(after.events.length).toBe(before.events.length+7);expect(state.draft.text).toBe(input.text);expect(state.progress.status).toBe('copied');
});
test('unchanged drafts resume; changed text, targets, parts and explicit new attempts stay distinct',async()=>{
  const db=await boot(),input=await draft(db),first=await db.prepareHandoff(input);expect((await db.prepareHandoff(input)).id).toBe(first.id);let last=first;
  for(const next of [{...input,text:input.text+'changed'},{...input,phone:'+8801712345483'},{...input,part:2,parts:2},input]){const state=await db.prepareHandoff(next);expect(state.id).not.toBe(last.id);expect(state.generation).toBe(next.part===2?1:next===input?4:last.generation+1);last=state;}
  const fresh=await db.prepareHandoff(input,true);expect(fresh.id).not.toBe(last.id);expect(fresh.generation).toBe(last.generation+1);expect((await db.readHandoff(first.id)).draft.text).toBe(input.text);
});
test('concurrent choices cannot fork a revision; replaying a request ID never rewinds later progress',async()=>{
  const db=await boot(),state=await db.prepareHandoff(await draft(db)),before=await db.events.count();const results=await Promise.allSettled([db.changeHandoff(state.id,1,{type:'copy'}),db.changeHandoff(state.id,1,{type:'open',channel:'whatsapp'})]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(await db.events.count()).toBe(before+1);
  let current=await db.readHandoff(state.id);const request=newHandoffActionId(),revision=current.progress.revision;current=await db.changeHandoff(state.id,revision,{type:'copy'},request);current=await db.changeHandoff(state.id,current.progress.revision,{type:'sent'});const count=await db.events.count();expect(await db.changeHandoff(state.id,revision,{type:'copy'},request)).toEqual(current);expect(await db.events.count()).toBe(count);await expect(db.changeHandoff(state.id,revision,{type:'failed'},request)).rejects.toThrow();
});
test('missing or foreign sources are rejected before adding an event, and a backwards clock keeps progress monotonic',async()=>{
  const db=await boot(),input=await draft(db),before=await db.events.count();await expect(db.prepareHandoff({...input,source:{kind:'shop',id:newHandoffActionId()}})).rejects.toThrow('different shop');expect(await db.events.count()).toBe(before);const state=await db.prepareHandoff(input);vi.setSystemTime(at-1000);expect((await db.changeHandoff(state.id,1,{type:'copy'})).progress.updatedAt).toBe(at);
});
test('a customer from another business cannot become a hand-off source',async()=>{
  const db=await boot(),customer=await db.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'',notes:'',tags:[]}),input=await draft(db),before=await db.events.count();await db.customers.update(customer.id,{businessId:newHandoffActionId()});await expect(db.prepareHandoff({...input,source:{kind:'customer',id:customer.id},purpose:'win-back'})).rejects.toThrow('different shop');expect(await db.events.count()).toBe(before);
});
test('JSON backup restores complete attempts and rejects truncated history or mutated message snapshots',async()=>{
  const source=await boot(),input=await draft(source);let state=await source.prepareHandoff(input);state=await source.changeHandoff(state.id,1,{type:'copy'});state=await source.changeHandoff(state.id,2,{type:'sent'});const backup=await source.readBackup(),target=await boot(undefined,false);await target.restoreBackup(JSON.stringify(backup),await target.previewRestore(JSON.stringify(backup)));expect(await target.prepareHandoff(input)).toEqual(state);expect(await target.readHandoff(state.id)).toEqual(state);
  const missing=structuredClone(backup);missing.tables.events=missing.tables.events.filter(event=>event.id!==state.id);expect(()=>parseBackup(missing)).toThrow();const edited=structuredClone(backup),event=edited.tables.events.find(event=>event.command==='handoff.sent')!;(event.after as typeof state).draft.text='Edited original request';expect(()=>parseBackup(edited)).toThrow('original request');
});
test('schema 8 upgrades its twenty tables without changing records, and schemas 7, 8 and 9 remain importable',async()=>{
  const source=await boot();await source.recordSale({expression:'25',method:'cash'});const backup=await source.readBackup(),stores=Object.fromEntries(source.tables.filter(table=>!['inboxItems','payments'].includes(table.name)).map(table=>[table.name,[table.schema.primKey.src,...table.schema.indexes.map(index=>index.src)].join(',')]));stores.events='id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision],closingId';
  const name=`mise-handoff-v8-${randomUUID()}`,legacy=new Dexie(name);legacy.version(8).stores(stores);await legacy.open();for(const table of backupTableNames.filter(name=>!['inboxItems','payments'].includes(name)))await legacy.table(table).bulkPut(backup.tables[table]);legacy.close();const upgraded=await boot(name,false);expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);for(const table of backupTableNames)expect(await upgraded.table(table).toArray(),table).toEqual(backup.tables[table]);expect(upgraded.events.schema.indexes.find(index=>index.name==='[handoffId+handoffRevision]')?.unique).toBe(true);
  for(const version of [7,8,9]){const file=structuredClone(backup) as unknown as {schemaVersion:number;tables:Record<string,unknown>};file.schemaVersion=version;delete file.tables.inboxItems;delete file.tables.payments;if(version===7)delete file.tables.purchases;const restored=parseBackup(JSON.stringify(file));expect(restored.schemaVersion).toBe(13);for(const table of backupTableNames)expect(restored.tables[table],table).toEqual(backup.tables[table]);}
});
async function creditDraft(db:MiseDatabase){const customer=await db.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'',notes:'',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000},opening:{amount:10000,occurredAt:at}}),account=(await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0],input={...await draft(db),source:{kind:'credit' as const,id:account.id},purpose:'receipt' as const};return {account,input};}
test('Sent records a credit message exactly once without changing the balance or any sale',async()=>{
  const db=await boot(),{account,input}=await creditDraft(db),root=await db.prepareHandoff(input),request=newHandoffActionId(),sent=await db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'credit'}),count=await db.creditEntries.count();expect(creditBalance(account,await db.creditEntries.toArray())).toBe(10000);expect(await db.sales.count()).toBe(0);expect((await db.creditEntries.toArray()).filter(entry=>entry.purpose==='receipt')).toHaveLength(1);expect(await db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'credit'})).toEqual(sent);expect(await db.creditEntries.count()).toBe(count);await db.readBackup();
});
test('a stale order completion rolls back the hand-off; a reviewed retry records one quote',async()=>{
  const db=await boot();let order=await db.saveOrder(orderFixture().input);const input={...await draft(db),source:{kind:'order' as const,id:order.id},purpose:'quote' as const},root=await db.prepareHandoff(input),request=newHandoffActionId();await db.addOrderNote(order.id,'Owner note',order.revision);const count=await db.events.count();await expect(db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'order',revision:order.revision})).rejects.toThrow();expect((await db.readHandoff(root.id)).progress.status).toBe('ready');expect(await db.orderCommunications.count()).toBe(0);expect(await db.events.count()).toBe(count);order=(await db.orders.get(order.id))!;await db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'order',revision:order.revision});expect(await db.orderCommunications.count()).toBe(1);expect(await db.sales.count()).toBe(0);await db.readBackup();
});
test('a failed Sent audit rolls back the companion communication and permits one safe retry',async()=>{
  const db=await boot(),{input}=await creditDraft(db),root=await db.prepareHandoff(input),request=newHandoffActionId(),before=await db.readBackup();let blocked=true;db.events.hook('creating',(_key,event)=>{if(blocked&&event.command==='handoff.sent')throw new Error('Audit blocked');});await expect(db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'credit'})).rejects.toThrow('Audit blocked');expect((await db.readBackup()).tables).toEqual(before.tables);blocked=false;await db.changeHandoff(root.id,1,{type:'sent'},request,{kind:'credit'});expect((await db.creditEntries.toArray()).filter(entry=>entry.purpose==='receipt')).toHaveLength(1);await db.readBackup();
});
for(const saved of [false,true])test(`supplier completion supports ${saved?'saved':'manual'} suppliers and never receives stock`,async()=>{
  const db=await boot(),supplier=saved?await db.saveSupplier({name:'Fresh',phone:'01712345484',note:''}):undefined,item=await db.saveStockItem({...stockInput,supplierId:supplier?.id}),input:HandoffDraft={...await draft(db),source:supplier?{kind:'supplier',id:supplier.id}:{kind:'shop',id:(await db.setup())!.outlet.id},purpose:'supplier-order',text:'Please send 10 kg Chicken',target:supplier?'whatsapp':'copy',phone:supplier?.phone},root=await db.prepareHandoff(input),request=newHandoffActionId(),completion={kind:'supplier' as const,supplierName:supplier?.name||'Manual',stockItemIds:[item.id]},before=await db.stockMoves.count();await db.changeHandoff(root.id,1,{type:'sent'},request,completion);await db.changeHandoff(root.id,1,{type:'sent'},request,completion);expect(await db.supplierMessages.count()).toBe(1);expect((await db.supplierMessages.get(root.id))?.text).toBe(input.text);expect(await db.stockMoves.count()).toBe(before);expect(await db.stockItems.get(item.id)).toEqual(item);expect(await db.sales.count()).toBe(0);await db.readBackup();
});
test('completion data cannot attach to a different source or a Copy action',async()=>{
  const db=await boot(),root=await db.prepareHandoff(await draft(db)),count=await db.events.count();await expect(db.changeHandoff(root.id,1,{type:'sent'},undefined,{kind:'credit'})).rejects.toThrow();await expect(db.changeHandoff(root.id,1,{type:'copy'},undefined,{kind:'credit'})).rejects.toThrow('Only Sent');expect(await db.events.count()).toBe(count);expect((await db.readHandoff(root.id)).progress.status).toBe('ready');
});
