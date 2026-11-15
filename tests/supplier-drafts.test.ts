import { expect, test } from 'vitest';
import { newSupplierMessageId, recordSupplierMessageCommand, sameSupplierMessage, supplierDraftLink, supplierDrafts, undoSupplierMessageCommand } from '../packages/core/supplier-drafts';
import { saveSupplierCommand } from '../packages/core/stock';
import { stockFixture, STOCK_AT as at } from './stock-fixture';

test('supplier drafts group pack-rounded needs with bilingual text and keep unassigned stock available to copy',() => {
  const context = stockFixture(), supplier = saveSupplierCommand({name:'Fresh supply',phone:'01712345482',note:''},context.setup,null,0,at).supplier;context.suppliers.push(supplier);context.items[0].supplierId = supplier.id;context.items[1].supplierId = supplier.id;
  const before = structuredClone(context), drafts = supplierDrafts(context), assigned = drafts.find(draft => draft.supplierId)!;
  expect(drafts).toHaveLength(2);expect(assigned.parts[0]).toContain('Chicken / মুরগি: 10 kg');expect(assigned.parts[0]).toContain('Oil / তেল: 15 L');expect(assigned.parts[0]).toContain('Please supply');expect(assigned.parts[0]).toContain('অনুগ্রহ');expect(assigned.stockItemIds).toHaveLength(2);
  expect(new URL(supplierDraftLink(assigned,0)!).searchParams.get('text')).toBe(assigned.parts[0]);expect(supplierDraftLink(drafts.find(draft => !draft.supplierId)!,0)).toBeUndefined();expect(context).toEqual(before);
  context.suppliers[0].archivedAt = at;expect(supplierDrafts(context)).toHaveLength(1);expect(supplierDrafts(context)[0].supplierName).toBe('No supplier assigned');
});
test('large supplier lists split into separately reviewable complete parts without truncating items',() => {
  const context = stockFixture(), item = context.items[0];context.items = Array.from({length:120},(_,i) => ({...item,id:`stock-${i}`,name:`Item ${i} ${'x'.repeat(100)}`}));
  const draft = supplierDrafts(context)[0];expect(draft.parts.length).toBeGreaterThan(1);expect(draft.parts.every(part => part.length <= 3500 && part.startsWith(context.setup.business.name))).toBe(true);expect(draft.parts.join('\n').match(/: 10 kg/g)).toHaveLength(120);
});
test('only explicit sent commands produce audited snapshots, and correction retains their text and recipients',() => {
  const context = stockFixture(), draft = supplierDrafts(context)[0], input = {id:newSupplierMessageId(at),supplierName:draft.supplierName,text:draft.parts[0],stockItemIds:draft.stockItemIds,channel:'manual' as const,part:1,parts:1};
  const {message,event} = recordSupplierMessageCommand(input,context,at);expect(event).toMatchObject({command:'supplier.sent',actor:{type:'member',id:context.setup.owner.id},after:message});expect(sameSupplierMessage(input,message)).toBe(true);expect(sameSupplierMessage({...input,text:'Different message'},message)).toBe(false);
  const correction = undoSupplierMessageCommand(message,context.setup,at+1);expect(correction.message).toMatchObject({text:message.text,voidedAt:at+1});expect(correction.event.undoOf).toBe(event.id);expect(() => undoSupplierMessageCommand(correction.message,context.setup,at+2)).toThrow(/once/);
  for (const patch of [{supplierId:'foreign'},{stockItemIds:['foreign']},{id:'bad'},{part:0},{parts:0},{text:''},{channel:'whatsapp' as const},{phone:'01712345482'}]) expect(() => recordSupplierMessageCommand({...input,...patch},context,at)).toThrow();
});
