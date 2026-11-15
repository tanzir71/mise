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
