import 'fake-indexeddb/auto';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { nativeCanonicalHarness } from './fixtures/native-canonical-harness';
import { nativePaymentCanonicalCoverage } from '../packages/core/native-payment-coverage';
import {
  parseNativePaymentOutbox,
  nativePaymentOriginalHash,
  nativePaymentOutcomeHash,
} from '../packages/core/native-payment-outbox';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import {
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
const h = nativeCanonicalHarness(
  {
    apiUrl: 'https://native-coverage.test',
    publishableKey: 'sb_publishable_coverage_test',
  },
  'https://shop.test',
);
let server: Awaited<ReturnType<typeof h.start>>;
beforeAll(async () => {
  server = await h.start();
}, 30000);
afterEach(async () => {
  await h.cleanup();
});
afterAll(async () => {
  await h.close();
});
async function coverage(kind: 'counter' | 'order' | 'credit' = 'counter') {
  const f = await h.fixture(kind),
    d = await h.download(f),
    view = await d.read(),
    rows = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    queue = await f.db.outbox.toArray(),
    binding = (await f.db.cloudState.get('binding'))!;
  return {
    f,
    d,
    view,
    rows,
    queue,
    binding,
    check: (r = rows, q = queue, v = view.native) =>
      nativePaymentCanonicalCoverage(
        r,
        q,
        d.state.source.target,
        binding.uploadId,
        v,
      ),
  };
}
for (const kind of ['counter', 'order', 'credit'] as const)
  it(
    'real ' +
      kind +
      ' originals cover only their actual canonical children and retained markers',
    async () => {
      const x = await coverage(kind),
        before = literalToken([x.rows, x.queue]);
      expect([...x.check()].sort()).toEqual(x.queue.map((q) => q.id).sort());
      expect(
        literalToken([
          await x.f.db.nativePaymentActions.toArray(),
          await x.f.db.outbox.toArray(),
        ]),
      ).toBe(before);
      expect(
        x.queue.every(
          (q) =>
            q.status === 'retained' && !q.receipts.length && !q.commands.length,
        ),
      ).toBe(true);
    },
    30000,
  );
for (const kind of ['counter', 'order', 'credit'] as const)
  it(
    'real ' +
      kind +
      ' undo covers its actual original reversal without repeating money',
    async () => {
      const f = await h.fixture(kind);
      await undoSavedPaymentMoney(
        f.db,
        f.review,
        await compareSavedPaymentMoneyUndo(f.db, f.review),
        true,
      );
      await f.session.deliver();
      const d = await h.download(f),
        view = await d.read(),
        rows = (await f.db.nativePaymentActions.toArray()).map(
          parseNativePaymentOutbox,
        ),
        queue = await f.db.outbox.toArray(),
        binding = (await f.db.cloudState.get('binding'))!;
      expect(rows).toHaveLength(3);
      expect(
        [
          ...nativePaymentCanonicalCoverage(
            rows,
            queue,
            d.state.source.target,
            binding.uploadId,
            view.native,
          ),
        ].sort(),
      ).toEqual(queue.map((q) => q.id).sort());
    },
    30000,
  );
it('a genuine canonical source missing an original outcome cannot cover that approval', async () => {
  const x = await coverage(),
    missing = structuredClone(x.view.native);
  missing.actions = missing.actions.slice(1);
  expect(() => x.check(x.rows, x.queue, missing)).toThrow();
}, 30000);
it('a server-timed independent reversal keeps a stale native acknowledgement unconfirmed for current-context review', async () => {
  const f = await h.fixture(),
    sale = (await f.db.sales.toArray())[0];
  await f.db.undoSale(sale.id);
  await f.session.deliver();
  const undo = await compareSavedPaymentMoneyUndo(f.db, f.review);
  expect(undo.preview.alreadyUndone).toBe(true);
  await undoSavedPaymentMoney(f.db, f.review, undo, true);
  const originals = literalToken(
    (await f.db.nativePaymentActions.toArray()).map((r) => r.original),
  );
  await expect(f.session.deliver()).rejects.toThrow();
  const d = await h.download(f),
    view = await d.read(),
    rows = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    queue = await f.db.outbox.toArray(),
    binding = (await f.db.cloudState.get('binding'))!;
  expect(() =>
    nativePaymentCanonicalCoverage(
      rows,
      queue,
      d.state.source.target,
      binding.uploadId,
      view.native,
    ),
  ).toThrow();
  expect(view.native.actions).toHaveLength(2);
  expect(
    rows.find(
      (r) => r.original.invocation.command.type === 'payment.record-undo',
    )!.nativeReceipt,
  ).toBeNull();
  expect(literalToken(rows.map((r) => r.original))).toBe(originals);
  expect(
    (
      await server.sql.query(
        "select id from public.events where outlet_id=$1 and command='sale.undo'",
        [f.setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(1);
}, 30000);
it('rehashing an unrelated retained financial row into an original cannot create canonical coverage', async () => {
  const x = await coverage('order'),
    rows = structuredClone(x.rows),
    queue = structuredClone(x.queue),
    row = rows.find(
      (r) => r.original.invocation.command.type === 'payment.capture',
    )!,
    order = (await x.f.db.orders.toArray())[0],
    extra = {
      table: 'orders' as const,
      key: order.id,
      before: null,
      after: order,
    };
  row.original.changes.push(extra);
  row.originalHash = nativePaymentOriginalHash(row.original);
  row.outcomeHash = nativePaymentOutcomeHash(row);
  const marker = queue.find((q) => q.id === row.original.marker!.entryId)!;
  marker.changes.push(extra);
  expect(() => x.check(rows, queue)).toThrow();
}, 30000);
it('a wrong original account, pending result or unknown retained group stays unconfirmed', async () => {
  const x = await coverage();
  const wrong = structuredClone(x.rows);
  wrong[0].original.marker!.accountHash = 'a'.repeat(64);
  wrong[0].originalHash = nativePaymentOriginalHash(wrong[0].original);
  wrong[0].outcomeHash = nativePaymentOutcomeHash(wrong[0]);
  expect(() => x.check(wrong)).toThrow();
  const pending = structuredClone(x.rows);
  pending[0].state = 'pending';
  pending[0].nativeReceipt = null;
  pending[0].outcomeHash = null;
  expect(() => x.check(pending)).toThrow();
  const missing = structuredClone(x.queue);
  missing[0].id = newInboxId();
  expect(() => x.check(x.rows, missing)).toThrow();
}, 30000);
