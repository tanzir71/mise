import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  readPaymentReviewFrame,
  readPaymentMoneyChoices,
} from '../apps/web/src/data/payment-review';
import { newInboxId } from '../packages/core/inbox';
import {
  openSavedPaymentSource,
  recordSavedPayment,
} from '../apps/web/src/data/payment-capture';
const databases: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function fixture() {
  const db = new MiseDatabase('review-' + newInboxId());
  databases.push(db);
  const setup = await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Review shop',
      phone: '01712345482',
    }),
    item = await db.captureInbox({ text: 'Unknown transfer Tk 15.25.' });
  return { db, setup, item };
}
it('retains the current native scope and changes its mount identity when the original source changes', async () => {
  const f = await fixture(),
    a = await readPaymentReviewFrame(f.db, f.setup, f.item.id),
    count = await f.db.events.count();
  expect(a.blocked).toBe(false);
  expect(a.destination).toMatchObject({
    actorId: f.setup.owner.id,
    outletId: f.setup.outlet.id,
  });
  expect((await readPaymentReviewFrame(f.db, f.setup, f.item.id)).key).toBe(
    a.key,
  );
  expect(await f.db.events.count()).toBe(count);
  await f.db.changeInbox(f.item.id, f.item.revision, { kind: 'payment' });
  const b = await readPaymentReviewFrame(f.db, f.setup, f.item.id);
  expect(b.key).not.toBe(a.key);
  expect(b.item.text).toBe(f.item.text);
  await expect(
    readPaymentReviewFrame(
      f.db,
      { ...f.setup, owner: { ...f.setup.owner, id: newInboxId() } },
      f.item.id,
    ),
  ).rejects.toThrow('selected outlet and operator');
});
it('offers actual unpaid equal-money orders while preserving the original observation and financial tables', async () => {
  const f = await fixture(),
    frame = await readPaymentReviewFrame(f.db, f.setup, f.item.id),
    review = await openSavedPaymentSource(f.db, f.item.id, frame.destination),
    saved = await recordSavedPayment(f.db, review, {
      checked: true,
      amount: 1525,
      currency: 'BDT',
      method: 'cash',
      methodName: 'Cash',
      reference: '',
      receivedAt: f.item.createdAt,
    });
  const input = {
      source: 'phone' as const,
      sourceText: '',
      name: 'Customer',
      phone: '',
      type: 'pickup' as const,
      address: '',
      table: '',
      lines: [{ name: 'Item', unit: 'pc', qty: 1, unitPrice: 1525 }],
      deliveryFee: 0,
      discount: 0,
      payment: { method: 'cash' as const },
    },
    order = await f.db.saveOrder(input);
  await f.db.saveOrder({
    ...input,
    lines: [{ ...input.lines[0], unitPrice: 1526 }],
  });
  const before = JSON.stringify(await f.db.readBackup()),
    choices = await readPaymentMoneyChoices(f.db, f.setup, saved.payment);
  expect(choices.orders.map((o) => o.id)).toEqual([order.id]);
  expect(choices.accounts).toEqual([]);
  expect((await f.db.readBackup()).tables).toEqual(JSON.parse(before).tables);
});
