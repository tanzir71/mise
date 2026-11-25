import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { newInboxId } from '../packages/core/inbox';
import { creditBalance } from '../packages/core/khata';
import { seedPaymentStorage } from './fixtures/payment-storage';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  savedPaymentReceipt,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
  compareSavedPayment,
  associateSavedPayment,
  unmatchSavedPayment,
} from '../apps/web/src/data/payment-capture';
const databases: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});

it('keeps a 5,000-entry ledger and maximum imported customer note exportable after three genuine native collections', async () => {
  const db = new MiseDatabase('payment-storage-' + newInboxId());
  databases.push(db);
  const { setup, account, entries, largeNote } = await seedPaymentStorage(db);
  const destination = {
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
  };
  let lastItemId = '';
  for (let i = 0; i < 3; i++) {
    const item = await db.captureInbox({
        text: `You have received Tk 1. TrxID TESTSTORAGE${i}`,
      }),
      review = await openSavedPaymentSource(db, item.id, destination, {
        sender: 'bKash',
      });
    await recordSavedPayment(db, review, {
      checked: true,
      amount: 100,
      currency: 'BDT',
      method: 'wallet',
      methodName: 'bKash',
      reference: `TESTSTORAGE${i}`,
      receivedAt: item.createdAt,
    });
    lastItemId = item.id;
    await recordSavedPaymentMoney(
      db,
      review,
      await compareSavedPaymentMoney(db, review, {
        kind: 'credit',
        id: account.id,
      }),
      true,
    );
  }
  const paymentBytes = new TextEncoder().encode(
    JSON.stringify(await db.payments.toArray()),
  ).length;
  const paymentAuditBytes = new TextEncoder().encode(
    JSON.stringify((await db.events.toArray()).filter((e) => e.paymentId)),
  ).length;
  console.log(
    JSON.stringify({
      paymentBytes,
      paymentAuditBytes,
      ledgerRows: await db.creditEntries.count(),
      originalNoteCodeUnits: largeNote.length,
    }),
  );
  const backup = await db.readBackup();
  expect(new TextEncoder().encode(JSON.stringify(backup)).length).toBeLessThan(
    50 * 1024 * 1024,
  );
  expect(backup.tables.customers[0].notes).toBe(largeNote);
  expect(
    backup.tables.creditEntries
      .slice(0, 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(entries);
  expect(creditBalance(account, backup.tables.creditEntries)).toBe(499700);
  expect(backup.tables.payments).toHaveLength(3);
  console.log(
    JSON.stringify({
      backupBytes: new TextEncoder().encode(JSON.stringify(backup)).length,
      sharedEvidence: backup.tables.events.filter(
        (e) => e.command === 'source.payment-evidence',
      ).length,
    }),
  );
  const target = new MiseDatabase('restored-payment-storage-' + newInboxId());
  databases.push(target);
  await target.restoreBackup(
    JSON.stringify(backup),
    await target.previewRestore(backup),
  );
  const review = await openSavedPaymentSource(target, lastItemId, destination, {
    sender: 'bKash',
  });
  expect((await savedPaymentReceipt(target, review))!.associationCurrent).toBe(
    true,
  );
  await undoSavedPaymentMoney(
    target,
    review,
    await compareSavedPaymentMoneyUndo(target, review),
    true,
  );
  const undone = await target.readBackup();
  expect(creditBalance(account, undone.tables.creditEntries)).toBe(499800);
  expect(undone.tables.customers[0].notes).toBe(largeNote);
  expect(
    undone.tables.creditEntries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(entries);
}, 60000);

it('shares maximum imported customer data across existing-receipt matches and retains the old match after metadata undo', async () => {
  const db = new MiseDatabase('payment-match-storage-' + newInboxId());
  databases.push(db);
  const f = await seedPaymentStorage(db),
    destination = {
      businessId: f.setup.business.id,
      outletId: f.setup.outlet.id,
      actorId: f.setup.owner.id,
    };
  let last = '';
  for (let i = 0; i < 3; i++) {
    const entry = await db.recordCreditPayment(
        f.account.id,
        100,
        'wallet',
        'bKash',
      ),
      item = await db.captureInbox({
        text: `You have received Tk 1. TrxID TESTMATCHSTORAGE${i}`,
      }),
      review = await openSavedPaymentSource(db, item.id, destination, {
        sender: 'bKash',
      });
    await recordSavedPayment(db, review, {
      checked: true,
      amount: 100,
      currency: 'BDT',
      method: 'wallet',
      methodName: 'bKash',
      reference: `TESTMATCHSTORAGE${i}`,
      receivedAt: item.createdAt,
    });
    const c = await compareSavedPayment(db, review, {
        receivedTimeConfirmed: true,
      }),
      candidate = c.result.candidates.find((x) => x.id === entry.id)!;
    expect(candidate).toBeDefined();
    await associateSavedPayment(db, review, c, candidate);
    last = item.id;
  }
  const review = await openSavedPaymentSource(db, last, destination, {
      sender: 'bKash',
    }),
    saved = (await savedPaymentReceipt(db, review))!;
  await unmatchSavedPayment(db, review, {
    id: newInboxId(),
    revision: saved.payment.revision,
  });
  const backup = await db.readBackup();
  expect(backup.tables.payments.filter((p) => p.association)).toHaveLength(2);
  expect(backup.tables.payments.every((p) => !p.postings)).toBe(true);
  expect(creditBalance(f.account, backup.tables.creditEntries)).toBe(499700);
  expect(
    backup.tables.creditEntries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(f.entries);
  expect(backup.tables.customers[0].notes).toBe(f.largeNote);
  expect(new TextEncoder().encode(JSON.stringify(backup)).length).toBeLessThan(
    50 * 1024 * 1024,
  );
  expect(
    backup.tables.events.filter(
      (e) =>
        e.command === 'source.payment-evidence' &&
        (e.after as { value: { notes?: string } }).value.notes === f.largeNote,
    ),
  ).toHaveLength(1);
  const target = new MiseDatabase('restore-match-storage-' + newInboxId());
  databases.push(target);
  await target.restoreBackup(
    JSON.stringify(backup),
    await target.previewRestore(backup),
  );
  expect((await target.readBackup()).tables.payments).toEqual(
    backup.tables.payments,
  );
}, 60000);
