import { expect, test } from 'vitest';
import { parseMoney, moneyInputValue } from '../packages/core/money';
import { saveItemCommand, itemAvailabilityCommand, deleteItemCommand, orderableItems, parseCataloguePaste, searchItems } from '../packages/core/catalogue';
import type { Item } from '../packages/core/models';

test.each([
  ['75.50', 'BDT', 7550], ['৳ ৭৫.৫০', 'BDT', 7550], ['1,12,840.50', 'BDT', 11284050],
  ['Rp25.000,50', 'IDR', 2500050], ['25.50', 'IDR', 2550], ['0', 'USD', 0], ['.01', 'USD', 1],
  ['90071992547409.91', 'USD', Number.MAX_SAFE_INTEGER], ['90071992547409.92', 'USD', null],
  ['1,234.56.78', 'USD', null], ['1e3', 'USD', null], ['-3', 'BDT', null], ['', 'BDT', null], ['3.123', 'BDT', null], ['12,34', 'BDT', null],
] as const)('price %s in %s is parsed without float arithmetic', (text, currency, expected) => expect(parseMoney(text, currency)).toBe(expected));
test.each(['BDT', 'IDR', 'INR', 'KES', 'USD'])('editable %s prices round-trip exactly', currency => {
  for (const value of [0, 1, 75, 7550, 11284050, Number.MAX_SAFE_INTEGER]) expect(parseMoney(moneyInputValue(value, currency), currency)).toBe(value);
});
test('item commands scope categories, retain identity and produce full audit data', () => {
  const input = { name: ' Tea ', nameLocal: 'চা', price: 2000, unit: 'pc', category: 'Drinks', available: true, oftenBought: true };
  const context = { outletId: 'outlet', actorId: 'owner', categories: [] };
  const created = saveItemCommand(input, context, null, 1000);
  expect(created.item).toMatchObject({ name: 'Tea', price: 2000, createdAt: 1000, isSample: false, oftenBought: true });
  expect(created.event).toMatchObject({ command: 'catalogue.create', before: null, after: { item: created.item, category: created.category } });
  const updated = saveItemCommand({ ...input, category: 'drinks', price: 2500 }, { ...context, categories: [created.category!] }, created.item, 2000);
  expect(updated.category).toBeUndefined();
  expect(updated.item).toMatchObject({ id: created.item.id, categoryId: created.item.categoryId, createdAt: 1000, updatedAt: 2000 });
  expect(() => saveItemCommand(input, { ...context, outletId: 'another' }, created.item)).toThrow(/another outlet/);
  expect(() => saveItemCommand({ ...input, price: 1.5 }, context)).toThrow(/price/);
  expect(() => saveItemCommand({ ...input, name: '' }, context)).toThrow(/name/);
  const unavailable = itemAvailabilityCommand(created.item, false, 'owner');
  expect(orderableItems([unavailable.item])).toEqual([]);
  expect(unavailable.event.before).toEqual(created.item);
  expect(deleteItemCommand(created.item, 'owner')).toMatchObject({ command: 'catalogue.delete', before: created.item, after: null });
});
test('bulk paste preserves quoted names, grouping and invalid rows for review', () => {
  const rows = parseCataloguePaste('\nName, Price\n"Rice, coarse", 75\nSoap, 1,12,840.50\nMissing price\nTea, nope', 'BDT');
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({ name: 'Rice, coarse', price: 7500, error: '' });
  expect(rows[1].price).toBe(11284050);
  expect(rows[2].error).not.toBe('');
  expect(rows[3].price).toBeNull();
});
test('200-item name/local-name search stays below 50ms and excludes unavailable items from entry', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}`, name: `Product ${index}`, nameLocal: index === 125 ? 'চা' : '', unit: 'pc', available: index !== 125 } as Item));
  const start = performance.now(); const result = searchItems(items, 'product 125'); const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(50); expect(result).toHaveLength(1);
  expect(searchItems(items, 'চা')[0].id).toBe('item-125');
  expect(orderableItems(items)).toHaveLength(199);
});
