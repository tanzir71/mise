import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {assertLocalUploadCoverage,beginLocalUpload,deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {backupToken} from '../packages/core/backup';
import type {BackupTable,MiseBackup} from '../packages/core/backup-tables';
import {cloudRecordMaps,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {defaultCreditTerms} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';
import {nextOrderStatuses,type OrderInput} from '../packages/core/orders';
import type {CreditAccount,Customer} from '../packages/core/models';
import type {BusinessType} from '../packages/core/packs';
import {isOrderSave,orderWritePlan,type OrderCommand,type OrderCommandReceipt} from '../packages/core/order-commands';
import {isOrderCommand,parseShopCommand} from '../packages/core/shop-commands';
import {orderWriteFields} from '../supabase/functions/_shared/order-write';
import {MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {REPORT_AT} from './report-backup-fixture';
import {orderFixture} from './order-fixture';

const databases:Dexie[]=[],target='b'.repeat(64),literal='মূল\0'+String.fromCharCode(0xd800);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(REPORT_AT);});
afterEach(async()=>{vi.useRealTimers();await Promise.all(databases.splice(0).map(db=>db.delete()));});
const input=():OrderInput=>({...orderFixture().input,sourceText:literal});
const creditInput=(customer:Customer):OrderInput=>({...input(),customerId:customer.id,phone:customer.phone!,payment:{method:'credit'}});
async function boot(type:BusinessType='corner_shop',seed?:(db:MiseDatabase,customer:Customer,account:CreditAccount)=>Promise<void>){
 const db=new MiseDatabase('mise-order-outbox-'+randomUUID()),journal=new CloudUploadJournal('mise-order-journal-'+randomUUID());databases.push(db,journal);
 await db.saveSetup({businessType:type,marketCode:'BD',name:'Order queue',phone:'01712345482'});
 const customer=await db.saveCustomer({name:'Rina',nickname:'',phone:'01712345483',address:'Road 12',notes:literal,tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}}),account=(await db.creditAccounts.toArray())[0];
 await seed?.(db,customer,account);const before=await db.readBackup(),snapshot=await journal.prepare(db,uploadId());await beginLocalUpload(db,snapshot,target);return {db,journal,before,snapshot,customer,account};
}
async function queued(db:MiseDatabase){const rows=await db.outbox.orderBy('[uploadId+sequence]').toArray();expect(rows.every(row=>row.status==='pending'&&row.commands.length===1)).toBe(true);return rows;}
async function replay(db:MiseDatabase,original:MiseBackup){
 const shadow=structuredClone(original.tables),businessId=shadow.businesses[0].id;
 const raw=(table:BackupTable,row:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,row,businessId).values).map(([key,value])=>[key,value!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[key]?.startsWith('j:')?JSON.parse(value as string):value]));
 const normalized=(rows:CloudRecord[])=>rows.toSorted((a,b)=>(a.table+':'+a.values.id).localeCompare(b.table+':'+b.values.id)).map(row=>{const map=Object.values(cloudRecordMaps).find(m=>m.table===row.table)!.fields as Record<string,string>;return {...row,values:Object.fromEntries(Object.entries(row.values).map(([key,value])=>[key,value!==null&&/^[je]:/.test(map[key]??'')?JSON.parse(value as string):value]))};});
 for(const entry of await queued(db)){
  const c=parseShopCommand(entry.commands[0]);if(!isOrderCommand(c))throw Error('Unexpected command: '+c.type);const plan=orderWritePlan(c),before=shadow.orders.find(o=>o.id===plan.orderId),sale=shadow.sales.find(s=>s.id===before?.payment.saleId),customer=shadow.customers.find(r=>r.id===(isOrderSave(c)?c.input.customerId:before?.customer.id));
  const account=shadow.creditAccounts.find(r=>r.id===(plan.accountId??sale?.creditAccountId)),status=shadow.events.find(r=>r.id===before?.statusEventId),refund=shadow.orderRefunds.find(r=>r.id===plan.refundId),outlet=shadow.outlets[0],owner=shadow.members[0],event=entry.changes.find(change=>change.table==='events'&&change.key===c.id)!.after as {at:number},ticketId=newInboxId();
  const context={business:raw('businesses',shadow.businesses[0]),outlet:raw('outlets',outlet),order:before?raw('orders',before):null,customer:customer?raw('customers',customer):null,account:account?raw('creditAccounts',account):null,sale:sale?raw('sales',sale):null,statusEvent:status?raw('events',status):null,refund:refund?raw('orderRefunds',refund):null,items:shadow.items.filter(r=>plan.itemIds.includes(r.id)).map(r=>raw('items',r)),entries:shadow.creditEntries.filter(r=>r.accountId===account?.id).map(r=>raw('creditEntries',r)),sequence:before?.sequence??Math.max(0,...shadow.orders.map(o=>o.sequence))+1};
  const fields=orderWriteFields({done:false,ticketId,token:'b'.repeat(43),businessId,outletId:outlet.id,actorId:owner.id,at:event.at,contextJson:JSON.stringify(context)},c,ticketId),expected=entry.changes.filter(change=>change.after!==null).map(change=>encodeCommandRecord(change.table,change.after,businessId));
  expect(normalized(fields.p_records as CloudRecord[]),c.type).toEqual(normalized(expected));
  for(const change of entry.changes){const rows=shadow[change.table] as {id:string}[],at=rows.findIndex(r=>r.id===change.key);if(at>=0)rows.splice(at,1);if(change.after)rows.push(change.after as {id:string});}
 }
}
async function verify(value:Awaited<ReturnType<typeof boot>>){await replay(value.db,value.before);await assertLocalUploadCoverage(value.db,value.snapshot,target);}

it('create/edit retains original line IDs, literal source, notes and contact records without leaking model fields',async()=>{
 const value=await boot(),{db}=value;let order=await db.saveOrder(input());const oldLine=order.lines[0].id;
 order=await db.saveOrder({...input(),lines:[{...order.lines[0],note:literal},{name:'Rice',unit:'kg',qty:0.125,unitPrice:12345}]},{id:order.id,revision:order.revision});
 await db.addOrderNote(order.id,'  '+literal+'  ',order.revision);order=(await db.orders.get(order.id))!;await db.recordOrderCommunication(order.id,{purpose:'message',channel:'manual',text:literal},order.revision);await db.saveOrderWarning(45);
 const rows=await queued(db),commands=rows.map(r=>r.commands[0]);expect(commands.map(c=>c.type)).toEqual(['order.create','order.update','order.note','order.communication','order.warning-settings']);const edit=commands[1];if(!isOrderCommand(edit)||!isOrderSave(edit))throw Error('Expected edit');expect(edit.input.lines[0].id).toBe(oldLine);expect(edit.input.lines[0]).not.toHaveProperty('lineTotal');expect(edit.newLineIds).toEqual([(await db.orders.get(order.id))!.lines[1].id]);expect(commands[2]).toMatchObject({noteId:(await db.orderNotes.toArray())[0].id,text:literal});expect(commands[3]).toMatchObject({communicationId:(await db.orderCommunications.toArray())[0].id});await verify(value);
});
for(const type of ['restaurant','online_shop','food_stall','corner_shop'] as const)it(`the ${type} flow retains status revisions and its original undo audit`,async()=>{
 const value=await boot(type),{db}=value;let order=await db.saveOrder(input());const next=nextOrderStatuses(order)[0];order=await db.changeOrderStatus(order.id,next,order.revision);order=await db.undoOrderStatus(order.id,order.revision);expect(order.revision).toBe(3);expect((await queued(db)).map(r=>r.commands[0].type)).toEqual(['order.create','order.status','order.status-undo']);await verify(value);
});
for(const method of ['cash','wallet','card','credit'] as const)it(`compound save-and-${method} queues one atomic command with its complete financial plan`,async()=>{
 const value=await boot(),{db,customer,account}=value,body=method==='credit'?creditInput(customer):input(),order=await db.saveOrder(body,{settlement:{method,...(method==='wallet'?{wallet:'bKash'}:{}),...(method==='credit'?{accountId:account.id}:{}),...(method==='cash'?{given:5000}:{})}}),[row]=await queued(db),c=row.commands[0];
 if(!isOrderCommand(c)||!isOrderSave(c)||!c.settlement)throw Error('Expected compound save');expect(c.id).not.toBe(order.eventId);expect(c.settlement.id).toBe(order.eventId);expect(c.settlement.ids.saleId).toBe(order.payment.saleId);expect(c.newLineIds).toEqual(order.lines.map(line=>line.id));expect(row.changes.filter(r=>r.table==='events')).toHaveLength(method==='credit'?4:3);expect(row.changes.find(r=>r.table==='orders')!.after).toEqual(order);if(method==='credit'){const entry=await db.creditEntries.where('saleId').equals(order.payment.saleId!).first();expect(c.settlement.ids).toMatchObject({entryId:entry!.id,creditEventId:entry!.eventId});}
 await verify(value);
});
it('payment, receipt undo and repayment retain original sources while an old receipt cannot undo the newer payment',async()=>{
 const value=await boot(),{db}=value;let order=await db.saveOrder(input());order=await db.settleOrder(order.id,{method:'cash',given:5000},order.revision);const oldSale=order.payment.saleId!;await db.undoSale(oldSale);order=(await db.orders.get(order.id))!;order=await db.settleOrder(order.id,{method:'wallet',wallet:'bKash'},order.revision);
 const before=backupToken(await db.readBackup()),rows=await db.outbox.toArray();await expect(db.undoSale(oldSale)).rejects.toThrow('does not match');expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.toArray()).toEqual(rows);const commands=(await queued(db)).map(r=>r.commands[0]);expect(commands.map(c=>c.type)).toEqual(['order.create','order.payment','order.payment-undo','order.payment']);expect(commands[2]).toMatchObject({sourceSaleId:oldSale,sourcePaymentAt:REPORT_AT});expect(order.payment.saleId).not.toBe(oldSale);await verify(value);
});
it('credit payment resolves the exact local account and retains explicit over-limit consent',async()=>{
 const value=await boot('corner_shop',async(db,customer,account)=>{await db.saveCreditTerms(customer.id,{...account,limit:100},account.id);}),{db,customer,account}=value;let order=await db.saveOrder(creditInput(customer));await expect(db.settleOrder(order.id,{method:'credit'},order.revision)).rejects.toMatchObject({name:'CreditLimitError'});order=await db.settleOrder(order.id,{method:'credit',confirmation:{balance:0,limit:100}},order.revision);const rows=await queued(db),c=rows[1].commands[0];expect(c).toMatchObject({type:'order.payment',input:{method:'credit',accountId:account.id,confirmation:{balance:0,limit:100}}});expect(order.payment.status).toBe('credited');await verify(value);
});
it('credit payment undo retains its new reversal entry and both financial audits',async()=>{
 const value=await boot(),{db,customer}=value;let order=await db.saveOrder(creditInput(customer),{settlement:{method:'credit'}});const saleId=order.payment.saleId!;order=await db.undoOrderPayment(order.id,order.revision);const row=(await queued(db))[1],c=row.commands[0],reversal=await db.creditEntries.where('saleId').equals(saleId).and(entry=>entry.reversalOf!==undefined).first();expect(c).toMatchObject({type:'order.payment-undo',sourceSaleId:saleId,ids:{entryId:reversal!.id,creditEventId:reversal!.eventId}});expect(row.changes.filter(change=>change.table==='events')).toHaveLength(3);expect(order.payment.status).toBe('pending');await verify(value);
});
it('a portable legacy payment without its optional occurrence field keeps local undo and is retained for review',async()=>{
 const value=await boot('corner_shop',async db=>{const order=await db.saveOrder(input(),{settlement:{method:'cash'}});await db.orders.put({...order,payment:{...order.payment,at:undefined}});}),{db}=value,order=(await db.orders.toArray())[0];await db.undoOrderPayment(order.id,order.revision);expect((await db.orders.get(order.id))!.payment.status).toBe('pending');const [row]=await db.outbox.toArray();expect(row).toMatchObject({status:'retained',commands:[]});expect(row.changes.some(change=>change.table==='sales')).toBe(true);await assertLocalUploadCoverage(db,value.snapshot,target);
});
it('compound edits of an unpaid order keep old lines and commit the new line, edit and settlement together',async()=>{
 const value=await boot(),{db}=value;let order=await db.saveOrder(input());order=await db.saveOrder({...input(),lines:[...order.lines,{name:'Rice',unit:'kg',qty:0.125,unitPrice:12345}]},{id:order.id,revision:order.revision,settlement:{method:'cash'}});const rows=await queued(db),c=rows[1].commands[0];expect(c).toMatchObject({type:'order.update',revision:1,settlement:{id:order.eventId}});expect(order.revision).toBe(3);expect(rows[1].changes.filter(r=>r.table==='events')).toHaveLength(3);await verify(value);
});
it('free orders retain payment and cancellation intents without inventing receipts or refund records',async()=>{
 const value=await boot(),{db}=value;let order=await db.saveOrder({...input(),lines:[{name:'Free',unit:'pcs',qty:1,unitPrice:0}]},{settlement:{method:'card'}});expect(order.payment.saleId).toBeUndefined();order=await db.undoOrderPayment(order.id,order.revision);order=await db.settleOrder(order.id,{method:'cash'},order.revision);order=await db.changeOrderStatus(order.id,'cancelled',order.revision);await db.undoOrderStatus(order.id,order.revision);expect(await db.sales.count()).toBe(0);expect(await db.orderRefunds.count()).toBe(0);await verify(value);
});
it('an unpriced order keeps the full 200-line source and can price and confirm its swaps later',async()=>{
 const value=await boot(),{db}=value,source=(literal+'x'.repeat(100)).repeat(110).slice(0,12000);let order=await db.saveOrder({...input(),source:'paste',sourceText:source,lines:Array.from({length:200},(_,n)=>({name:'Item '+n,unit:'pcs',qty:0.125,unitPrice:n===0?null:12345,note:'x'.repeat(498)+literal.slice(0,2)}))});expect(order.total).toBeNull();await expect(db.changeOrderStatus(order.id,'priced',order.revision)).rejects.toThrow('Price');order=await db.saveOrder({...input(),source:'paste',sourceText:source,lines:order.lines.map((line,n)=>({...line,unitPrice:12345,...(n===0?{substitution:{from:'Original',accepted:true}}:{})}))},{id:order.id,revision:order.revision});await db.changeOrderStatus(order.id,'priced',order.revision);const [row]=await queued(db),c=row.commands[0];if(!isOrderCommand(c)||!isOrderSave(c))throw Error('Expected save');expect(c.input.sourceText).toBe(source);expect(c.input.lines).toHaveLength(200);expect(c.input.lines[0].note).toHaveLength(500);await verify(value);
});
for(const method of ['cash','credit'] as const)it(`${method} cancellation, partial refund, refund undo and receipt-based cancellation undo retain every companion`,async()=>{
 const value=await boot('corner_shop',async(db,customer,account)=>{await db.saveOrder(method==='credit'?creditInput(customer):input(),{settlement:{method,...(method==='credit'?{accountId:account.id}:{})}});if(method==='credit')await db.recordCreditPayment(account.id,1000,'cash');}),{db}=value;let order=(await db.orders.toArray())[0];const originalSale=order.payment.saleId!;
 order=await db.changeOrderStatus(order.id,'cancelled',order.revision);const refund=await db.refundOrder(order.id,{amount:500,method:'wallet',wallet:'bKash',note:literal},order.revision);order=(await db.orders.get(order.id))!;await db.undoOrderRefund(refund.id,order.revision);order=(await db.orders.get(order.id))!;await db.undoSale(originalSale);const commands=(await queued(db)).map(r=>r.commands[0]);expect(commands.map(c=>c.type)).toEqual(['order.status','order.refund','order.refund-undo','order.status-undo']);expect(commands[0]).toMatchObject({sourceSaleId:originalSale});expect(commands[1]).toMatchObject({sourceSaleId:originalSale,ids:{refundId:refund.id,refundEventId:refund.eventId}});expect(commands[2]).toMatchObject({refundId:refund.id});if(commands[2].type!=='order.refund-undo')throw Error('Expected refund undo');expect(commands[2].ids.refundId).not.toBe(refund.id);expect((await db.sales.get(originalSale))!.voidedAt).toBeUndefined();await verify(value);
});
it('a stale review and an invalid compound payment leave the order number and queue untouched',async()=>{
 const value=await boot(),{db}=value;let order=await db.saveOrder(input());await db.addOrderNote(order.id,'Another review',order.revision);const before=backupToken(await db.readBackup()),rows=await db.outbox.toArray();await expect(db.settleOrder(order.id,{method:'cash'},order.revision)).rejects.toThrow('changed');await expect(db.saveOrder(input(),{settlement:{method:'cash',given:1}})).rejects.toThrow('Given');expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.toArray()).toEqual(rows);order=await db.saveOrder(input());expect(order.number).toBe('A-0002');await verify(value);
});
it('a lost compound acceptance retries the same order, line, payment and companion IDs',async()=>{
 const value=await boot(),{db,journal,snapshot}=value,order=await db.saveOrder(input(),{settlement:{method:'cash'}});await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,target,new MemoryCloudUpload());const requests:OrderCommand[]=[],accepted=new Map<string,OrderCommandReceipt>();let lose=true;
 await expect(deliverLocalOutbox(db,target,async command=>{if(!isOrderCommand(command)||!isOrderSave(command)||!command.settlement)throw Error('Expected compound');requests.push(command);const receipt:OrderCommandReceipt={id:command.id,type:command.type,outletId:command.outletId,orderId:command.orderId,occurredAt:command.occurredAt,at:REPORT_AT,updatedAt:REPORT_AT,revision:2,sequence:1,number:'A-0001',total:2500,saleId:command.settlement.ids.saleId,entryId:null,refundId:null,noteId:null,communicationId:null,undoOf:null};accepted.set(command.id,receipt);if(lose){lose=false;throw Error('Lost acceptance reply');}return receipt;})).rejects.toThrow('Lost');
 await deliverLocalOutbox(db,target,async command=>{if(!isOrderCommand(command))throw Error('Expected order');requests.push(command);return accepted.get(command.id)!;});expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(accepted.size).toBe(1);expect((await db.outbox.toArray())[0].status).toBe('accepted');expect((await db.orders.get(order.id))!.payment.saleId).toBe(order.payment.saleId);await assertLocalUploadCoverage(db,snapshot,target);
});
it('delivery takes its currency from the original order even after the current local profile changes',async()=>{
 const value=await boot(),{db,journal,snapshot}=value;await db.saveOrder(input());await db.saveSetup({businessType:'corner_shop',marketCode:'BD',name:'Order queue',phone:'01712345482',currency:'USD'});await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,target,new MemoryCloudUpload());
 const original=await db.outbox.toArray(),before=backupToken(await db.readBackup()),seen:{type:string;currency:string|undefined}[]=[];
 await expect(deliverLocalOutbox(db,target,async(command,currency)=>{seen.push({type:command.type,currency});throw Error('Stop before network');})).rejects.toThrow('Stop before network');
 expect(seen).toEqual([{type:'order.create',currency:'BDT'}]);expect((await db.setup())!.outlet.currency).toBe('USD');expect(await db.outbox.toArray()).toEqual(original);expect(backupToken(await db.readBackup())).toBe(before);
});
it('a missing original currency stays retained instead of borrowing the current device currency',async()=>{
 const value=await boot(),{db,journal,snapshot}=value;await db.saveOrder(input());await uploadWithLocalOutbox(db,journal,snapshot.manifest.id,target,new MemoryCloudUpload());const [row]=await db.outbox.toArray(),changes=structuredClone(row.changes),image=changes.find(change=>change.table==='orders')!.after as Record<string,unknown>;delete image.currency;await db.outbox.update(row.id,{changes});const original=await db.outbox.toArray(),send=vi.fn();
 await expect(deliverLocalOutbox(db,target,send)).rejects.toMatchObject({kind:'review'});expect(send).not.toHaveBeenCalled();expect(await db.outbox.toArray()).toEqual(original);
});
for(const family of ['compound','payment','payment-undo','cancel','status-undo','refund','refund-undo','note','warning'] as const)it(`a queue failure rolls the complete ${family} order transaction back`,async()=>{
 const value=await boot('corner_shop',async(db,customer,account)=>{let order=await db.saveOrder(creditInput(customer),family==='payment'?{}:{settlement:{method:'credit',accountId:account.id}});if(['status-undo','refund','refund-undo'].includes(family)){await db.recordCreditPayment(account.id,1000,'cash');order=await db.changeOrderStatus(order.id,'cancelled',order.revision);}if(family==='refund-undo')await db.refundOrder(order.id,{amount:500,method:'cash'},order.revision);}),{db,customer}=value,order=(await db.orders.toArray())[0],refund=(await db.orderRefunds.toArray())[0],before=backupToken(await db.readBackup());
 db.use({stack:'dbcore',name:'order-queue-failure',level:-2,create:down=>({...down,table(name){const table=down.table(name);return name==='outbox'?{...table,mutate:()=>Dexie.Promise.reject(new DOMException('Quota','QuotaExceededError'))}:table;}})});db.close();await db.open();
 const action=()=>family==='compound'?db.saveOrder(creditInput(customer),{settlement:{method:'credit'}}):family==='payment'?db.settleOrder(order.id,{method:'credit'},order.revision):family==='payment-undo'?db.undoOrderPayment(order.id,order.revision):family==='cancel'?db.changeOrderStatus(order.id,'cancelled',order.revision):family==='status-undo'?db.undoOrderStatus(order.id,order.revision):family==='refund'?db.refundOrder(order.id,{amount:500,method:'cash'},order.revision):family==='refund-undo'?db.undoOrderRefund(refund.id,order.revision):family==='note'?db.addOrderNote(order.id,literal,order.revision):db.saveOrderWarning(45);
 await expect(action()).rejects.toThrow();expect(backupToken(await db.readBackup())).toBe(before);expect(await db.outbox.count()).toBe(0);expect((await db.cloudState.get('binding'))!.sequence).toBe(0);await assertLocalUploadCoverage(db,value.snapshot,target);
});
