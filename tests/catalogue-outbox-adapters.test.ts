import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {assertLocalUploadCoverage,beginLocalUpload,deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {withOutboxIntents} from '../apps/web/src/data/outbox-capture';
import {backupToken,parseBackup} from '../packages/core/backup';
import type {Category,Item,AuditEvent} from '../packages/core/models';
import type {MiseBackup} from '../packages/core/backup-tables';
import {isCatalogueWrite,type CloudCommand,type CloudCommandReceipt} from '../packages/core/cloud-commands';
import {parseShopCommand,type ShopCommand} from '../packages/core/shop-commands';
import {newInboxId} from '../packages/core/inbox';
import {catalogueWriteFields} from '../supabase/functions/_shared/catalogue-write';
import {MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {REPORT_AT} from './report-backup-fixture';

const databases:Dexie[]=[],target='b'.repeat(64),literal='পণ্য\0'+String.fromCharCode(0xd800),input=(name=literal,category='নতুন বিভাগ')=>({name,nameLocal:literal,price:1234,unit:'pc',category,available:true,oftenBought:false});
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(REPORT_AT);});
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(seed?:(db:MiseDatabase)=>Promise<void>){const db=new MiseDatabase('mise-catalogue-outbox-'+randomUUID()),journal=new CloudUploadJournal('mise-catalogue-journal-'+randomUUID());databases.push(db,journal);const setup=await db.saveSetup({businessType:'corner_shop',marketCode:'BD',name:'Catalogue queue',phone:'01712345482'});await seed?.(db);const before=await db.readBackup(),snapshot=await journal.prepare(db,uploadId());await beginLocalUpload(db,snapshot,target);return {db,journal,setup,before,snapshot};}
async function queue(db:MiseDatabase){const rows=await db.outbox.orderBy('[uploadId+sequence]').toArray();expect(rows.every(row=>row.status==='pending'&&row.commands.length>0)).toBe(true);return rows;}
function catalogue(c:ShopCommand):c is CloudCommand{return c.type.startsWith('catalogue.');}
/** Serialized device intents go through the real server builder against the preceding graph. */
async function replay(db:MiseDatabase,original:MiseBackup){
 const items=new Map(original.tables.items.map(row=>[row.id,structuredClone(row)])),categories=new Map(original.tables.categories.map(row=>[row.id,structuredClone(row)])),outletId=original.tables.outlets[0].id,actorId=original.tables.members[0].id;
 for(const row of await queue(db)){
  for(const value of row.commands){
   const c=parseShopCommand(JSON.parse(JSON.stringify(value)));if(!catalogue(c)||c.type==='catalogue.undo')throw Error('Expected local catalogue intent');
   const before=items.get(c.itemId)??null,event=row.changes.find(change=>change.table==='events'&&change.key===c.id)!.after as AuditEvent;expect(event).toMatchObject({id:c.id,outletId,actor:{type:'member',id:actorId},command:c.type,at:c.occurredAt});
   if(isCatalogueWrite(c)){
    const ticketId=newInboxId(),fields=catalogueWriteFields({done:false,ticketId,token:'b'.repeat(43),outletId,actorId,at:c.occurredAt,itemJson:JSON.stringify(before),categoriesJson:JSON.stringify([...categories.values()])},c,ticketId);
    if('input' in c){
     const after:Item={id:c.itemId,outletId,name:JSON.parse(fields.p_name_json as string),nameLocal:JSON.parse(fields.p_local_json as string),categoryId:fields.p_category_id as string,price:fields.p_price as number,unit:JSON.parse(fields.p_unit_json as string),available:fields.p_available as boolean,oftenBought:fields.p_often_bought as boolean,isSample:false,createdAt:before?.createdAt??c.occurredAt,updatedAt:c.occurredAt};
     let category:Category|null=null;if(fields.p_new_category_json!==null){category={id:c.categoryId,outletId,name:JSON.parse(fields.p_new_category_json as string),sort:categories.size,createdAt:c.occurredAt,updatedAt:c.occurredAt};categories.set(category.id,category);expect(row.changes.find(change=>change.table==='categories'&&change.key===category!.id)!.after).toEqual(category);}expect(event.before).toEqual(before);expect(event.after).toEqual({item:after,category});items.set(after.id,after);
    }else{expect(Object.entries(fields).filter(([key])=>key!=='p_ticket_id'&&key!=='p_token').every(([,value])=>value===null)).toBe(true);expect(event.before).toEqual(before);expect(event.after).toBeNull();items.delete(c.itemId);}
   }else{if(!before||c.type!=='catalogue.availability')throw Error('Expected availability source');const after={...before,available:c.available,updatedAt:c.occurredAt};expect(event.before).toEqual(before);expect(event.after).toEqual(after);items.set(c.itemId,after);}
  }
  for(const change of row.changes){if(change.table==='items')expect(change.after).toEqual(items.get(change.key)??null);}
 }
}
async function verify(value:Awaited<ReturnType<typeof boot>>){await replay(value.db,value.before);await assertLocalUploadCoverage(value.db,value.snapshot,target);parseBackup(await value.db.readBackup());}

it('save/edit, category reuse, availability reversal and delete retain their exact original transaction identities',async()=>{
 const value=await boot(),{db}=value,created=await db.saveItem(input(' Tea\0 ',' New Drinks ')),edited=await db.saveItem({...input('চা','Ｎｅｗ Ｄｒｉｎｋｓ'),price:0,available:false,oftenBought:true},created.id);expect(edited.categoryId).toBe(created.categoryId);await db.setItemAvailable(created.id,true);await db.setItemAvailable(created.id,false);await db.deleteItem(created.id);const rows=await queue(db);expect(rows.map(row=>row.commands[0].type)).toEqual(['catalogue.create','catalogue.update','catalogue.availability','catalogue.availability','catalogue.delete']);expect(rows[0].commands[0]).toMatchObject({itemId:created.id,categoryId:created.categoryId,occurredAt:REPORT_AT});expect(rows[1].changes.some(change=>change.table==='categories')).toBe(false);await verify(value);
});
it('saved models and connection-like input extras never become catalogue wire fields',async()=>{
 const value=await boot(),saved=await value.db.saveItem({...input(),actorId:'Ignored actor',businessId:'Ignored tenant',publishableKey:'Ignored device setting'} as ReturnType<typeof input>),[row]=await queue(value.db),c=row.commands[0];expect(c).toMatchObject({type:'catalogue.create',itemId:saved.id,categoryId:saved.categoryId});expect(Object.keys(c).sort()).toEqual(['categoryId','id','input','itemId','occurredAt','outletId','type']);expect(JSON.stringify(c)).not.toMatch(/Ignored|createdAt|updatedAt|isSample|publishableKey/);await verify(value);
});
it('the complete 1,000-item paste remains one atomic local group with stable category reuse and recovery',async()=>{
 const value=await boot(),rows=Array.from({length:1000},(_,n)=>input('Bulk '+n,'Bulk category'));await value.db.addItems(rows);const [entry]=await queue(value.db);expect(entry.commands).toHaveLength(1000);expect(new Set(entry.commands.map(c=>c.id)).size).toBe(1000);expect(entry.changes.filter(change=>change.table==='items')).toHaveLength(1000);expect(entry.changes.filter(change=>change.table==='events')).toHaveLength(1000);expect(entry.changes.filter(change=>change.table==='categories')).toHaveLength(1);const categoryId=entry.changes.find(change=>change.table==='categories')!.key;expect(entry.commands.every(c=>catalogue(c)&&'input' in c&&c.categoryId===categoryId)).toBe(true);expect((await value.db.cloudState.get('binding'))!.sequence).toBe(1);await verify(value);
},30_000);
it('an invalid final row or oversized paste leaves no item, category, event or queue changes',async()=>{
 const value=await boot(),before=backupToken(await value.db.readBackup()),rows=Array.from({length:1000},(_,n)=>input('Bulk '+n));rows[999].name='';await expect(value.db.addItems(rows)).rejects.toThrow('item name');await expect(value.db.addItems(Array.from({length:1001},()=>input()))).rejects.toThrow('1,000');expect(backupToken(await value.db.readBackup())).toBe(before);expect(await value.db.outbox.count()).toBe(0);expect((await value.db.cloudState.get('binding'))!.sequence).toBe(0);await assertLocalUploadCoverage(value.db,value.snapshot,target);
});
it('sample removal keeps its protected audit and category while a real item cannot use that path',async()=>{
 const value=await boot(),{db}=value,sample=value.before.tables.items.find(item=>item.isSample)!;await db.removeSample(sample.id);const [row]=await queue(db);expect(row.commands[0]).toMatchObject({type:'catalogue.remove-sample',itemId:sample.id});expect(row.changes.map(change=>change.table).sort()).toEqual(['events','items']);expect(await db.categories.get(sample.categoryId)).toBeDefined();const real=await db.saveItem(input()),before=backupToken(await db.readBackup());await expect(db.removeSample(real.id)).rejects.toThrow('Only sample');expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(2);await verify(value);
});
for(const family of ['create','edit','availability','delete','sample','paste'] as const)it(`a queue failure rolls back the complete ${family} catalogue transaction`,async()=>{
 let saved:Item|undefined;const value=await boot(async db=>{if(['edit','availability','delete'].includes(family))saved=await db.saveItem(input('Before'));}),{db}=value,before=backupToken(await db.readBackup());db.use({stack:'dbcore',name:'catalogue-queue-failure',level:-2,create:down=>({...down,table(name){const table=down.table(name);return name==='outbox'?{...table,mutate:()=>Dexie.Promise.reject(new DOMException('Quota','QuotaExceededError'))}:table;}})});db.close();await db.open();
 const action=()=>family==='create'?db.saveItem(input()):family==='edit'?db.saveItem(input('After','Another category'),saved!.id):family==='availability'?db.setItemAvailable(saved!.id,false):family==='delete'?db.deleteItem(saved!.id):family==='sample'?db.removeSample(value.before.tables.items.find(item=>item.isSample)!.id):db.addItems([input('One','First'),input('Two','Second')]);await expect(action()).rejects.toThrow();expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(0);expect((await db.cloudState.get('binding'))!.sequence).toBe(0);await assertLocalUploadCoverage(db,value.snapshot,target);
});
for(const bulk of [false,true])it(`a ${bulk?'bulk':'single'} audit failure preserves the source and one safe retry`,async()=>{
 const value=await boot(),{db}=value,before=backupToken(await db.readBackup());let fail=true;db.events.hook('creating',(_key,event)=>{if(fail&&event.command==='catalogue.create'&&(!bulk||(event.after as {item:Item}).item.name==='Two'))throw Error('Catalogue audit denied');});const action=()=>bulk?db.addItems([input('One','First'),input('Two','Second')]):db.saveItem(input());await expect(action()).rejects.toThrow('audit denied');expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(0);fail=false;await action();expect(await db.outbox.count()).toBe(1);expect((await queue(db))[0].commands).toHaveLength(bulk?2:1);await verify(value);
});
it('a lost accepted reply resumes a paste after its durable receipt prefix with the exact original IDs',async()=>{
 const value=await boot(),{db,journal,snapshot}=value;await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,target,new MemoryCloudUpload());await db.addItems([input('One'),input('Two'),input('Three')]);const [entry]=await queue(db),sent:CloudCommand[]=[],accepted=new Map<string,CloudCommandReceipt>();let lose=true;
 const send=async(c:ShopCommand)=>{if(!catalogue(c)||c.type!=='catalogue.create')throw Error('Expected paste create');sent.push(c);let receipt=accepted.get(c.id);if(!receipt){receipt={id:c.id,type:c.type,itemId:c.itemId,outletId:c.outletId,occurredAt:c.occurredAt,categoryId:c.categoryId,available:c.input.available,at:REPORT_AT,itemUpdatedAt:REPORT_AT,sequence:accepted.size+1,undoOf:null};accepted.set(c.id,receipt);}if(c.id===entry.commands[1].id&&lose){lose=false;throw Error('Lost accepted reply');}return receipt;};
 await expect(deliverLocalOutbox(db,target,send)).rejects.toThrow('Lost');expect((await db.outbox.get(entry.id))!.receipts).toHaveLength(1);await deliverLocalOutbox(db,target,send);expect(sent.map(c=>c.id)).toEqual([entry.commands[0].id,entry.commands[1].id,entry.commands[1].id,entry.commands[2].id]);expect(sent[1]).toEqual(sent[2]);expect(accepted.size).toBe(3);expect((await db.outbox.get(entry.id))!.status).toBe('accepted');expect((await db.outbox.get(entry.id))!.receipts).toHaveLength(3);await assertLocalUploadCoverage(db,snapshot,target);
});
it('a mixed raw write keeps a grouped paste retained and stops later ordered delivery',async()=>{
 const value=await boot(),{db,journal,snapshot}=value;await db.transaction('rw',db.tables,async()=>{await db.addItems([input('One'),input('Two')]);await db.items.update(value.before.tables.items[0].id,{name:'Unclassified raw edit'});});await db.recordSale({expression:'5',method:'cash'});const rows=await db.outbox.orderBy('[uploadId+sequence]').toArray();expect(rows.map(row=>row.status)).toEqual(['retained','pending']);expect(rows[0].commands).toHaveLength(2);await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,target,new MemoryCloudUpload());const send=vi.fn(async()=>{throw Error('Do not skip retained source');});await deliverLocalOutbox(db,target,send);expect(send).not.toHaveBeenCalled();await assertLocalUploadCoverage(db,snapshot,target);
});
it('duplicate group identities cannot write and an out-of-scope group rolls back even after its source mutation',async()=>{
 const value=await boot(),{db}=value,before=backupToken(await db.readBackup()),id=newInboxId(),item=value.before.tables.items[0],c:CloudCommand={id,type:'catalogue.availability',outletId:value.setup.outlet.id,occurredAt:REPORT_AT,itemId:item.id,available:false};
 await expect(db.transaction('rw',db.tables,()=>withOutboxIntents(db,[c,c],async()=>{await db.items.update(item.id,{available:false});}))).rejects.toThrow('distinct');await expect(db.transaction('rw',db.tables,()=>withOutboxIntents(db,[{...c,outletId:newInboxId()}],async()=>{await db.items.update(item.id,{available:false});}))).rejects.toThrow('another outlet');expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(0);await assertLocalUploadCoverage(db,value.snapshot,target);
});
