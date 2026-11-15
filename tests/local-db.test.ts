import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MiseDatabase } from '../apps/web/src/data/db';

const databases: MiseDatabase[] = [];
const open = () => { const db = new MiseDatabase(`mise-test-${randomUUID()}`); databases.push(db); return db; };
const input = { businessType: 'corner_shop', marketCode: 'BD', name: 'Test shop', phone: '01712345482' } as const;
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });
test('profile and samples survive reopening; later saves do not duplicate them', async () => {
  const db = open();
  await db.saveSetup(input);
  db.close(); await db.open();
  expect((await db.setup())?.business.name).toBe('Test shop');
  await db.saveSetup({ ...input, name: 'Updated shop' });
  expect(await db.businesses.count()).toBe(1);
  expect(await db.items.count()).toBe(3);
  expect(await db.events.count()).toBe(2);
  expect((await db.setup())?.business.name).toBe('Updated shop');
});
test('an audit-write failure rolls back the entire setup', async () => {
  const db = open();
  db.events.hook('creating', () => { throw new Error('Audit storage failed'); });
  await expect(db.saveSetup(input)).rejects.toThrow('Audit storage failed');
  expect(await db.setup()).toBeNull();
  expect(await db.items.count()).toBe(0);
  expect(await db.outlets.count()).toBe(0);
});
test('concurrent first-run saves create one shop and one sample catalogue', async () => {
  const db = open();
  await Promise.all([db.saveSetup(input), db.saveSetup(input)]);
  expect(await db.businesses.count()).toBe(1);
  expect(await db.items.count()).toBe(3);
  expect(await db.events.count()).toBe(2);
});
test('removing a sample is audited, while real items are protected during setup', async () => {
  const db = open(); await db.saveSetup(input);
  const sample = (await db.items.toArray())[0];
  await db.removeSample(sample.id);
  expect(await db.items.count()).toBe(2);
  expect(await db.events.where('command').equals('catalogue.remove-sample').count()).toBe(1);
  const real = (await db.items.toArray())[0];
  await db.items.update(real.id, { isSample: false });
  await expect(db.removeSample(real.id)).rejects.toThrow(/Only sample/);
  expect(await db.items.get(real.id)).toBeDefined();
});
test('catalogue writes, availability and deletion are atomic and audited', async () => {
  const db = open(); await db.saveSetup(input);
  const itemInput = { name: 'Tea', nameLocal: 'চা', price: 2000, unit: 'pc', category: 'Drinks', available: true, oftenBought: true };
  const item = await db.saveItem(itemInput);
  await db.saveItem({ ...itemInput, price: 2500 }, item.id);
  await db.setItemAvailable(item.id, false);
  expect(await db.items.get(item.id)).toMatchObject({ price: 2500, available: false });
  await db.deleteItem(item.id);
  expect(await db.items.get(item.id)).toBeUndefined();
  expect(await db.events.where('command').startsWith('catalogue.').count()).toBe(4);
  const count = await db.items.count(), categories = await db.categories.count();
  await expect(db.addItems([itemInput, { ...itemInput, name: 'Bad', price: -1 }])).rejects.toThrow(/price/);
  expect(await db.items.count()).toBe(count); expect(await db.categories.count()).toBe(categories);
});
