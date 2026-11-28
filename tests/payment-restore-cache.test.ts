import 'fake-indexeddb/auto';
import { afterEach, it, expect } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { newInboxId } from '../packages/core/inbox';
import { backupFile } from '../apps/web/src/data/export-files';
import {
  retainPaymentOriginal,
  readRetainedPaymentSnapshot,
} from '../apps/web/src/data/payment-original-retention';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
const databases: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
const fresh = () => {
  const db = new MiseDatabase('private-restore-review-' + newInboxId());
  databases.push(db);
  return db;
};
async function fixture() {
  const db = fresh(),
    setup = await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Original file review',
      phone: '01712345482',
    }),
    item = await db.captureInbox({ text: 'Original\0\ud800 বাংলা' }),
    review = await openSavedPaymentSource(db, item.id, {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    });
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: 'Original file',
    receivedAt: item.createdAt,
  });
  await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(db, review, {
      kind: 'counter',
      who: 'Original buyer',
    }),
    true,
  );
  const source = await db.readBackup(),
    basis = await retainPaymentOriginal(db, source),
    wire = await backupFile((await db.readPortableBackup()).portable).text();
  return { db, source, basis, wire };
}
it('a reviewed immutable file stays private after a native writer mutates its input and fails', async () => {
  const f = await fixture(),
    target = fresh(),
    review = await target.previewRestore(f.wire);
  const reject = (
    _key: unknown,
    row: { basis: { scope: { businessId: string } } },
  ) => {
    row.basis.scope.businessId = newInboxId();
    throw new DOMException('Original quota failure', 'QuotaExceededError');
  };
  target.paymentOriginalBases.hook('creating', reject);
  await expect(target.restoreBackup(f.wire, review)).rejects.toThrow(
    'Original quota failure',
  );
  expect(await target.sales.count()).toBe(0);
  expect(await target.paymentOriginalBases.count()).toBe(0);
  target.paymentOriginalBases.hook('creating').unsubscribe(reject);
  await target.restoreBackup(f.wire, review);
  expect(
    (await readRetainedPaymentSnapshot(target, f.basis.root)).tables.sales,
  ).toEqual(f.source.tables.sales);
  expect(await target.sales.toArray()).toEqual(f.source.tables.sales);
  expect(await target.nativePaymentActions.count()).toBe(0);
  expect(await target.outbox.count()).toBe(0);
});
it('cached file review still rejects changed destination data and a different selected file', async () => {
  const f = await fixture(),
    target = fresh(),
    review = await target.previewRestore(f.wire);
  await target.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Later local shop',
    phone: '01712345482',
  });
  await expect(target.restoreBackup(f.wire, review)).rejects.toThrow(
    'changed after the preview',
  );
  expect((await target.setup())!.business.name).toBe('Later local shop');
  const next = await target.previewRestore(f.wire),
    other = await fixture();
  await expect(target.restoreBackup(other.wire, next)).rejects.toThrow(
    'selected backup changed',
  );
  expect((await target.setup())!.business.name).toBe('Later local shop');
  expect(await target.sales.count()).toBe(0);
});
