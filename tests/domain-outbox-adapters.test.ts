import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal} from '../apps/web/src/data/cloud-upload';
import {assertLocalUploadCoverage,beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {backupToken} from '../packages/core/backup';
import type {BackupTable,MiseBackup} from '../packages/core/backup-tables';
import {cloudRecordMap,cloudRecordMaps,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,creditBalance} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';
import {newClosingId} from '../packages/core/closing';
import {closingPreview} from '../packages/core/today';
import {parseShopCommand,isCustomerCommand,isStockCommand,isPurchaseCommand,isClosingCommand} from '../packages/core/shop-commands';
import {stockWritePlan} from '../packages/core/stock-commands';
import {purchaseWritePlan} from '../packages/core/purchase-commands';
import {customerWriteFields} from '../supabase/functions/_shared/customer-write';
import {stockWriteFields} from '../supabase/functions/_shared/stock-write';
import {purchaseWriteFields} from '../supabase/functions/_shared/purchase-write';
import {closingWriteFields} from '../supabase/functions/_shared/closing-write';
import {cloudUploadFixture,uploadId} from './cloud-upload-fixture';
import {REPORT_AT} from './report-backup-fixture';
import {stockInput} from './stock-fixture';

const databases:Dexie[]=[],target='a'.repeat(64);
const profile=(name='New customer')=>({name,nickname:' Regular ',phone:'০১৭১২৩৪৫৪৮৪',address:'Road 12',notes:'Literal source\0'+String.fromCharCode(0xd800),tags:['regular']});
const credit=()=>({...defaultCreditTerms,allowed:true,limit:100000});
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(REPORT_AT);});
afterEach(async()=>{vi.useRealTimers();await Promise.all(databases.splice(0).map(db=>db.delete()));});
async function boot(prepare?:(db:MiseDatabase)=>Promise<void>){
 const db=new MiseDatabase('mise-domain-outbox-'+randomUUID()),journal=new CloudUploadJournal('mise-domain-journal-'+randomUUID());databases.push(db,journal);
 const original=cloudUploadFixture();await db.restoreBackup(original,await db.previewRestore(original));await prepare?.(db);
 const before=await db.readBackup(),snapshot=await journal.prepare(db,uploadId());await beginLocalUpload(db,snapshot,target);return {db,before,snapshot};
}
async function review(db:MiseDatabase,overage=0){const p=closingPreview(await db.readToday());return {id:newClosingId(),day:p.summary.day,fingerprint:p.fingerprint,countedCash:p.summary.expectedCash+overage,addDifference:overage>0,note:''};}
async function queue(db:MiseDatabase){const rows=await db.outbox.orderBy('[uploadId+sequence]').toArray();expect(rows.every(r=>r.status==='pending'&&r.commands.length===1)).toBe(true);return rows;}

/** Replay actual durable wire intents through the deployed server's mutation builders.
 * Equal clocks isolate record/companion identity and domain values from canonical-time reconciliation. */
async function replay(db:MiseDatabase,original:MiseBackup){
 const shadow=structuredClone(original.tables),setup={business:shadow.businesses[0],outlet:shadow.outlets[0],owner:shadow.members[0]},businessId=setup.business.id;
 const raw=(table:BackupTable,row:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,row,businessId).values).map(([key,value])=>[key,value!==null&&(cloudRecordMap(table).fields as Record<string,string>)[key]?.startsWith('j:')?JSON.parse(value as string):value]));
 for(const entry of await queue(db)){
  const c=parseShopCommand(entry.commands[0]),event=entry.changes.find(change=>change.table==='events'&&change.key===c.id)!.after as {at:number};
  const ticketId=newInboxId(),prepared={done:false,ticketId,token:'a'.repeat(43),businessId,outletId:setup.outlet.id,actorId:setup.owner.id,at:event.at};
  const common={business:raw('businesses',setup.business),outlet:raw('outlets',setup.outlet)};
  let fields:Record<string,unknown>;
  if(isCustomerCommand(c)){
   const customer=shadow.customers.find(row=>row.id===c.customerId),accounts=shadow.creditAccounts.filter(row=>row.customerId===c.customerId&&row.outletId===c.outletId);
   fields=customerWriteFields({...prepared,contextJson:JSON.stringify({...common,customer:customer?raw('customers',customer):null,accounts:accounts.map(a=>raw('creditAccounts',a)),hasBalance:accounts.some(a=>creditBalance(a,shadow.creditEntries)!==0)})},c,ticketId);
  }else if(isStockCommand(c)){
   const itemIds=stockWritePlan(c).rows.map(row=>row.itemId);
   fields=stockWriteFields({...prepared,contextJson:JSON.stringify({...common,items:shadow.stockItems.map(r=>raw('stockItems',r)),moves:shadow.stockMoves.filter(r=>itemIds.includes(r.stockItemId)).map(r=>raw('stockMoves',r)),suppliers:shadow.suppliers.map(r=>raw('suppliers',r))})},c,ticketId);
  }else if(isPurchaseCommand(c)){
   const plan=purchaseWritePlan(c),supplier=shadow.suppliers.find(r=>r.id===plan.supplierId),purchase=shadow.purchases.find(r=>r.id===plan.purchaseId);
   fields=purchaseWriteFields({...prepared,contextJson:JSON.stringify({...common,supplier:supplier?raw('suppliers',supplier):null,purchase:purchase?raw('purchases',purchase):null,stock:shadow.stockItems.filter(r=>plan.stockItemIds.includes(r.id)).map(r=>raw('stockItems',r))})},c,ticketId);
  }else if(isClosingCommand(c)){
   const closing=shadow.dayClosings.find(r=>r.id===c.closingId),sale=shadow.sales.find(r=>r.id===c.saleId),context:Record<string,unknown>={...common,actorName:setup.owner.name,closing:closing?raw('dayClosings',closing):null,sale:sale?raw('sales',sale):null};
   for(const [key,table] of Object.entries({sales:'sales',orders:'orders',refunds:'orderRefunds',accounts:'creditAccounts',entries:'creditEntries',customers:'customers',stock:'stockItems',closings:'dayClosings'}) as [string,BackupTable][])context[key]=shadow[table].map(row=>raw(table,row));
   fields=closingWriteFields({...prepared,contextJson:JSON.stringify(context)},c,ticketId);
  }else throw new Error('Unexpected adapter family: '+c.type);
  const actual=fields.p_records as CloudRecord[],expected=entry.changes.filter(r=>r.after!==null).map(r=>encodeCommandRecord(r.table,r.after,businessId));
  const sorted=(rows:CloudRecord[])=>rows.toSorted((a,b)=>(a.table+':'+a.values.id).localeCompare(b.table+':'+b.values.id)).map(row=>{const fields=Object.values(cloudRecordMaps).find(map=>map.table===row.table)!.fields as Record<string,string>;return {...row,values:Object.fromEntries(Object.entries(row.values).map(([key,value])=>[key,value!==null&&/^[je]:/.test(fields[key]??'')?JSON.parse(value as string):value]))};});
  expect(sorted(actual),c.type).toEqual(sorted(expected));
  for(const change of entry.changes){const rows=shadow[change.table] as {id:string}[],index=rows.findIndex(r=>r.id===change.key);if(index>=0)rows.splice(index,1);if(change.after)rows.push(change.after as {id:string});}
 }
}

it('customer creation, profile-only edits, credit settings and archive/restore retain one original account',async()=>{
 const {db,before,snapshot}=await boot(),customer=await db.saveCustomer(profile()),account=(await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0];
 expect(account.allowed).toBe(false);await db.saveCustomer({...customer,name:'Renamed',phone:customer.phone??''},{id:customer.id});await db.saveCreditTerms(customer.id,{...account,...credit()},account.id);await db.archiveCustomer(customer.id);await db.archiveCustomer(customer.id,false);
 const commands=(await queue(db)).flatMap(r=>r.commands);expect(commands.map(c=>c.type)).toEqual(['customer.create','customer.update','khata.settings','customer.archive','customer.restore']);
 expect(commands[1]).toMatchObject({ids:{accountId:account.id},credit:null,opening:null});if(commands[1].type!=='customer.update')throw Error('Expected customer edit');expect(Object.keys(commands[1].input).sort()).toEqual(['address','name','nickname','notes','phone','tags']);expect(await db.creditAccounts.where('customerId').equals(customer.id).count()).toBe(1);
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('new customer terms, historical opening balance and all companion audits keep their saved identities',async()=>{
 const {db,before,snapshot}=await boot(),customer=await db.saveCustomer(profile(),{credit:credit(),opening:{amount:12345,occurredAt:REPORT_AT-86400000}}),[row]=await queue(db),entry=await db.creditEntries.where('customerId').equals(customer.id).first();
 expect(row.commands[0]).toMatchObject({id:row.changes.find(c=>c.table==='events'&&(c.after as {command:string}).command==='customer.create')!.key,ids:{accountId:entry!.accountId,openingEntryId:entry!.id,openingEventId:entry!.eventId},opening:{amount:12345,occurredAt:REPORT_AT-86400000}});
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('a pre-existing customer without an account creates one with the original terms event',async()=>{
 const {db,before,snapshot}=await boot(async db=>{const change=saveCustomerCommand(profile('Legacy customer'),(await db.setup())!,await db.customers.toArray());await db.customers.add(change.customer);await db.events.add(change.event);}),customer=(await db.customers.toArray()).find(c=>c.name==='Legacy customer')!,account=await db.saveCreditTerms(customer.id,credit());
 const [row]=await queue(db);expect(row.commands[0]).toMatchObject({type:'khata.settings',accountId:null,ids:{accountId:account.id}});expect(row.commands[0].id).not.toBe((row.commands[0] as {ids:{accountEventId:string}}).ids.accountEventId);
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('stock creates, profile/count updates, relative deltas, undo and archive/restore replay without invented moves',async()=>{
 const {db,before,snapshot}=await boot();let item=await db.saveStockItem({...stockInput,name:'Rice',onHand:12.125});
 item=await db.saveStockItem({...stockInput,name:'Rice',onHand:item.onHand,target:40},{id:item.id,revision:item.revision});
 item=await db.saveStockItem({...stockInput,name:'Rice',onHand:11.005},{id:item.id,revision:item.revision});
 item=await db.adjustStock({id:item.id,revision:item.revision,reason:'used',quantity:0.125,source:'quick_update',note:'  literal note  '});const move=await db.stockMoves.where('stockItemId').equals(item.id).and(r=>r.reason==='used').first();
 item=await db.undoStockMove(move!.id,item.revision);item=await db.archiveStockItem(item.id,true,item.revision);await db.archiveStockItem(item.id,false,item.revision);
 const commands=(await queue(db)).flatMap(r=>r.commands);expect(commands.map(c=>c.type)).toEqual(['stock.create','stock.update','stock.update','stock.adjust','stock.undo','stock.archive','stock.restore']);expect(commands[1]).toMatchObject({moveId:null});expect(commands[2]).toMatchObject({input:{onHand:11.005}});expect(commands[3]).toMatchObject({change:{quantity:0.125,source:'quick_update',note:'literal note'}});expect(commands[4]).toMatchObject({undoMoveId:move!.id});
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('relative stock batches and zero-valued physical counts retain each movement and the shared count identity',async()=>{
 const {db,before,snapshot}=await boot();let first=(await db.stockItems.toArray())[0],second=await db.saveStockItem({...stockInput,name:'Rice',onHand:12});
 [first,second]=await db.applyStockBatch([{id:first.id,revision:first.revision,reason:'used',quantity:0.125,source:'quick_update'},{id:second.id,revision:second.revision,reason:'received',quantity:1.005}]);
 await db.applyStockBatch([{id:first.id,revision:first.revision,reason:'count',quantity:0},{id:second.id,revision:second.revision,reason:'count',quantity:11.125}],true);
 const rows=await queue(db),c=rows[2].commands[0];expect(c).toMatchObject({type:'stock.batch',count:true,changes:[{quantity:0,reason:'count',source:'count'},{quantity:11.125,reason:'count',source:'count'}]});if(c.type!=='stock.batch')throw Error('Expected batch');expect(c.batchId).not.toBeNull();expect(c.changes[0].eventId).toBe(c.id);expect(rows[2].changes.filter(r=>r.table==='stockMoves').every(r=>(r.after as {countBatchId:string}).countBatchId===c.batchId)).toBe(true);
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('supplier revisions and a 200-line wallet invoice preserve identity without receiving stock or recording cash',async()=>{
 const {db,before,snapshot}=await boot(),stock=(await db.stockItems.toArray())[0],stockBefore=await db.stockItems.toArray(),salesBefore=await db.sales.toArray(),entriesBefore=await db.creditEntries.toArray();let supplier=await db.saveSupplier({name:' Fresh ',phone:'০১৭১২৩৪৫৪৮৫',note:'Literal'});
 supplier=await db.saveSupplier({name:'Fresh supplier',phone:supplier.phone!,note:'Updated'},{id:supplier.id,revision:supplier.revision});supplier=await db.archiveSupplier(supplier.id,true,supplier.revision);supplier=await db.archiveSupplier(supplier.id,false,supplier.revision);
 const purchase=await db.recordPurchase({supplierId:supplier.id,supplierName:supplier.name,reference:'INV-200',lines:Array.from({length:200},()=>({stockItemId:stock.id,name:stock.name,unit:stock.unit,qty:0.125,unitPrice:12345})),paid:'wallet',wallet:'bKash',note:'হিসাব'});await db.undoPurchase(purchase.id);
 const commands=(await queue(db)).flatMap(r=>r.commands);expect(commands.map(c=>c.type)).toEqual(['supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo']);expect(commands[4]).toMatchObject({id:purchase.eventId,purchaseId:purchase.id,input:{wallet:'bKash',supplierId:supplier.id}});expect(await db.stockItems.toArray()).toEqual(stockBefore);expect(await db.sales.toArray()).toEqual(salesBefore);expect(await db.creditEntries.toArray()).toEqual(entriesBefore);
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('closing, linked cash receipt and same-day undo keep separate original audits and repeated Save queues once',async()=>{
 const {db,before,snapshot}=await boot(),input=await review(db,1250),closing=await db.closeDay(input);await db.closeDay(input);expect(await db.outbox.count()).toBe(1);
 vi.setSystemTime(REPORT_AT+1000);await db.undoDayClosing(closing.id);const [create,undo]=await queue(db),created=create.commands[0],undone=undo.commands[0];
 expect(created).toMatchObject({type:'closing.record',id:closing.eventId,saleId:closing.addedSaleId,input:{fingerprint:input.fingerprint,countedCash:input.countedCash}});expect(undone).toMatchObject({type:'closing.undo',saleId:closing.addedSaleId});if(!isClosingCommand(created)||!isClosingCommand(undone))throw Error('Expected closing commands');expect(undone.id).not.toBe(created.id);expect(undone.saleEventId).not.toBe(created.saleEventId);expect(undo.changes.filter(c=>c.table==='events').map(c=>c.key).sort()).toEqual([undone.id,undone.saleEventId].sort());
 await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('an exact cash closing and its undo carry no invented financial companions',async()=>{
 const {db,before,snapshot}=await boot(),closing=await db.closeDay(await review(db));await db.undoDayClosing(closing.id);for(const row of await queue(db))expect(row.commands[0]).toMatchObject({saleId:null,saleEventId:null});await replay(db,before);await assertLocalUploadCoverage(db,snapshot,target);
});
it('stale stock, changed closing review and an unpaid customer archive add no records or queue entries',async()=>{
 const {db,snapshot}=await boot(),item=(await db.stockItems.toArray())[0],account=(await db.creditAccounts.toArray())[0],closing=await review(db);await db.adjustStock({id:item.id,revision:item.revision,reason:'count',quantity:1});
 const before=backupToken(await db.readBackup()),rows=await db.outbox.toArray();await expect(db.adjustStock({id:item.id,revision:item.revision,reason:'count',quantity:2})).rejects.toThrow('changed');await expect(db.closeDay(closing)).rejects.toThrow('changed');await expect(db.archiveCustomer(account.customerId)).rejects.toThrow();expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.toArray()).toEqual(rows);await assertLocalUploadCoverage(db,snapshot,target);
});
for(const family of ['customer','stock','supplier','purchase','closing'] as const)it(`a failed outbox write rolls back the complete ${family} action and its audits`,async()=>{
 const {db,snapshot}=await boot(),before=backupToken(await db.readBackup()),closing=await review(db,500);
 db.use({stack:'dbcore',name:'domain-queue-failure',level:-2,create:down=>({...down,table(name){const table=down.table(name);return name==='outbox'?{...table,mutate:()=>Dexie.Promise.reject(new DOMException('Quota','QuotaExceededError'))}:table;}})});db.close();await db.open();
 const write=()=>family==='customer'?db.saveCustomer(profile()):family==='stock'?db.saveStockItem({...stockInput,name:'New stock'}):family==='supplier'?db.saveSupplier({name:'New supplier',phone:'',note:''}):family==='purchase'?db.recordPurchase({supplierName:'Supplier',reference:'',lines:[{name:'Rice',unit:'kg',qty:1,unitPrice:100}],paid:'due',note:''}):db.closeDay(closing);
 await expect(write()).rejects.toThrow();expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(0);expect((await db.cloudState.get('binding'))!.sequence).toBe(0);await assertLocalUploadCoverage(db,snapshot,target);
});
