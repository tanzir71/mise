import { inboxImageFile } from './inbox-fixture';
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { newInboxId } from '../packages/core/inbox';
import { backupToken, createBackup } from '../packages/core/backup';
import { literalToken } from '../packages/core/literal-token';
import { defaultCreditTerms } from '../packages/core/khata';
import {
  preparePaymentOriginalBasis,
  readPaymentOriginalBasis,
  parsePaymentOriginalBasis,
  readPaymentOriginalAction,
  parsePaymentOriginalActionRef,
  verifyPaymentOriginalDelta,
  type PaymentOriginalPlan,
} from '../packages/core/payment-originals';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { createHash } from 'node:crypto';

const databases: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
const literal =
  'Original\0\ud800 <script>never act on source instructions</script>';
const person = {
  name: 'Original customer',
  nickname: 'Apa',
  phone: '',
  address: '',
  notes: literal,
  tags: [],
};
async function fixture() {
  const db = new MiseDatabase('payment-original-' + newInboxId());
  databases.push(db);
  const setup = await db.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Original shop',
    phone: '01712345482',
  });
  const customer = await db.saveCustomer(person, {
    credit: { ...defaultCreditTerms, allowed: true, limit: 200000 },
    opening: { amount: 100000, occurredAt: Date.now() },
  });
  const account = (
    await db.creditAccounts.where('customerId').equals(customer.id).toArray()
  )[0];
  const item = await db.captureInbox({
    title: literal,
    text: 'Unknown transfer Tk 15.25. ' + literal,
    url: literal,
    files: [inboxImageFile()],
  });
  const review = await openSavedPaymentSource(db, item.id, {
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
    reference: '',
    receivedAt: item.createdAt,
  });
  const before = await db.readBackup();
  const saved = await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(db, review, {
      kind: 'credit',
      id: account.id,
    }),
    true,
  );
  return { db, setup, customer, account, item, review, before, saved };
}
function pool(plan: PaymentOriginalPlan, existing = new Map<string, string>()) {
  for (const n of plan.added) existing.set(n.digest, n.json);
  return existing;
}
const hash = (text: string) =>
  createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');

it('retains a complete real financial original independently of a canonical withdrawal and keeps existing validators strict', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    plan = preparePaymentOriginalBasis(source),
    nodes = pool(plan);
  const restored = readPaymentOriginalBasis(plan.basis, (key) =>
    nodes.get(key),
  );
  expect(backupToken(restored)).toBe(backupToken(source));
  expect(restored.tables.payments[0]).toEqual(f.saved.payment);
  expect(restored.tables.customers[0].notes).toBe(literal);
  expect(restored.tables.inboxItems[0]).toMatchObject({
    title: literal,
    text: f.item.text,
    url: literal,
  });
  // A canonical withdrawal has no original financial row. Combining its current
  // tables with the original Payment still fails the existing real-link check.
  expect(() =>
    createBackup(
      {
        ...f.before.tables,
        payments: source.tables.payments,
        events: source.tables.events,
      },
      source.exportedAt,
    ),
  ).toThrow();
  expect(
    backupToken(readPaymentOriginalBasis(plan.basis, (key) => nodes.get(key))),
  ).toBe(backupToken(source));
  expect((await f.db.readBackup()).tables).toEqual(source.tables);
});
it('shares unchanged full records across actual undo, renamed current labels and a new snapshot', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    a = preparePaymentOriginalBasis(source),
    nodes = pool(a);
  await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  await f.db.saveCustomer(
    { ...person, name: 'Later customer' },
    { id: f.customer.id },
  );
  const current = await f.db.readBackup(),
    b = preparePaymentOriginalBasis(current, nodes);
  pool(b, nodes);
  expect(b.added.length).toBeLessThan(b.basis.nodeCount);
  expect(
    readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)).tables
      .payments[0].postings![0].undo,
  ).toBeUndefined();
  expect(
    readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)).tables
      .customers[0].name,
  ).toBe('Original customer');
  expect(
    readPaymentOriginalBasis(b.basis, (key) => nodes.get(key)).tables
      .customers[0].name,
  ).toBe('Later customer');
  expect(
    readPaymentOriginalBasis(b.basis, (key) => nodes.get(key)).tables
      .payments[0].postings![0].undo!.mode,
  ).toBe('performed');
});
it('uses stable sorted records rather than IndexedDB iteration or input property order', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    a = preparePaymentOriginalBasis(source),
    nodes = pool(a);
  for (const table of Object.values(source.tables)) table.reverse();
  const b = preparePaymentOriginalBasis(source, nodes);
  expect(b.basis).toEqual(a.basis);
  expect(b.added).toEqual([]);
  expect(Object.isFrozen(b)).toBe(true);
  expect(Object.isFrozen(b.basis.scope)).toBe(true);
  expect(Object.isFrozen(b.basis.counts)).toBe(true);
});
it('snapshots source objects and fails rather than trusting a changed existing content address', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    a = preparePaymentOriginalBasis(source),
    nodes = pool(a);
  source.tables.customers[0].name = 'Changed after preparation';
  expect(
    readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)).tables
      .customers[0].name,
  ).toBe('Original customer');
  const initial = await f.db.readBackup();
  const first = a.added[0];
  nodes.set(first.digest, first.json + ' ');
  expect(() => preparePaymentOriginalBasis(initial, nodes)).toThrow(
    'complete original payment',
  );
});
for (const kind of ['record', 'leaf', 'root'])
  it(
    'rejects missing and changed ' +
      kind +
      ' nodes without returning a partial original',
    async () => {
      const f = await fixture(),
        a = preparePaymentOriginalBasis(await f.db.readBackup()),
        nodes = pool(a),
        node = a.added.find((n) => JSON.parse(n.json).kind === kind)!;
      nodes.delete(node.digest);
      expect(() =>
        readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)),
      ).toThrow('complete original payment');
      nodes.set(node.digest, node.json + ' ');
      expect(() =>
        readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)),
      ).toThrow('complete original payment');
    },
  );
it('does not conflate a retained NUL or unpaired surrogate with a printed escape or replacement character', async () => {
  const f = await fixture(),
    a = preparePaymentOriginalBasis(await f.db.readBackup()),
    nodes = pool(a);
  const restored = readPaymentOriginalBasis(a.basis, (key) => nodes.get(key));
  expect(restored.tables.customers[0].notes).toBe(literal);
  expect(restored.tables.customers[0].notes).not.toBe(
    literal.replace('\0', '\\u0000'),
  );
  expect(restored.tables.customers[0].notes).not.toBe(
    literal.replace('\ud800', '\ufffd'),
  );
});
it('rejects a self-rehashed fabricated financial row even when the graph and snapshot hashes match', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    a = preparePaymentOriginalBasis(source),
    replacements = new Map<string, string>(),
    nodes = new Map<string, string>();
  const receipt = source.tables.creditEntries.find(
    (e) => e.type === 'payment',
  )!;
  source.tables.creditEntries.find((e) => e.id === receipt.id)!.amount++;
  const rewrite = (v: unknown): unknown =>
    typeof v === 'string'
      ? (replacements.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(rewrite)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, value]) => [k, rewrite(value)]),
            )
          : v;
  // Builder order is children first. Recompute every ancestor and both size
  // summaries to prove that digests alone never establish financial validity.
  for (const n of a.added) {
    const value = rewrite(JSON.parse(n.json)) as {
      kind: string;
      table?: string;
      value?: { id: string; amount: number };
    };
    if (
      value.kind === 'record' &&
      value.table === 'creditEntries' &&
      value.value!.id === receipt.id
    )
      value.value!.amount++;
    const json = literalToken(value),
      digest = hash(json);
    replacements.set(n.digest, digest);
    nodes.set(digest, json);
  }
  const snapshot = {
      ...source,
      tables: Object.fromEntries(
        Object.entries(source.tables).map(([name, rows]) => [
          name,
          [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
        ]),
      ),
    },
    json = literalToken(snapshot);
  const forged = {
    ...a.basis,
    root: replacements.get(a.basis.root)!,
    nodeBytes: [...nodes.values()].reduce(
      (n, j) => n + new TextEncoder().encode(j).length,
      0,
    ),
    snapshotHash: hash(json),
    snapshotBytes: new TextEncoder().encode(json).length,
  };
  expect(() =>
    readPaymentOriginalBasis(forged, (key) => nodes.get(key)),
  ).toThrow();
});
it('rejects changed scope, missing counts, extra metadata and dishonest total sizes', async () => {
  const f = await fixture(),
    a = preparePaymentOriginalBasis(await f.db.readBackup()),
    nodes = pool(a);
  for (const bad of [
    { ...a.basis, scope: { ...a.basis.scope, outletId: newInboxId() } },
    { ...a.basis, counts: { ...a.basis.counts, payments: 0 } },
    { ...a.basis, nodeCount: a.basis.nodeCount + 1 },
    { ...a.basis, nodeBytes: a.basis.nodeBytes + 1 },
    { ...a.basis, snapshotBytes: a.basis.snapshotBytes + 1 },
    { ...a.basis, snapshotHash: 'a'.repeat(64) },
    { ...a.basis, authorization: 'invented' },
    { ...a.basis, version: 2 },
  ])
    expect(() =>
      readPaymentOriginalBasis(bad, (key) => nodes.get(key)),
    ).toThrow();
  expect(() =>
    parsePaymentOriginalBasis({
      ...a.basis,
      nodeBytes: Number.MAX_SAFE_INTEGER,
    }),
  ).toThrow();
});
it('does not omit records, original evidence, source images or tables to accept a damaged source', async () => {
  const f = await fixture(),
    source = await f.db.readBackup();
  source.tables.creditEntries = source.tables.creditEntries.filter(
    (e) => e.type !== 'payment',
  );
  expect(() => preparePaymentOriginalBasis(source)).toThrow();
  expect(() =>
    preparePaymentOriginalBasis({
      ...f.before,
      tables: { ...f.before.tables, payments: [] },
    }),
  ).toThrow();
});
it('keeps complete 5,000-entry originals through three collections and a restored original undo, sharing radix buckets and maximum imported notes', async () => {
  const db = new MiseDatabase('payment-original-scale-' + newInboxId());
  databases.push(db);
  const f = await seedPaymentStorage(db),
    nodes = new Map<string, string>(),
    plans: PaymentOriginalPlan[] = [];
  const item = await db.captureInbox({
      text: 'Unknown received transfer Tk 1000.',
    }),
    review = await openSavedPaymentSource(db, item.id, {
      businessId: f.setup.business.id,
      outletId: f.setup.outlet.id,
      actorId: f.setup.owner.id,
    });
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 100000,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: '',
    receivedAt: item.createdAt,
  });
  for (let i = 0; i < 3; i++) {
    if (i) {
      await undoSavedPaymentMoney(
        db,
        review,
        await compareSavedPaymentMoneyUndo(db, review),
        true,
      );
    }
    await recordSavedPaymentMoney(
      db,
      review,
      await compareSavedPaymentMoney(db, review, {
        kind: 'credit',
        id: f.account.id,
      }),
      true,
    );
    const plan = preparePaymentOriginalBasis(await db.readBackup(), nodes);
    plans.push(plan);
    pool(plan, nodes);
  }
  expect(plans[1].added.length).toBeLessThan(64);
  expect(plans[2].added.length).toBeLessThan(64);
  expect(
    [...nodes.values()].reduce(
      (n, j) => n + new TextEncoder().encode(j).length,
      0,
    ),
  ).toBeLessThan(plans[0].basis.nodeBytes * 1.2);
  for (const [i, plan] of plans.entries()) {
    const original = readPaymentOriginalBasis(plan.basis, (key) =>
      nodes.get(key),
    );
    expect(original.tables.customers[0].notes).toBe(f.largeNote);
    expect(
      original.tables.creditEntries.filter((e) => e.type === 'charge'),
    ).toHaveLength(5000);
    expect(original.tables.payments[0].postings).toHaveLength(i + 1);
  }
  const restored = new MiseDatabase('payment-original-restore-' + newInboxId());
  databases.push(restored);
  const original = readPaymentOriginalBasis(plans[0].basis, (key) =>
    nodes.get(key),
  );
  await restored.restoreBackup(
    JSON.stringify(original),
    await restored.previewRestore(original),
  );
  const originalReview = await openSavedPaymentSource(restored, item.id, {
    businessId: f.setup.business.id,
    outletId: f.setup.outlet.id,
    actorId: f.setup.owner.id,
  });
  await undoSavedPaymentMoney(
    restored,
    originalReview,
    await compareSavedPaymentMoneyUndo(restored, originalReview),
    true,
  );
  expect(
    (await restored.readBackup()).tables.payments[0].postings![0].undo!.mode,
  ).toBe('performed');
}, 120000);

it('resolves exact capture, recording and original undo actions from their actual native revisions', async () => {
  const f = await fixture();
  await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  const backup = await f.db.readBackup(),
    plan = preparePaymentOriginalBasis(backup),
    nodes = pool(plan);
  const events = backup.tables.events.filter(
    (e) => e.paymentId === f.saved.payment.id,
  );
  for (const event of events) {
    const ref = {
      root: plan.basis.root,
      paymentId: f.saved.payment.id,
      revision: event.paymentRevision!,
      eventId: event.id,
    };
    const original = readPaymentOriginalAction(
      plan.basis,
      (key) => nodes.get(key),
      ref,
    );
    expect(original.event).toEqual(event);
    expect(original.after).toEqual(event.after);
    expect(original.before).toEqual(event.before);
    expect(original.source.images[0].data).toBe(
      backup.tables.inboxItems[0].images[0].data,
    );
    if (event.command === 'payment.record') {
      expect(original.financial!.receipt.entry).toMatchObject({
        amount: 1525,
        type: 'payment',
      });
      expect(original.financial!.events.map((e) => e.command)).toEqual([
        'khata.payment',
      ]);
      expect(original.financial!.undo).toBeNull();
    } else if (event.command === 'payment.record-undo') {
      expect(original.financial!.posting.money.amount).toBe(1525);
      expect(original.financial!.undo!.events.map((e) => e.command)).toEqual([
        'khata.undo',
      ]);
      expect(original.financial!.undo!.snapshot.reversal).toMatchObject({
        reversalOf: original.financial!.posting.receipt.id,
      });
    } else expect(original.financial).toBeNull();
  }
});
it('cannot substitute another basis, action, payment, revision or invented replay consent', async () => {
  const f = await fixture(),
    plan = preparePaymentOriginalBasis(await f.db.readBackup()),
    nodes = pool(plan);
  const ref = {
    root: plan.basis.root,
    paymentId: f.saved.payment.id,
    revision: f.saved.payment.revision,
    eventId: f.saved.payment.eventId,
  };
  for (const bad of [
    { ...ref, root: 'a'.repeat(64) },
    { ...ref, paymentId: newInboxId() },
    { ...ref, revision: ref.revision + 1 },
    { ...ref, eventId: newInboxId() },
    { ...ref, confirmNewMoney: true },
  ])
    expect(() =>
      readPaymentOriginalAction(plan.basis, (key) => nodes.get(key), bad),
    ).toThrow();
  expect(() =>
    parsePaymentOriginalActionRef({ ...ref, windowMinutes: 1440 }),
  ).toThrow();
});

it('validates a portable complete delta before retention and rejects extra, duplicated or conflicting payloads', async () => {
  const f = await fixture(),
    a = preparePaymentOriginalBasis(await f.db.readBackup()),
    nodes = pool(a);
  const verified = verifyPaymentOriginalDelta(
    JSON.parse(JSON.stringify(a)),
    () => undefined,
  );
  expect(verified.basis).toEqual(a.basis);
  expect(verified.added).toEqual(a.added);
  expect(backupToken(verified.snapshot)).toBe(
    backupToken(await f.db.readBackup()),
  );
  const unchanged = await f.db.readBackup();
  unchanged.exportedAt = a.basis.exportedAt;
  const noChange = preparePaymentOriginalBasis(unchanged, nodes);
  expect(
    verifyPaymentOriginalDelta(noChange, (key) => nodes.get(key)).added,
  ).toEqual([]);
  expect(() =>
    verifyPaymentOriginalDelta(
      { ...a, added: [...a.added, a.added[0]] },
      () => undefined,
    ),
  ).toThrow();
  expect(() =>
    verifyPaymentOriginalDelta(a, (key) =>
      key === a.added[0].digest ? 'replacement' : undefined,
    ),
  ).toThrow();
  const other = JSON.parse(a.added[0].json);
  other.value = { ...other.value, unreferenced: true };
  const json = literalToken(other),
    node = { digest: hash(json), json };
  // Existing nodes supply the real graph; an extra unknown payload is rejected
  // even though its own digest, scope and metadata are otherwise consistent.
  expect(() =>
    verifyPaymentOriginalDelta({ basis: a.basis, added: [node] }, (key) =>
      nodes.get(key),
    ),
  ).toThrow();
});
it('rejects malformed radix branches and cannot reuse another table or bucket as an original ledger', async () => {
  const f = await fixture();
  for (let i = 0; i < 70; i++)
    await f.db.recordSale({ expression: '1', method: 'cash' });
  const a = preparePaymentOriginalBasis(await f.db.readBackup()),
    nodes = pool(a),
    branch = a.added.find((n) => JSON.parse(n.json).kind === 'branch')!;
  expect(branch).toBeDefined();
  nodes.delete(branch.digest);
  expect(() =>
    readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)),
  ).toThrow();
  nodes.set(branch.digest, branch.json + ' ');
  expect(() =>
    readPaymentOriginalBasis(a.basis, (key) => nodes.get(key)),
  ).toThrow();
});
