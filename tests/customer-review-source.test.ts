import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import Dexie from 'dexie';
import {customerSaveIntent} from '../packages/core/customer-intent';
import {defaultCreditTerms} from '../packages/core/khata';
import {parseCustomerCommand,type CustomerCommand,type CustomerCommandReceipt} from '../packages/core/customer-commands';
import {customerReviewCreatedIds,customerReviewSourceAudits,parseCustomerReviewRequest,parseCustomerReviewSource,customerReviewSourceLimit} from '../packages/core/customer-review-source';
import {customerReviewEffectsMatch} from '../packages/core/customer-review-effects';
import {marketPacks,type MarketCode} from '../packages/core/packs';
import {normalisePhone} from '../packages/core/phone';
import {prepareCustomerReviewSource} from '../apps/web/src/data/customer-review-source';
import {nativeRowHash} from '../apps/web/src/data/canonical-writes';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal} from '../apps/web/src/data/cloud-upload';
import {beginLocalUpload} from '../apps/web/src/data/local-outbox';
import {backupToken} from '../packages/core/backup';
import type {CreditAccount} from '../packages/core/models';
import {cloudUploadFixture,uploadId} from './cloud-upload-fixture';
import {at,creditFixture} from './credit-fixture';

import {id,literal,input,terms,modes,fixture,replay} from './customer-review-fixture';

const databases:Dexie[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});

it.each(modes)('extracts the real %s mutation and only its actual newly created identities',async mode=>{
 const f=fixture(mode),saved=structuredClone(f.row),packet=await prepareCustomerReviewSource(f.row,0,id(900001),id(900002)),source=parseCustomerReviewSource(packet);
 expect(parseCustomerReviewRequest(packet,false)).toEqual(packet);expect(packet.command).toEqual(f.command);expect(source.events.map(e=>e.id)).toEqual(f.events.map(e=>e.id));expect(source.at).toBe(at+1000);expect(f.row).toEqual(saved);
 const created=customerReviewCreatedIds(source);expect(created.has(f.command.id)).toBe(true);expect(created.has(f.setup.business.id)).toBe(false);expect(created.has(f.setup.owner.id)).toBe(false);
 if('ids'in f.command){
  const a=source.events.find(e=>e.kind==='account');
  expect(created.has(f.command.ids.accountId)).toBe(a?.before===null);
  expect(created.has(f.command.ids.accountEventId)).toBe(f.command.type!=='khata.settings'&&a!==undefined);
  expect(created.has(f.command.ids.openingEntryId)).toBe(mode.endsWith('opening'));
  expect(created.has(f.command.ids.openingEventId)).toBe(mode.endsWith('opening'));
 }
 expect(created.has(f.command.customerId)).toBe(mode.startsWith('create'));
});
it.each(modes)('accepts a genuine tentative %s replay with its original effect kinds and financial identities',mode=>{
 const f=fixture(mode),before=JSON.stringify(f.packet),records=replay(f);
 expect(customerReviewEffectsMatch(f.packet,records)).toBe(true);expect(JSON.stringify(f.packet)).toBe(before);
});
it('refuses to create money during a contact-only retry, drop an implicit creation or resurrect a missing existing account',()=>{
 const contact=fixture('update-contact'),implicit=fixture('update-implicit'),existing=fixture('update-terms');
 expect(customerReviewEffectsMatch(contact.packet,replay(contact,{accounts:[]}))).toBe(false);
 const implicitAccount=parseCustomerReviewSource(implicit.packet).events.find(e=>e.kind==='account');if(!implicitAccount||implicitAccount.kind!=='account')throw Error();
 expect(customerReviewEffectsMatch(implicit.packet,replay(implicit,{accounts:[implicitAccount.after]}))).toBe(false);
 expect(customerReviewEffectsMatch(existing.packet,replay(existing,{accounts:[]}))).toBe(false);
});
it('keeps an existing BDT account after a profile currency change and refuses a new USD interpretation',()=>{
 const existing=fixture('update-terms'),opening=fixture('create-opening'),implicit=fixture('update-implicit');
 expect(customerReviewEffectsMatch(existing.packet,replay(existing,{currency:'USD'}))).toBe(true);
 expect(customerReviewEffectsMatch(opening.packet,replay(opening,{currency:'USD'}))).toBe(false);
 expect(customerReviewEffectsMatch(implicit.packet,replay(implicit,{currency:'USD'}))).toBe(false);
});
it('refuses a competing canonical account instead of retargeting the original khata creation',()=>{
 const f=fixture('khata-create'),competing={...f.account,id:id(800000)};
 const records=replay(f,{accounts:[competing]});expect(records.find(r=>r.table==='credit_accounts')?.values.id).toBe(competing.id);
 expect(customerReviewEffectsMatch(f.packet,records)).toBe(false);
});
it('keeps the original literal phone after a market change even when another valid national interpretation exists',()=>{
 const f=fixture('create-default',{...input,phone:'01712345484'}),original=f.command;if(!('credit'in original))throw Error();
 const legacy=parseCustomerCommand({...original,input:{...original.input,phone:'01712345484'}});f.command=legacy;f.packet.command=legacy;
 const other=(Object.keys(marketPacks) as MarketCode[]).find(m=>{const phone=normalisePhone('01712345484',m);return phone!==null&&phone!==original.input.phone;});expect(other).toBeDefined();
 expect(customerReviewEffectsMatch(f.packet,replay(f))).toBe(true);
 const changed=replay(f,{market:other});expect(changed.find(r=>r.table==='customers')?.values.phone).not.toBe(original.input.phone);expect(customerReviewEffectsMatch(f.packet,changed)).toBe(false);
 const canonical=fixture('create-default',{...input,phone:original.input.phone});expect(customerReviewEffectsMatch(canonical.packet,replay(canonical,{market:other}))).toBe(true);
});
it.each(['business','member','profile row','account row','opening row','duplicate','unrelated','extra field','old primary'])('rejects a %s substitution in otherwise genuine tentative rows',kind=>{
 const f=fixture('create-opening'),records=structuredClone(replay(f));expect(customerReviewEffectsMatch(f.packet,records)).toBe(true);
 if(kind==='business')records[0].values.business_id=id(800000);else if(kind==='member'){expect(customerReviewEffectsMatch(f.packet,replay(f,{actorId:id(800000)}))).toBe(false);return;}
 else if(kind==='profile row')records.find(r=>r.table==='customers')!.values.name=JSON.stringify('Different customer');else if(kind==='account row')records.find(r=>r.table==='credit_accounts')!.values.id=id(800000);else if(kind==='opening row')records.find(r=>r.table==='credit_entries')!.values.amount=999;else if(kind==='duplicate')records.push(records[0]);else if(kind==='unrelated')records.push({table:'stock_items',values:{business_id:f.setup.business.id,id:id(800000)}});else if(kind==='extra field')records[0].values.authority='owner';else records.find(r=>r.table==='events')!.values.id=f.command.id;
 expect(customerReviewEffectsMatch(f.packet,records)).toBe(false);
});
it('distinguishes a contact-only update from an implicit default-account creation with identical credit/opening options',()=>{
 const contact=fixture('update-contact'),implicit=fixture('update-implicit');
 expect(contact.command).toMatchObject({type:'customer.update',credit:null,opening:null});expect(implicit.command).toMatchObject({type:'customer.update',credit:null,opening:null});
 expect(parseCustomerReviewSource(contact.packet).events.map(e=>e.kind)).toEqual(['customer']);
 expect(parseCustomerReviewSource(implicit.packet).events[1]).toMatchObject({kind:'account',before:null,command:'khata.create',after:defaultCreditTerms});
 const bad=JSON.parse(implicit.packet.sourceJson);bad.events.pop();
 // A capsule cannot prove the absence of a missing optional creation by itself;
 // the independent complete native hash and later native comparison bind it.
 expect(parseCustomerReviewSource({...implicit.packet,sourceJson:JSON.stringify(bad)}).events).toHaveLength(1);
});
it('rejects a missing implicit creation audit against the complete original native row',async()=>{
 const f=fixture('update-implicit');if(!('ids'in f.command))throw Error();const eventId=f.command.ids.accountEventId;
 f.row.changes=f.row.changes.filter(change=>change.key!==eventId);
 await expect(prepareCustomerReviewSource(f.row,0,id(900001),id(900002))).rejects.toThrow(/implicit khata creation/);
});
it.each(['missing account','duplicate account','changed unit','wrong customer','missing opening','changed amount','hidden link'])('rejects a %s row behind otherwise unchanged original audits',async kind=>{
 const {row}=fixture('create-opening'),account=row.changes.find(c=>c.table==='creditAccounts')!,entry=row.changes.find(c=>c.table==='creditEntries')!;
 if(kind==='missing account')row.changes=row.changes.filter(c=>c!==account);else if(kind==='duplicate account')row.changes.push(account);else if(kind==='changed unit')account.after={...(account.after as CreditAccount),currency:'USD'};else if(kind==='wrong customer')account.after={...(account.after as CreditAccount),customerId:id(800000)};else if(kind==='missing opening')row.changes=row.changes.filter(c=>c!==entry);else if(kind==='changed amount')entry.after={...(entry.after as object),amount:1};else entry.after={...(entry.after as object),saleId:id(800000)};
 await expect(prepareCustomerReviewSource(row,0,id(900001),id(900002))).rejects.toThrow();
});
it('records the opening balance date separately from when its entry and audits were saved',()=>{
 const {packet}=fixture('create-opening'),source=parseCustomerReviewSource(packet),opening=source.events[2];
 expect(opening).toMatchObject({kind:'opening',at:at+1000,before:null,after:{type:'adjustment',amount:12345,sequence:1,note:'Opening balance',occurredAt:at-86400000,createdAt:at+1000,updatedAt:at+1000}});
});
const corruptions:[string,(string|number)[],unknown][]=[
 ['profile input',['events',0,'after','name'],'Another name'],
 ['literal note',['events',0,'after','notes'],'Another note'],
 ['original phone',['events',0,'after','phone'],'+8801712345482'],
 ['tags',['events',0,'after','tags'],['regular',literal,'new']],
 ['consent',['events',0,'after','consent','savedAt'],at+1001],
 ['customer identity',['events',0,'after','id'],id(800000)],
 ['business identity',['events',0,'after','businessId'],id(800000)],
 ['customer birth',['events',0,'after','createdAt'],at+1001],
 ['customer update clock',['events',0,'after','updatedAt'],at+1001],
 ['outlet',['events',1,'outletId'],id(800000)],
 ['account identity',['events',1,'after','id'],id(800000)],
 ['financial parent',['events',2,'after','accountId'],id(800000)],
 ['account currency',['events',1,'after','currency'],'USD'],
 ['credit limit',['events',1,'after','limit'],40000],
 ['credit permission',['events',1,'after','allowed'],true],
 ['reminder',['events',1,'after','reminder','dayOfMonth'],31],
 ['opening amount',['events',2,'after','amount'],12346],
 ['opening date',['events',2,'after','occurredAt'],at-86400000+1],
 ['opening recording date',['events',2,'after','createdAt'],at-86400000],
 ['opening sequence',['events',2,'after','sequence'],2],
 ['opening kind',['events',2,'after','type'],'charge'],
 ['opening audit',['events',2,'after','eventId'],id(800000)],
 ['foreign linked sale',['events',2,'after','saleId'],id(800000)],
 ['member',['events',1,'actorId'],id(800000)],
 ['recording time',['events',1,'at'],at+1001],
 ['selected time',['at'],at+1001],
 ['authority field',['events',1,'role'],'owner'],
];
it.each(corruptions)('rejects changed %s facts instead of substituting a financial action',(_name,path,value)=>{
 const {packet}=fixture('create-opening'),source=JSON.parse(packet.sourceJson);let target:unknown=source;
 for(const key of path.slice(0,-1))target=(target as Record<string|number,unknown>)[key];
 (target as Record<string|number,unknown>)[path.at(-1)!]=value;
 expect(()=>parseCustomerReviewRequest({...packet,sourceJson:JSON.stringify(source)},false)).toThrow();
});
it.each(['order','missing account','missing opening','duplicate'])('rejects an %s change to the original audit set',kind=>{
 const {packet}=fixture('create-opening'),source=JSON.parse(packet.sourceJson);
 if(kind==='order')source.events.reverse();else if(kind==='missing account')source.events.splice(1,1);else if(kind==='missing opening')source.events.pop();else source.events.push(source.events[1]);
 expect(()=>parseCustomerReviewRequest({...packet,sourceJson:JSON.stringify(source)},false)).toThrow();
});
it('does not strip a concealed sale, order, refund or reversal from an original opening audit',()=>{
 const f=fixture('create-opening');
 for(const key of ['saleId','orderId','refundId','reversalOf','methodName','overLimit']){
  const events=structuredClone(f.events);Object.assign(events[2].after as object,{[key]:id(800000)});
  expect(()=>customerReviewSourceAudits(f.command,events,f.setup.business.id)).toThrow();
 }
 const events=structuredClone(f.events);events[0].undoOf=id(800000);expect(()=>customerReviewSourceAudits(f.command,events,f.setup.business.id)).toThrow();
});
it('preserves raw code units and verifies real native tag and phone normalization without a current market',()=>{
 const {context}=creditFixture(),raw={...input,phone:'০১৭১২৩৪৫৪৮৪'},result=customerSaveIntent(raw,{},{setup:context.setup,customers:[],accounts:[]},at+1000),c=result.command;
 expect(c.input.phone).toBe('+8801712345484');expect(c.input.name).toBe(literal);expect(c.input.notes).toBe(literal);
 const original=parseCustomerCommand({...c,input:raw});
 const facts=customerReviewSourceAudits(original,result.mutation.events,context.setup.business.id);
 expect(facts[0].after).toMatchObject({name:literal,notes:literal,phone:'+8801712345484',tags:['regular',literal]});
 expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
 expect(()=>customerReviewSourceAudits(parseCustomerCommand({...c,input:{...raw,phone:'invalid'}}),result.mutation.events,context.setup.business.id)).toThrow();
});
it('keeps an existing account unit and permitted future legacy entity clocks independently of admission',()=>{
 const {context}=creditFixture(),customer={...context.customer,createdAt:at+10000},account={...context.account,createdAt:at+20000},setup={...context.setup,outlet:{...context.setup.outlet,currency:'USD'}};
 const r=customerSaveIntent(input,{id:customer.id,credit:terms},{setup,customers:[customer],accounts:[account]},at+1000);
 // The original mutation selects by current unit; replay against its original
 // unit, as the ordinary customer replay does, to retain an existing BDT parent.
 const bdt=customerSaveIntent(input,{id:customer.id,credit:terms},{setup:{...setup,outlet:{...setup.outlet,currency:'BDT'}},customers:[customer],accounts:[account]},at+1000);
 const facts=customerReviewSourceAudits(bdt.command,bdt.mutation.events,setup.business.id);
 expect(facts[0].after).toMatchObject({createdAt:at+10000,updatedAt:at+10000});expect(facts[1].after).toMatchObject({id:account.id,currency:'BDT',createdAt:at+20000,updatedAt:at+20000});expect(facts[1].at).toBe(at+1000);
 expect(r.mutation.account?.currency).toBe('USD');
 const bad=structuredClone(bdt.mutation.events);(bad[1].after as {currency:string}).currency='USD';expect(()=>customerReviewSourceAudits(bdt.command,bad,setup.business.id)).toThrow();
});
it('preserves an older imported profile through archive without applying current edit-field limits',()=>{
 const f=fixture('archive'),events=structuredClone(f.events),long='Old note\0\ud800'.repeat(1500);
 Object.assign(events[0].before as object,{name:'x'.repeat(120),notes:long,tags:Array.from({length:30},(_,n)=>'Imported '+n)});
 Object.assign(events[0].after as object,{name:'x'.repeat(120),notes:long,tags:Array.from({length:30},(_,n)=>'Imported '+n)});
 expect(customerReviewSourceAudits(f.command,events,f.setup.business.id)[0].after).toMatchObject({name:'x'.repeat(120),notes:long});
});
it('rejects existing-account rewrites concealed as a contact-only edit and extra unused companion audits',()=>{
 const f=fixture('update-terms');if(!('credit'in f.command))throw Error();
 const c={...f.command,credit:null};expect(()=>customerReviewSourceAudits(c,f.events,f.setup.business.id)).toThrow();
 const settings=fixture('khata-settings'),extra=structuredClone(settings.events[0]);if(!('ids'in settings.command))throw Error();extra.id=settings.command.ids.accountEventId;
 expect(()=>customerReviewSourceAudits(settings.command,[...settings.events,extra],settings.setup.business.id)).toThrow();
});
it('checks exact compact encoding, source limits, distinct identities and a current decision token',()=>{
 const {packet,setup}=fixture('create-default');
 expect(()=>parseCustomerReviewRequest({...packet,sourceJson:' '+packet.sourceJson},false)).toThrow();
 expect(()=>parseCustomerReviewRequest({...packet,sourceJson:packet.sourceJson.replace('"v":1','"v":1,"v":1')},false)).toThrow();
 expect(()=>parseCustomerReviewRequest({...packet,sourceJson:'x'.repeat(customerReviewSourceLimit+1)},false)).toThrow();
 for(const reserved of [setup.business.id,setup.owner.id,packet.command.id,packet.command.customerId,packet.command.outletId,id(900000)])expect(()=>parseCustomerReviewRequest({...packet,replacementId:reserved},false)).toThrow();
 expect(()=>parseCustomerReviewRequest({...packet,token:'stale',outcome:'replaced'},true)).toThrow();
 expect(parseCustomerReviewRequest({...packet,token:'t'.repeat(43),outcome:'withdrawn'},true)).toMatchObject({outcome:'withdrawn'});
 expect(()=>parseCustomerReviewRequest({...packet,access_token:'not part of the protocol'},false)).toThrow();
});
it('binds complete original row and Blob bytes without including them in the selective wire capsule',async()=>{
 const f=fixture('update-contact'),first=await prepareCustomerReviewSource(f.row,0,id(900001),id(900002));
 const changed=structuredClone(f.row);changed.changes.push({table:'inboxItems',key:id(910000),before:null,after:{original:new Blob([new Uint8Array([1,2,3])],{type:'image/png'})}});
 const second=await prepareCustomerReviewSource(changed,0,id(900001),id(900002));expect(second.sourceHash).not.toBe(first.sourceHash);expect(second.sourceJson).toBe(first.sourceJson);
 changed.changes.at(-1)!.after={original:new Blob([new Uint8Array([1,2,4])],{type:'image/png'})};
 expect((await prepareCustomerReviewSource(changed,0,id(900001),id(900002))).sourceHash).not.toBe(second.sourceHash);
});
it.each(['accepted','duplicate','edited audit','missing audit','wrong scope','skip','wrong family'])('refuses a %s source selection',async kind=>{
 const {row}=fixture('create-default');
 if(kind==='accepted')row.status='accepted';else if(kind==='duplicate')row.changes.push(row.changes.find(c=>c.table==='events')!);else if(kind==='edited audit')row.changes.find(c=>c.table==='events')!.before={};else if(kind==='missing audit')row.changes=row.changes.filter(c=>c.table!=='events');else if(kind==='wrong scope')row.outletId=id(800000);else if(kind==='wrong family')row.commands[0]={id:id(800001),type:'sale.record',outletId:row.outletId,saleId:id(800002),occurredAt:at,input:{expression:'10',method:'cash',wallet:null,given:null,who:'',items:[]}};
 await expect(prepareCustomerReviewSource(row,kind==='skip'?1:0,id(900001),id(900002))).rejects.toThrow();
});

async function native(){
 const db=new MiseDatabase('mise-customer-review-source-'+randomUUID()),journal=new CloudUploadJournal('mise-customer-review-source-upload-'+randomUUID());databases.push(db,journal);
 const backup=cloudUploadFixture();await db.restoreBackup(backup,await db.previewRestore(backup));await beginLocalUpload(db,await journal.prepare(db,uploadId()),'a'.repeat(64));return db;
}
function receipt(command:CustomerCommand,events:ReturnType<typeof parseCustomerReviewSource>['events']):CustomerCommandReceipt{
 const status=command.type==='customer.archive'||command.type==='customer.restore',a=events.find(e=>e.kind==='account'),opening=events.find(e=>e.kind==='opening'),customer=events.find(e=>e.kind==='customer');
 return {id:command.id,type:command.type,customerId:command.customerId,outletId:command.outletId,accountId:status?null:'ids'in command?command.ids.accountId:null,accountEventId:a?.id??null,entryId:opening?.after.id??null,openingEventId:opening?.id??null,at:events[0].at+1,customerUpdatedAt:customer?.after.updatedAt??events[0].at,accountUpdatedAt:status?null:a?.after.updatedAt??events[0].at};
}
it('extracts actual native saves, terms, archive, restore and opening balance without changing the database',async()=>{
 const db=await native();let customer=await db.saveCustomer(input);customer=await db.saveCustomer({...input,name:'Updated native customer'},{id:customer.id});customer=await db.saveCustomer({...input,name:customer.name},{id:customer.id,credit:terms});await db.saveCreditTerms(customer.id,{...terms,limit:47000});await db.archiveCustomer(customer.id,true);await db.archiveCustomer(customer.id,false);await db.saveCustomer({...input,name:'Original opening'},{opening:{amount:12345,occurredAt:1}});
 const queue=await db.outbox.orderBy('[uploadId+sequence]').toArray(),saved=await nativeRowHash(queue),backup=backupToken(await db.readBackup()),types:string[]=[];
 for(const [i,entry] of queue.entries()){const p=await prepareCustomerReviewSource(entry,0,id(900010+i*2),id(900011+i*2));types.push(p.command.type);expect(parseCustomerReviewSource(p).businessId).toBe(entry.businessId);}
 expect(types).toEqual(['customer.create','customer.update','customer.update','khata.settings','customer.archive','customer.restore','customer.create']);expect(await nativeRowHash(await db.outbox.orderBy('[uploadId+sequence]').toArray())).toBe(saved);expect(backupToken(await db.readBackup())).toBe(backup);
});
it('selects each immediate audit and recording clock from one real grouped transaction after its receipt prefix',async()=>{
 const db=await native();let clock=at+1000;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 await db.transaction('rw',db.tables,async()=>{const customer=await db.saveCustomer(input);clock+=1000;await db.saveCreditTerms(customer.id,terms);clock+=1000;await db.saveCustomer({...input,name:'Final grouped name'},{id:customer.id});});
 const queue=await db.outbox.toArray();expect(queue).toHaveLength(1);const saved=await nativeRowHash(queue),row=structuredClone(queue[0]);expect(row.commands.map(c=>c.type)).toEqual(['customer.create','khata.settings','customer.update']);
 expect(row.changes.find(c=>c.table==='customers')?.after).toMatchObject({name:'Final grouped name'});expect(row.changes.find(c=>c.table==='creditAccounts')?.after).toMatchObject({limit:45000});
 const hashes:string[]=[];
 for(let i=0;i<3;i++){
  const p=await prepareCustomerReviewSource(row,i,id(900010+i*2),id(900011+i*2)),source=parseCustomerReviewSource(p);hashes.push(p.sourceHash);
  expect(source.at).toBe(at+1000+i*1000);if(i===0)expect(source.events[1].after).toMatchObject({limit:0});if(i===1)expect(source.events[0]).toMatchObject({before:{limit:0},after:{limit:45000}});if(i===2)expect(source.events).toHaveLength(1);
  row.receipts.push(receipt(p.command,source.events));
 }
 expect(new Set(hashes).size).toBe(1);expect(await nativeRowHash(await db.outbox.toArray())).toBe(saved);
 const invalid=structuredClone(queue[0]);invalid.receipts=[{...row.receipts[0],id:id(800000)}];await expect(prepareCustomerReviewSource(invalid,1,id(900001),id(900002))).rejects.toThrow();
});
