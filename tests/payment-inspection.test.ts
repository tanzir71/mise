import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  savedPaymentReceipt,
  compareSavedPayment,
  associateSavedPayment,
  unmatchSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { newInboxId } from '../packages/core/inbox';
import { defaultCreditTerms } from '../packages/core/khata';
import {
  PaymentEvidenceReader,
  paymentEvidenceCommand,
} from '../packages/core/payment-evidence';
import { literalToken } from '../packages/core/literal-token';
import type { Payment } from '../packages/core/models';

const databases: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
const customerInput = {
  name: 'Original customer',
  nickname: 'Apa',
  phone: '',
  address: '',
  notes: '',
  tags: [],
};
const orderInput = {
  source: 'phone' as const,
  sourceText: 'Original request',
  name: 'Original order customer',
  phone: '',
  type: 'pickup' as const,
  address: '',
  table: '',
  lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 1525 }],
  deliveryFee: 0,
  discount: 0,
  payment: { method: 'cash' as const },
};
async function fixture() {
  const db = new MiseDatabase('payment-inspection-' + newInboxId());
  databases.push(db);
  const setup = await db.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Original shop',
    outletName: 'Original outlet',
    phone: '01712345482',
  });
  const destination = {
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
  };
  const item = await db.captureInbox({
    text: 'Unknown incoming transfer Tk 15.25.',
  });
  const review = await openSavedPaymentSource(db, item.id, destination);
  const saved = await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: '',
    receivedAt: item.createdAt,
  });
  return { db, setup, destination, item, review, saved };
}
async function customer(f: Awaited<ReturnType<typeof fixture>>) {
  const person = await f.db.saveCustomer(customerInput, {
    credit: { ...defaultCreditTerms, allowed: true, limit: 100000 },
    opening: { amount: 10000, occurredAt: Date.now() },
  });
  const account = (
    await f.db.creditAccounts.where('customerId').equals(person.id).toArray()
  )[0];
  return { person, account };
}
async function link(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'order' | 'sale' | 'credit',
) {
  const comparison = await compareSavedPayment(f.db, f.review, {
    receivedTimeConfirmed: true,
  });
  const candidate = comparison.result.candidates.find((c) => c.kind === kind)!;
  return associateSavedPayment(f.db, f.review, comparison, candidate);
}
it('adds no invented target and performs no writes when inspecting an unlinked observation', async () => {
  const f = await fixture(),
    before = await f.db.readBackup();
  expect(f.saved.inspection).toEqual({ associations: [], postings: [] });
  expect((await savedPaymentReceipt(f.db, f.review))!.inspection).toEqual(
    f.saved.inspection,
  );
  expect((await f.db.readBackup()).tables).toEqual(before.tables);
});
it('keeps the originally linked order number and customer after editing and removing the link', async () => {
  const f = await fixture(),
    order = await f.db.saveOrder(orderInput),
    saved = await link(f, 'order');
  const target = {
    kind: 'order',
    id: order.id,
    number: order.number,
    customerName: order.customer.name,
  };
  expect(saved.inspection.associations[0].target).toEqual(target);
  await f.db.saveOrder(
    { ...orderInput, name: 'Later order customer' },
    { id: order.id, revision: order.revision },
  );
  const reopened = (await savedPaymentReceipt(f.db, f.review))!;
  expect(reopened.associationCurrent).toBe(false);
  expect(reopened.inspection.associations[0].target).toEqual(target);
  const removed = await unmatchSavedPayment(f.db, f.review, {
    id: newInboxId(),
    revision: reopened.payment.revision,
  });
  expect(removed.payment.association).toBeUndefined();
  expect(removed.inspection.associations).toEqual(
    saved.inspection.associations,
  );
});
for (const mode of ['metadata', 'financial'] as const)
  it(
    'retains original customer labels and the actual customer identity for ' +
      mode +
      ' receipts after a rename',
    async () => {
      const f = await fixture(),
        { person, account } = await customer(f);
      if (mode === 'metadata')
        await f.db.recordCreditPayment(account.id, 1525, 'cash');
      const saved =
        mode === 'metadata'
          ? await link(f, 'credit')
          : await recordSavedPaymentMoney(
              f.db,
              f.review,
              await compareSavedPaymentMoney(f.db, f.review, {
                kind: 'credit',
                id: account.id,
              }),
              true,
            );
      const target = {
        kind: 'credit',
        id: person.id,
        name: person.name,
        nickname: person.nickname,
        currency: 'BDT',
      };
      expect(saved.inspection.associations.at(-1)!.target).toEqual(target);
      if (mode === 'financial')
        expect(saved.inspection.postings[0].target).toEqual(target);
      await f.db.saveCustomer(
        {
          ...customerInput,
          name: 'Renamed customer',
          nickname: 'Later nickname',
        },
        { id: person.id },
      );
      const reopened = (await savedPaymentReceipt(f.db, f.review))!;
      expect(reopened.inspection).toEqual(saved.inspection);
      if (mode === 'financial') {
        const undone = await undoSavedPaymentMoney(
          f.db,
          f.review,
          await compareSavedPaymentMoneyUndo(f.db, f.review),
          true,
        );
        expect(undone.inspection.postings).toEqual(saved.inspection.postings);
      }
    },
  );
for (const mode of ['metadata', 'financial'] as const)
  it(
    'shows the literal original counter customer and shop for ' +
      mode +
      ' receipts',
    async () => {
      const f = await fixture(),
        who = '<img src=x onerror=alert(1)> Original customer';
      if (mode === 'metadata')
        await f.db.recordSale({ expression: '15.25', method: 'cash', who });
      const saved =
        mode === 'metadata'
          ? await link(f, 'sale')
          : await recordSavedPaymentMoney(
              f.db,
              f.review,
              await compareSavedPaymentMoney(f.db, f.review, {
                kind: 'counter',
                who,
              }),
              true,
            );
      expect(saved.inspection.associations.at(-1)!.target).toEqual({
        kind: 'counter',
        who,
        shopName: 'Original shop',
      });
      if (mode === 'financial')
        expect(saved.inspection.postings[0].target).toEqual({
          kind: 'counter',
          who,
          shopName: 'Original shop',
          outletName: 'Original outlet',
        });
    },
  );
it('retains the original order labels after actual financial recording and undo', async () => {
  const f = await fixture(),
    order = await f.db.saveOrder(orderInput);
  const saved = await recordSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoney(f.db, f.review, {
      kind: 'order',
      id: order.id,
    }),
    true,
  );
  const undone = await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  await f.db.saveOrder(
    { ...orderInput, name: 'Later customer' },
    { id: order.id, revision: (await f.db.orders.get(order.id))!.revision },
  );
  expect(
    (await savedPaymentReceipt(f.db, f.review))!.inspection.postings,
  ).toEqual(saved.inspection.postings);
  expect(undone.inspection.postings[0].target).toEqual({
    kind: 'order',
    id: order.id,
    number: order.number,
    customerName: order.customer.name,
  });
});
for (const legacy of [false, true])
  it(
    'reopens complete original labels after a fresh ' +
      (legacy ? 'schema-12' : 'schema-13') +
      ' backup restore',
    async () => {
      const f = await fixture(),
        { account } = await customer(f);
      const saved = await recordSavedPaymentMoney(
        f.db,
        f.review,
        await compareSavedPaymentMoney(f.db, f.review, {
          kind: 'credit',
          id: account.id,
        }),
        true,
      );
      const current = await f.db.readBackup();
    const backup: Omit<typeof current, 'schemaVersion'> & { schemaVersion: number } = current;
      if (legacy) {
        const reader = new PaymentEvidenceReader(
          backup.tables.events,
          backup.tables.creditEntries,
        );
        const inflate = (value: Payment) => {
          const p = structuredClone(value);
          if (p.association)
            p.association.fingerprint = literalToken(
              reader.expand(p.association.fingerprint),
            );
          for (const post of p.postings ?? []) {
            post.target.fingerprint = literalToken(
              reader.expand(post.target.fingerprint),
            );
            post.receipt.fingerprint = literalToken(
              reader.expand(post.receipt.fingerprint),
            );
          }
          return p;
        };
        backup.schemaVersion = 12;
        backup.tables.payments = backup.tables.payments.map(inflate);
        backup.tables.events = backup.tables.events
          .filter((e) => e.command !== paymentEvidenceCommand && e.command !== 'source.payment-invocation')
          .map((e) =>
            e.paymentId
              ? {
                  ...e,
                  before: e.before ? inflate(e.before as Payment) : null,
                  after: inflate(e.after as Payment),
                }
              : e,
          );
      }
      const restored = new MiseDatabase(
        'payment-inspection-restore-' + newInboxId(),
      );
      databases.push(restored);
      await restored.restoreBackup(
        JSON.stringify(backup),
        await restored.previewRestore(backup),
      );
      const review = await openSavedPaymentSource(
        restored,
        f.item.id,
        f.destination,
      );
      expect((await savedPaymentReceipt(restored, review))!.inspection).toEqual(
        saved.inspection,
      );
    },
  );
it('rejects altered shared evidence instead of showing a forged original label', async () => {
  const f = await fixture(),
    { account } = await customer(f);
  await recordSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoney(f.db, f.review, {
      kind: 'credit',
      id: account.id,
    }),
    true,
  );
  const node = (await f.db.events.toArray()).find(
    (e) =>
      e.command === paymentEvidenceCommand &&
      (e.after as { value?: { nickname?: string } }).value?.nickname === 'Apa',
  )!;
  (node.after as { value: { name: string } }).value.name = 'Forged label';
  await f.db.events.put(node);
  await expect(savedPaymentReceipt(f.db, f.review)).rejects.toThrow(
    'complete original payment evidence',
  );
});
