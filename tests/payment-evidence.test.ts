import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { creditFixture } from './credit-fixture';
import type {
  CreditEntry,
  PaymentCheckedFields,
} from '../packages/core/models';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import {
  PaymentEvidenceReader,
  PaymentEvidenceWriter,
  paymentEvidenceDigest,
} from '../packages/core/payment-evidence';
const at = Date.UTC(2026, 10, 25),
  money: PaymentCheckedFields = {
    amount: 100,
    currency: 'BDT',
    method: 'wallet',
    methodName: 'bKash',
    reference: 'TESTEVIDENCE',
    receivedAt: at,
  };
function fixture() {
  const { context } = creditFixture('BD', at),
    setup = context.setup,
    customer = {
      ...context.customer,
      notes: 'Bangla বাংলা\0\ud800 ' + 'a'.repeat(1000000 - 20),
    },
    scope = { businessId: setup.business.id, outletId: setup.outlet.id },
    row: CreditEntry = {
      id: newInboxId(),
      outletId: setup.outlet.id,
      accountId: context.account.id,
      customerId: customer.id,
      currency: 'BDT',
      sequence: 1,
      type: 'charge',
      amount: 10000,
      note: 'Complete original\0\ud800',
      createdAt: at,
      updatedAt: at,
      createdBy: setup.owner.id,
      eventId: newInboxId(),
    },
    snapshot = { scope, account: context.account, customer, entries: [row] };
  return { setup, scope, row, snapshot };
}
it('hashes complete escaped code units against an independent SHA-256 implementation', () => {
  const value = { z: 'বাংলা\0\ud800', a: 1 },
    expected = '{"a":1,"z":"বাংলা\\u0000\\ud800"}';
  expect(paymentEvidenceDigest(value)).toBe(
    createHash('sha256').update(expected).digest('hex'),
  );
  expect(paymentEvidenceDigest(value)).not.toBe(
    paymentEvidenceDigest({ z: 'বাংলা\0\ufffd', a: 1 }),
  );
});
it('shares the full large original across later captures while retaining exact prefix data', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at),
    fp = writer.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
    events = writer.added,
    reader = new PaymentEvidenceReader(events, [f.row]);
  expect(fp.length).toBeLessThan(1000);
  expect(reader.expand(fp)).toEqual(f.snapshot);
  reader.assertComplete();
  const later = new PaymentEvidenceWriter(f.setup, events, at + 1);
  expect(
    later.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
  ).toBe(fp);
  expect(later.added).toEqual([]);
  expect(
    events.filter(
      (e) =>
        (e.after as { value: { notes?: string } }).value.notes ===
        f.snapshot.customer.notes,
    ),
  ).toHaveLength(1);
});
it('rejects changed evidence content even when its stable identity and declared digest are retained', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at),
    fp = writer.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
    events = structuredClone(writer.added),
    node = events.find(
      (e) => (e.after as { value: { notes?: string } }).value.notes,
    )!;
  (node.after as { value: { notes: string } }).value.notes += 'changed';
  expect(() => new PaymentEvidenceReader(events, [f.row]).expand(fp)).toThrow(
    'verified links',
  );
});
it('rejects cross-business references after the same node was already verified in its actual scope', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at),
    fp = writer.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
    reader = new PaymentEvidenceReader(writer.added, [f.row]);
  reader.expand(fp);
  const wrong = JSON.parse(fp);
  wrong.scope.businessId = newInboxId();
  expect(() => reader.expand(literalToken(wrong))).toThrow('verified links');
});
it('allows an appended ledger suffix while detecting a changed original prefix with the same balance', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at),
    fp = writer.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
    suffix = { ...f.row, id: newInboxId(), sequence: 2, amount: 500 };
  expect(
    new PaymentEvidenceReader(writer.added, [f.row, suffix]).expand(fp),
  ).toEqual(f.snapshot);
  expect(() =>
    new PaymentEvidenceReader(writer.added, [
      { ...f.row, note: 'Different original' },
      suffix,
    ]).expand(fp),
  ).toThrow('verified links');
});
it('does not accept a snapshot captured later than the action consuming it, including a cached read', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at + 10),
    fp = writer.pack(
      literalToken(f.snapshot),
      'target',
      'credit',
      f.snapshot.account.id,
      money,
    ),
    reader = new PaymentEvidenceReader(writer.added, [f.row]);
  reader.expand(fp, at + 20);
  expect(() => reader.expand(fp, at)).toThrow('verified links');
});
it('rejects orphan shared evidence rather than silently carrying unrelated snapshot data', () => {
  const f = fixture(),
    writer = new PaymentEvidenceWriter(f.setup, [], at);
  writer.pack(
    literalToken(f.snapshot),
    'target',
    'credit',
    f.snapshot.account.id,
    money,
  );
  expect(() =>
    new PaymentEvidenceReader(writer.added, [f.row]).assertComplete(),
  ).toThrow('verified links');
});
