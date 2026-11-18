import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { decodeShopPayload } from '../packages/core/public-shop-codec';
import { reviewShopLink,undoShopLinkCommand,type ShopLinkInput } from '../packages/core/shop-links';
import { backupTableNames } from '../packages/core/backup-tables';
import { defaultCreditTerms } from '../packages/core/khata';
import { stockInput } from './stock-fixture';

const at=Date.UTC(2026,10,16,6),databases:MiseDatabase[]=[],base='https://tanzir71.github.io/mise/app/';
const shop={businessType:'corner_shop',marketCode:'BD',name:'Rahman Store',phone:'01712345482'} as const;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));vi.useRealTimers();});
async function boot(setup=true){const db=new MiseDatabase(`mise-shop-link-${randomUUID()}`);databases.push(db);if(setup)await db.saveSetup(shop);else await db.open();return db;}
async function context(db:MiseDatabase){return {setup:(await db.setup())!,items:await db.items.toArray(),categories:await db.categories.toArray()};}
function input(itemIds:string[]=[]):ShopLinkInput{return {phone:'01712345484',hours:'9 am–11 pm',deliveryNote:'Call at the gate · গেটে ফোন করুন',mode:'list',itemIds};}
async function generate(db:MiseDatabase,settings=input()){return db.generateShopLink(settings,reviewShopLink(await context(db),settings.itemIds),base);}
async function packet(db:MiseDatabase){return decodeShopPayload(new URL((await db.setup())!.outlet.shopLink!).hash.slice(1));}

test('generation publishes only selected public catalogue fields and records the owner without changing private tables',async()=>{
  const db=await boot(),item=await db.saveItem({name:'চাল',nameLocal:'Rice',price:7550,unit:'kg',category:'Food',available:true,oftenBought:true});
  const customer=await db.saveCustomer({name:'Private customer',nickname:'',phone:'01712345483',address:'Private home',notes:'Private note',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}});
  await db.recordSale({expression:'25',method:'cash'});await db.saveStockItem(stockInput);
  const before=await db.readBackup(),event=await generate(db,input([item.id])),published=await packet(db),after=await db.readBackup();
  expect(published).toMatchObject({name:shop.name,phone:'+8801712345484',market:'BD',currency:'BDT',items:[{id:item.id,name:'চাল',category:'Food',price:7550,oftenBought:true}]});
  expect(published.items).toHaveLength(1);expect(published.items[0]).not.toHaveProperty('outletId');
  expect(JSON.stringify(published)).not.toContain(customer.id);expect(JSON.stringify(published)).not.toContain('Private');
  expect(event).toMatchObject({command:'shopLink.generate',actor:{type:'member',id:before.tables.members[0].id},outletId:before.tables.outlets[0].id,before:{url:null},after:{url:after.tables.outlets[0].shopLink},at});
  for(const table of backupTableNames.filter(table=>!['outlets','events'].includes(table)))expect(after.tables[table],table).toEqual(before.tables[table]);
  expect(after.tables.events.filter(record=>record.id!==event.id)).toEqual(before.tables.events);
});

test('frozen-time regeneration keeps the shop code, changes the edition and snapshots current menu values',async()=>{
  const db=await boot(),item=await db.saveItem({name:'Rice',nameLocal:'চাল',price:7500,unit:'kg',category:'Food',available:true,oftenBought:true}),settings={...input([item.id]),mode:'menu' as const};
  await generate(db,settings);const first=await packet(db),firstUrl=(await db.setup())!.outlet.shopLink!;
  await db.items.update(item.id,{price:8000,available:false});await generate(db,settings);const second=await packet(db);
  expect(second.code).toBe(first.code);expect(second.edition).not.toBe(first.edition);expect(second.publishedAt).toBe(first.publishedAt);
  expect(second.items[0]).toMatchObject({price:8000,available:false});expect(decodeShopPayload(new URL(firstUrl).hash.slice(1)).items[0].price).toBe(7500);
});

test('reviews reject changed selected items, categories, shop details and competing generation while ignoring unrelated sales',async()=>{
  const db=await boot(),item=await db.saveItem({name:'Rice',nameLocal:'',price:7500,unit:'kg',category:'Food',available:true,oftenBought:false}),settings=input([item.id]);
  const first=await context(db),review=reviewShopLink(first,settings.itemIds);
  await db.items.update(item.id,{price:8000});await expect(db.generateShopLink(settings,review,base)).rejects.toThrow(/changed/);await db.items.put(item);
  const category=first.categories.find(category=>category.id===item.categoryId)!;await db.categories.update(category.id,{name:'Renamed'});await expect(db.generateShopLink(settings,review,base)).rejects.toThrow(/changed/);await db.categories.put(category);
  await db.saveSetup({...shop,name:'Changed shop'});await expect(db.generateShopLink(settings,review,base)).rejects.toThrow(/changed/);await db.saveSetup(shop);
  await db.recordSale({expression:'10',method:'cash'});const outcomes=await Promise.allSettled([db.generateShopLink(settings,review,base),db.generateShopLink(settings,review,base)]);
  expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);expect(await db.events.where('command').equals('shopLink.generate').count()).toBe(1);
  await db.deleteItem(item.id);await expect(generate(db,settings)).rejects.toThrow(/removed/);
});

test('audit failures roll back generation and undo, including the previous link',async()=>{
  const db=await boot();let fail='shopLink.generate';db.events.hook('creating',(_key,event)=>{if(event.command===fail)throw new Error('Audit blocked');});
  const before=await db.readBackup();await expect(generate(db)).rejects.toThrow('Audit blocked');expect((await db.readBackup()).tables).toEqual(before.tables);
  fail='';const event=await generate(db),url=(await db.setup())!.outlet.shopLink;
  fail='shopLink.undo';await expect(db.undoShopLink(event.id)).rejects.toThrow('Audit blocked');expect((await db.setup())!.outlet.shopLink).toBe(url);expect(await db.events.where('command').equals('shopLink.undo').count()).toBe(0);
});

test('undo changes only the link, is scoped and time limited, and applies once under concurrent taps',async()=>{
  const db=await boot(),event=await generate(db),saved=(await db.setup())!;
  await db.saveSetup({...shop,address:'Updated while the link was open'});
  expect(()=>undoShopLinkCommand({...event,outletId:'another-outlet'},saved,at)).toThrow(/ten minutes/);
  expect(()=>undoShopLinkCommand({...event,actor:{type:'member',id:'another-owner'}},saved,at)).toThrow(/ten minutes/);
  expect(()=>undoShopLinkCommand(event,saved,at-1)).toThrow(/ten minutes/);
  vi.setSystemTime(at+600001);await expect(db.undoShopLink(event.id)).rejects.toThrow(/ten minutes/);vi.setSystemTime(at+600000);
  const outcomes=await Promise.allSettled([db.undoShopLink(event.id),db.undoShopLink(event.id)]);expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
  expect((await db.setup())!.outlet).toMatchObject({address:'Updated while the link was open'});expect((await db.setup())!.outlet.shopLink).toBeUndefined();
  expect((await db.events.where('command').equals('shopLink.undo').first())).toMatchObject({undoOf:event.id,before:event.after,after:{url:null},actor:event.actor,at:at+600000});
  await db.outlets.update(saved.outlet.id,{shopLink:saved.outlet.shopLink});await expect(db.undoShopLink(event.id)).rejects.toThrow(/already/);
});

test('older generation cannot overwrite a newer link and undo restores a legacy URL exactly',async()=>{
  const db=await boot(),setup=(await db.setup())!,legacy='https://example.com/old-shop';await db.outlets.update(setup.outlet.id,{shopLink:legacy});
  const first=await generate(db),url=(await db.setup())!.outlet.shopLink;const second=await generate(db);
  await expect(db.undoShopLink(first.id)).rejects.toThrow(/latest/);await db.undoShopLink(second.id);expect((await db.setup())!.outlet.shopLink).toBe(url);
  await db.undoShopLink(first.id);expect((await db.setup())!.outlet.shopLink).toBe(legacy);
});

test('existing schema-eight full backup restores the exact public link and audit without new tables or losing private records',async()=>{
  const source=await boot();await source.recordSale({expression:'125',method:'cash'});await generate(source);const backup=await source.readBackup();
  const target=await boot(false),review=await target.previewRestore(backup);await target.restoreBackup(backup,review);target.close();await target.open();
  expect(target.verno).toBe(12);expect(target.tables).toHaveLength(26);const restored=await target.readBackup();
  for(const table of backupTableNames.filter(table=>table!=='events'))expect(restored.tables[table],table).toEqual(backup.tables[table]);
  expect(restored.tables.events.filter(event=>event.command!=='backup.restore')).toEqual(backup.tables.events);expect(await packet(target)).toEqual(await packet(source));
});

test('invalid or oversized public inputs never replace a saved link or leave an audit record',async()=>{
  const db=await boot();await generate(db);const before=await db.readBackup(),review=reviewShopLink(await context(db),[]);
  for(const invalid of [{...input(),phone:'123'},{...input(),hours:'x'.repeat(201)},{...input(),mode:'menu' as const},{...input(),privateNote:'Must not publish'}])await expect(db.generateShopLink(invalid,review,base)).rejects.toThrow();
  await expect(db.generateShopLink(input(),review,'https://example.com/wrong/')).rejects.toThrow();expect((await db.readBackup()).tables).toEqual(before.tables);
});
