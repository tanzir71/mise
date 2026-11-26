import 'fake-indexeddb/auto';
import {
  prepareCloudJoin,
  resumeCloudJoin,
} from '../apps/web/src/data/cloud-join';
import { runSyncCycle } from '../apps/web/src/data/sync-cycle';
import { reviewScopeRecovery } from '../apps/web/src/data/cloud-scope-recovery';
import { CloudUploadJournal } from '../apps/web/src/data/cloud-upload';
import { discoveryAuthScope } from '../apps/web/src/data/cloud-auth-scope';
import {
  applyCanonicalDownload,
  readRecoveryWorkingSource,
} from '../apps/web/src/data/cloud-sync-apply';
import { createCloudCoverageRemote } from '../apps/web/src/data/cloud-coverage-remote';
import { joinCanonicalDevice } from '../apps/web/src/data/cloud-sync-join';
import { createNativeCanonicalOriginals } from '../apps/web/src/data/native-canonical-originals';
import { createOperatorRemote } from '../apps/web/src/data/operator-remote';
import { selectCloudOperator } from '../apps/web/src/data/operator-state';
import { readCanonicalState } from '../apps/web/src/data/cloud-canonical-state';
import { parseSyncScope } from '../packages/core/sync-read';
import { paymentCheckedFields } from '../packages/core/payment-posting-shape';
import { readNativePaymentState } from '../apps/web/src/data/native-payment-state';
import { backupToken } from '../packages/core/backup';
import {
  createNativePaymentBackup,
  parseNativePaymentBackup,
} from '../packages/core/native-payment-backup';
import { sharedJsonHash } from '../packages/core/shared-json';
import {
  parsePortableBackup,
  createPortableBackup,
} from '../packages/core/payment-archive';
import { createHash } from 'node:crypto';
import { inboxImageBytes } from '../packages/core/inbox';
import {
  syncImageSource,
  syncImageSourceHash,
} from '../packages/core/sync-images';
import { creditBalance } from '../packages/core/khata';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { createCopySdk, copySdkSubject } from './fixtures/original-copy-sdk';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  openSavedPaymentSource,
  savedPaymentReceipt,
  editSavedPayment,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import { paymentInvocationHash } from '../packages/core/payment-invocations';
import {
  mergeCanonicalRecords,
  reconstructCanonicalSnapshot,
  reconstructNativeCanonicalRead,
  type NativeCanonicalRead,
  type CanonicalRecord,
} from '../packages/core/sync-canonical';
import { projectNativePaymentCanonical } from '../packages/core/native-payment-canonical';
import {
  paymentOriginalActionReader,
  readPaymentOriginalBasis,
  readPaymentOriginalAction,
} from '../packages/core/payment-originals';
import { nativeCanonicalHarness } from './fixtures/native-canonical-harness';
import { prepareNativeCanonicalCopy } from '../packages/core/native-canonical-copy';

const config = {
    apiUrl: 'https://native-canonical.test',
    publishableKey: 'sb_publishable_canonical_test',
  },
  origin = 'https://shop.test';
const harness = nativeCanonicalHarness(config, origin);
const { fixture, download, manager, stores, sdks, sessions } = harness;
let server: Awaited<ReturnType<typeof harness.start>>;
beforeAll(async () => {
  server = await harness.start();
}, 30000);
afterEach(async () => harness.cleanup());
afterAll(async () => harness.close());
const copyRows = (rows: CanonicalRecord[]) => structuredClone(rows);
function rehash(row: CanonicalRecord) {
  row.rowHash = paymentInvocationHash(row.row);
}
it('actual SDK source links reconstruct one complete native canonical read with independently valid current money and no domain install or replay', async () => {
  const f = await fixture(),
    d = await download(f),
    v = await d.read();
  expect(v.current.tables.payments).toEqual([]);
  expect(v.current.tables.sales).toHaveLength(1);
  expect(v.native.payments).toHaveLength(1);
  expect(v.native.actions).toHaveLength(2);
  expect(v.native.originals.bases).toHaveLength(1);
  expect(v.native.payments[0].original.text).toBe(f.item.text);
  expect(v.native.payments[0].original.text).toBe(
    'DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be',
  );
  expect(v.native.current[0].postings[0]).toMatchObject({
    receipt: { state: 'same' },
    nativeUndo: null,
  });
  expect(
    v.native.current[0].postings[0].events.every((e) => e.state === 'same'),
  ).toBe(true);
  expect(await d.db.sales.count()).toBe(0);
  expect(await d.db.payments.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
  expect(
    (
      await server.sql.query('select * from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
  await expect(
    reconstructCanonicalSnapshot(d.state, d.records, []),
  ).rejects.toThrow('Native canonical installation');
}, 30000);
it('a real independently authorized legacy undo changes current money without rewriting the accepted native action or inventing its native undo', async () => {
  const f = await fixture(),
    first = await (await download(f)).read(),
    sale = first.current.tables.sales[0];
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: sale.id,
    entryId: null,
    creditEventId: null,
    occurredAt: Date.now(),
  });
  const d = await download(f, first),
    next = await d.read();
  expect(next.current.tables.sales[0].voidReason).toBe('undo');
  expect(next.native.current[0].postings[0]).toMatchObject({
    receipt: { state: 'changed' },
    nativeUndo: null,
  });
  expect(literalToken(next.native.actions)).toBe(
    literalToken(first.native.actions),
  );
  expect(literalToken(next.native.payments)).toBe(
    literalToken(first.native.payments),
  );
  expect(next.native.originals).toEqual(first.native.originals);
  expect(await d.db.outbox.count()).toBe(0);
}, 30000);
it('a real replacement receipt stays current while the exact original source retains its original financial identity and total cash is not doubled', async () => {
  const f = await fixture(),
    first = await (await download(f)).read(),
    old = first.current.tables.sales[0];
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: old.id,
    entryId: null,
    creditEventId: null,
    occurredAt: Date.now(),
  });
  const replacement = newInboxId();
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.record',
    outletId: f.setup.outlet.id,
    saleId: replacement,
    occurredAt: Date.now(),
    input: {
      expression: '15.25',
      method: 'cash',
      wallet: null,
      given: null,
      who: 'Independent replacement',
      items: [],
    },
  });
  const v = await (await download(f, first)).read();
  expect(
    v.current.tables.sales
      .filter((s) => s.voidedAt === undefined)
      .map((s) => s.id),
  ).toEqual([replacement]);
  expect(
    v.current.tables.sales
      .filter((s) => s.voidedAt === undefined)
      .reduce((n, s) => n + s.amount, 0),
  ).toBe(1525);
  expect(v.native.payments[0].postings![0].receipt.id).toBe(old.id);
  expect(v.native.current[0].postings[0].receipt.state).toBe('changed');
  expect(v.native.actions).toEqual(first.native.actions);
}, 30000);
it('genuine original native undo remains distinct from the changed current receipt and retains its actual accepted mode and financial events', async () => {
  const f = await fixture();
  await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  await f.session.deliver();
  const v = await (await download(f)).read(),
    p = v.native.current[0].postings[0];
  expect(v.native.actions).toHaveLength(3);
  expect(p.nativeUndo).toMatchObject({ mode: 'performed' });
  expect(p.nativeUndo!.events.every((e) => e.state === 'same')).toBe(true);
  expect(
    v.native.actions.find(
      (a) => a.invocation.command.type === 'payment.record-undo',
    )!.receipt.financial!.mode,
  ).toBe('performed');
  expect(
    v.current.tables.sales.filter((s) => s.voidedAt === undefined),
  ).toHaveLength(0);
}, 30000);
it('a rehashed native event cannot replace the exact accepted original actor even with a valid transport checksum', async () => {
  const f = await fixture(),
    d = await download(f),
    v = await d.read(),
    rows = copyRows(v.records),
    r = rows.find(
      (r) =>
        r.table === 'native_payment_events' &&
        JSON.parse(r.row!.record_json as string).command === 'payment.record',
    )!;
  const e = JSON.parse(r.row!.record_json as string);
  e.actor.id = newInboxId();
  r.row!.record_json = literalToken(e);
  rehash(r);
  await expect(
    projectNativePaymentCanonical(rows, v.current, v.scope, (link) =>
      f.sources.read(link.id),
    ),
  ).rejects.toThrow();
  expect(await d.db.sales.count()).toBe(0);
}, 30000);
it('a fabricated receipt and matching rehashed locator still fail against the full original financial children', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    rows = copyRows(v.records),
    action = rows.find(
      (r) =>
        r.table === 'native_payment_actions' &&
        (r.row!.receipt as { type: string }).type === 'payment.record',
    )!;
  const receipt = action.row!.receipt as { financial: { eventIds: string[] } };
  receipt.financial.eventIds = [newInboxId()];
  rehash(action);
  const locator = rows.find(
      (r) => r.table === 'native_payment_originals' && r.id === action.id,
    )!,
    link = JSON.parse(locator.row!.record_json as string);
  link.receiptHash = paymentInvocationHash(receipt);
  locator.row!.record_json = literalToken(link);
  rehash(locator);
  await expect(
    projectNativePaymentCanonical(
      rows,
      v.current,
      v.scope,
      async (requested) => ({
        ...(await f.sources.read(requested.id)),
        link: requested,
      }),
    ),
  ).rejects.toThrow();
}, 30000);
it('an accepted older command without a genuine source locator stays retained instead of becoming invented historical consent', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    rows = v.records.filter((r) => r.table !== 'native_payment_originals');
  await expect(
    projectNativePaymentCanonical(rows, v.current, v.scope, (link) =>
      f.sources.read(link.id),
    ),
  ).rejects.toMatchObject({ reason: 'original-required' });
}, 30000);
it('whole native history rejects a missing capture even when every remaining row and checksum is valid', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    rows = v.records.filter(
      (r) =>
        !(
          r.table === 'native_payment_events' &&
          JSON.parse(r.row!.record_json as string).command === 'payment.capture'
        ),
    );
  await expect(
    projectNativePaymentCanonical(rows, v.current, v.scope, (link) =>
      f.sources.read(link.id),
    ),
  ).rejects.toThrow();
}, 30000);
it('unreferenced private evidence is rejected rather than silently retained as a verified source', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    rows = copyRows(v.records),
    sample = rows.find(
      (r) =>
        r.table === 'native_payment_events' &&
        JSON.parse(r.row!.record_json as string).command ===
          'source.payment-evidence',
    )!,
    extra = structuredClone(sample),
    event = JSON.parse(extra.row!.record_json as string);
  extra.id = newInboxId();
  event.id = extra.id;
  extra.row!.id = extra.id;
  extra.row!.record_json = literalToken(event);
  extra.changeId = '9223372036854775806';
  rehash(extra);
  rows.push(extra);
  await expect(
    projectNativePaymentCanonical(rows, v.current, v.scope, (link) =>
      f.sources.read(link.id),
    ),
  ).rejects.toThrow();
}, 30000);
it('native metadata tombstones cannot masquerade as an empty verified install or erase the staged source', async () => {
  const f = await fixture(),
    d = await download(f),
    v = await d.read(),
    rows = copyRows(v.records),
    r = rows.find((r) => r.table === 'native_payment_actions')!;
  r.operation = 'delete';
  r.row = null;
  rehash(r);
  await expect(
    projectNativePaymentCanonical(rows, v.current, v.scope, (link) =>
      f.sources.read(link.id),
    ),
  ).rejects.toMatchObject({ reason: 'metadata-removed' });
  expect(await d.db.syncRecords.count()).toBe(d.records.length);
  expect(await d.db.payments.count()).toBe(0);
}, 30000);
it('a reused original reader keeps its strictly validated snapshot private after callers mutate a returned action or later node lookup', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    link = v.native.actions[0].source,
    b = v.native.originals.bases.find((b) => b.root === link.ref.root)!,
    nodes = new Map(v.native.originals.nodes.map((n) => [n.digest, n.json]));
  const reader = paymentOriginalActionReader(b, (key) => nodes.get(key)),
    first = reader(link.ref),
    expected = structuredClone(first);
  expect(Object.isFrozen(first.ref)).toBe(true);
  expect(Object.isFrozen(first.basis)).toBe(true);
  expect(Object.isFrozen(first.basis.scope)).toBe(true);
  expect(Object.isFrozen(first.basis.counts)).toBe(true);
  first.after.amount++;
  first.source.text = 'Changed';
  nodes.clear();
  expect(reader(link.ref)).toEqual(expected);
  let reads = 0;
  expect(() =>
    readPaymentOriginalAction(
      b,
      () => {
        reads++;
        return undefined;
      },
      { ...link.ref, root: 'f'.repeat(64) },
    ),
  ).toThrow();
  expect(reads).toBe(0);
}, 30000);

it('a root cached from another accepted action must still belong to the exact claimed copy', async () => {
  const f = await fixture();
  await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  await f.session.deliver();
  const v = await (await download(f)).read(),
    rows = copyRows(v.records);
  const undo = v.native.actions.find(
      (a) => a.invocation.command.type === 'payment.record-undo',
    )!,
    capture = v.native.actions.find(
      (a) => a.invocation.command.type === 'payment.capture',
    )!;
  expect(undo.source.ref.root).not.toBe(capture.source.ref.root);
  const locator = rows.find(
      (r) =>
        r.table === 'native_payment_originals' &&
        r.id === capture.invocation.command.id,
    )!,
    link = JSON.parse(locator.row!.record_json as string);
  link.ref.root = undo.source.ref.root;
  locator.row!.record_json = literalToken(link);
  rehash(locator);
  rows.sort(
    (a, b) =>
      Number(
        b.table === 'native_payment_actions' &&
          b.id === undo.invocation.command.id,
      ) -
      Number(
        a.table === 'native_payment_actions' &&
          a.id === undo.invocation.command.id,
      ),
  );
  await expect(
    projectNativePaymentCanonical(
      rows,
      v.current,
      v.scope,
      async (requested) => ({
        ...(await f.sources.read(requested.id)),
        link: requested,
      }),
    ),
  ).rejects.toThrow();
}, 30000);

it.each(['credit', 'order'] as const)(
  'actual %s canonical money can be independently undone while accepted original history remains exact',
  async (kind) => {
    const f = await fixture(kind),
      first = await (await download(f)).read(),
      posting = first.native.payments[0].postings![0];
    expect(first.native.current[0].postings[0].currentReceipt).toEqual({
      eligible: true,
      matchesOriginal: true,
    });
    if (kind === 'credit')
      await f.commands.apply({
        id: newInboxId(),
        type: 'khata.undo',
        outletId: f.setup.outlet.id,
        entryId: posting.receipt.id,
        reversalId: newInboxId(),
        occurredAt: Date.now(),
      });
    else {
      const order = first.current.tables.orders[0],
        ids = {
          saleId: newInboxId(),
          saleEventId: newInboxId(),
          entryId: newInboxId(),
          creditEventId: newInboxId(),
          refundId: newInboxId(),
          refundEventId: newInboxId(),
        };
      await f.commands.apply({
        id: newInboxId(),
        type: 'order.payment-undo',
        outletId: f.setup.outlet.id,
        orderId: order.id,
        revision: order.revision,
        sourceSaleId: order.payment.saleId!,
        sourcePaymentAt: order.payment.at!,
        ids,
        occurredAt: Date.now(),
      });
    }
    const next = await (await download(f, first)).read();
    expect(next.native.actions).toEqual(first.native.actions);
    expect(next.native.payments).toEqual(first.native.payments);
    expect(next.native.current[0].postings[0]).toMatchObject({
      currentReceipt: { eligible: false, matchesOriginal: false },
      nativeUndo: null,
    });
    if (kind === 'credit') {
      expect(next.native.current[0].postings[0].receipt.state).toBe('same');
      expect(
        creditBalance(
          next.current.tables.creditAccounts.find((a) => a.id === f.accountId)!,
          next.current.tables.creditEntries,
        ),
      ).toBe(100000);
    } else expect(next.current.tables.orders[0].payment.status).toBe('pending');
  },
  30000,
);
it('a different actual SDK manager reconstructs the original owner history without relabelling the origin or installing domain rows', async () => {
  const f = await fixture(),
    m = await manager(f),
    d = await download(m),
    v = await d.read();
  expect(v.scope.actorId).toBe(m.managerId);
  expect(v.scope.role).toBe('manager');
  expect(v.native.payments[0].createdBy).toBe(f.setup.owner.id);
  expect(
    v.native.actions.every(
      (a) =>
        a.invocation.command.actorId === f.setup.owner.id &&
        a.source.actorId === f.setup.owner.id,
    ),
  ).toBe(true);
  expect(await d.db.sales.count()).toBe(0);
  expect(await d.db.payments.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
}, 30000);
it('current manager revocation after the financial snapshot denies original reconstruction and retains every staged record', async () => {
  const f = await fixture(),
    m = await manager(f),
    d = await download(m);
  await server.sql.query(
    'delete from public.member_outlets where member_id=$1',
    [m.managerId],
  );
  await expect(d.read()).rejects.toThrow();
  expect(await d.db.syncRecords.count()).toBe(d.records.length);
  expect(await d.db.sales.count()).toBe(0);
  expect(await d.db.payments.count()).toBe(0);
}, 30000);

it('the entire 5000-charge, million-code-unit, original-image corpus becomes a verified native read with one actual collection and no domain install', async () => {
  const started = performance.now(),
    f = await fixture('credit', true),
    d = await download(f);
  const records = await mergeCanonicalRecords([], d.records, d.state.id),
    locator = records.find((r) => r.table === 'native_payment_originals')!,
    link = JSON.parse(locator.row!.record_json as string),
    original = await f.sources.read(link.id);
  const item = original.decoded.current.tables.inboxItems.find(
    (i) => i.id === f.item.id,
  )!;
  const images = [];
  for (const r of d.records.filter(
    (r) => r.meta.table === 'inbox_images' && r.meta.operation === 'upsert',
  )) {
    const source = syncImageSource(d.state, r),
      image = item.images.find((i) => i.id === source.image.id)!;
    expect(image).toBeTruthy();
    images.push({
      readId: d.state.id,
      imageId: image.id,
      source,
      sourceHash: await syncImageSourceHash(source),
      blob: new Blob([new Uint8Array(inboxImageBytes(image)).buffer], {
        type: image.type,
      }),
    });
  }
  const v = await reconstructNativeCanonicalRead(
    d.state,
    d.records,
    images,
    async (requested) => {
      const actual = await f.sources.inspect(requested.id);
      expect(actual.retention.copy).toEqual(original.link.retention.copy);
      return { link: actual, portable: original.portable };
    },
  );
  const nodeMap = new Map(
      v.native.originals.nodes.map((n) => [n.digest, n.json]),
    ),
    basis = v.native.originals.bases[0],
    snapshot = readPaymentOriginalBasis(basis, (key) => nodeMap.get(key));
  const originals = snapshot.tables.creditEntries
    .filter((e) => e.sequence <= 5000)
    .sort((a, b) => a.sequence - b.sequence);
  expect(originals).toEqual(f.large!.entries);
  expect(originals).toHaveLength(5000);
  const sha = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  expect(snapshot.tables.customers[0].notes).toHaveLength(1000000);
  expect(sha(snapshot.tables.customers[0].notes)).toBe(sha(f.large!.largeNote));
  expect(
    snapshot.tables.inboxItems.find((i) => i.id === f.item.id)!.images,
  ).toEqual(item.images);
  expect(
    v.current.tables.inboxItems.find((i) => i.id === f.item.id)!.images,
  ).toEqual(item.images);
  expect(v.current.tables.creditEntries).toHaveLength(5001);
  expect(
    creditBalance(
      v.current.tables.creditAccounts.find((a) => a.id === f.accountId)!,
      v.current.tables.creditEntries,
    ),
  ).toBe(498475);
  expect(v.native.current[0].postings[0].currentReceipt).toEqual({
    eligible: true,
    matchesOriginal: true,
  });
  expect(
    (
      await server.sql.query(
        'select id from public.credit_entries where outlet_id=$1',
        [f.setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(5001);
  expect(await d.db.creditEntries.count()).toBe(0);
  expect(await d.db.payments.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
  console.log(
    JSON.stringify({
      stage: 'native-canonical-scale-verified',
      charges: 5000,
      noteCodeUnits: 1000000,
      images: item.images.length,
      actualCollections: 1,
      nativeActions: v.native.actions.length,
      readRecords: d.records.length,
      originalBases: v.native.originals.bases.length,
      originalNodes: v.native.originals.nodes.length,
      elapsedMs: performance.now() - started,
    }),
  );
}, 600000);

it('actual backend maintenance can remove current financial rows without recreating them from accepted native originals or fabricating undo', async () => {
  const f = await fixture(),
    first = await (await download(f)).read(),
    sale = first.current.tables.sales[0];
  await server.sql.transaction(async (tx) => {
    await tx.query('delete from public.sales where id=$1 and outlet_id=$2', [
      sale.id,
      f.setup.outlet.id,
    ]);
    await tx.query('delete from public.events where id=$1 and outlet_id=$2', [
      sale.eventId,
      f.setup.outlet.id,
    ]);
  });
  const d = await download(f, first),
    v = await d.read();
  expect(v.current.tables.sales).toHaveLength(0);
  expect(v.native.actions).toEqual(first.native.actions);
  expect(v.native.payments).toEqual(first.native.payments);
  expect(v.native.originals).toEqual(first.native.originals);
  expect(v.native.current[0].postings[0]).toMatchObject({
    receipt: { state: 'missing' },
    currentReceipt: { eligible: false, matchesOriginal: false },
    nativeUndo: null,
  });
  expect(
    v.native.current[0].postings[0].events.every((e) => e.state === 'missing'),
  ).toBe(true);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(await d.db.sales.count()).toBe(0);
  expect(await d.db.payments.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
}, 30000);

it('a valid original basis cannot excuse a different portable body under the claimed sealed copy', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    first = v.native.actions[0].source,
    loaded = await f.sources.read(first.id),
    decoded = parsePortableBackup(loaded.portable);
  const originalExportedAt = decoded.current.exportedAt;
  decoded.current.exportedAt++;
  const portable = createPortableBackup(
      decoded.current,
      decoded.bases,
      decoded.nodes,
    ),
    checked = parsePortableBackup(portable);
  expect(checked.bases).toEqual(decoded.bases);
  expect(checked.current.exportedAt).toBe(originalExportedAt + 1);
  await expect(
    projectNativePaymentCanonical(
      v.records,
      v.current,
      v.scope,
      async (link) => {
        const actual = await f.sources.inspect(link.id);
        expect(actual.retention.copy.id).toBe(first.retention.copy.id);
        return { link: actual, portable };
      },
    ),
  ).rejects.toThrow();
}, 30000);

it('a complete v3 payment backup retains genuine original evidence independently of actual current financial undo without any SDK, cursor or outgoing action on cold read', async () => {
  const f = await fixture(),
    sale = f.recorded.payment.postings![0].receipt.id;
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: sale,
    occurredAt: Date.now(),
    entryId: null,
    creditEventId: null,
  });
  const v = await (await download(f)).read(),
    file = await createNativePaymentBackup(v.current, v.records, (link) =>
      f.sources.read(link.id),
    );
  expect(file.formatVersion).toBe(3);
  const cold = await parseNativePaymentBackup(JSON.stringify(file), {
    fresh: true,
  });
  expect(cold.current).toEqual(v.current);
  expect(cold.records).toEqual(
    v.records.filter((r) => r.table.startsWith('native_')),
  );
  expect(cold.projection).toEqual(v.native);
  expect(cold.projection.payments[0].original.text).toBe(
    'DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be',
  );
  expect(cold.projection.current[0].postings[0]).toMatchObject({
    currentReceipt: { eligible: false },
    nativeUndo: null,
    receipt: { state: 'changed' },
  });
  expect(Object.keys(file).sort()).toEqual([
    'encoding',
    'exportedAt',
    'format',
    'formatVersion',
    'root',
    'schemaVersion',
    'values',
  ]);
  expect(() => parsePortableBackup(file)).toThrow();
  expect(
    (
      await server.sql.query(
        'select id from public.sales where business_id=$1 and outlet_id=$2',
        [f.setup.business.id, f.setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(1);
  expect(await f.db.nativePaymentActions.count()).toBe(2);
}, 30000);

it('the v3 file rejects missing, changed, duplicate and unrelated shared source nodes before restore', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    file = await createNativePaymentBackup(v.current, v.records, (link) =>
      f.sources.read(link.id),
    );
  const bad = structuredClone(file);
  bad.values[0].json += ' ';
  await expect(parseNativePaymentBackup(bad)).rejects.toThrow();
  const missing = structuredClone(file);
  missing.values = missing.values.filter((n) => n.digest !== file.root);
  await expect(parseNativePaymentBackup(missing)).rejects.toThrow();
  const duplicate = structuredClone(file);
  duplicate.values.push(duplicate.values[0]);
  await expect(parseNativePaymentBackup(duplicate)).rejects.toThrow();
  const unrelated = structuredClone(file),
    json = '["s","Unrelated exact node"]';
  unrelated.values.push({ digest: sharedJsonHash(json), json });
  await expect(parseNativePaymentBackup(unrelated)).rejects.toThrow();
  expect(
    (
      await server.sql.query(
        'select id from public.sales where business_id=$1 and outlet_id=$2',
        [f.setup.business.id, f.setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(1);
}, 30000);

it('the existing restore/export controls retain both original native evidence and independently corrected current money with no restored sends', async () => {
  const f = await fixture(),
    sale = f.recorded.payment.postings![0].receipt.id;
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: sale,
    occurredAt: Date.now(),
    entryId: null,
    creditEventId: null,
  });
  const v = await (await download(f)).read(),
    file = await createNativePaymentBackup(v.current, v.records, (link) =>
      f.sources.read(link.id),
    );
  const target = new MiseDatabase('native-v3-cold-restore-' + newInboxId());
  stores.push(target);
  const preview = await target.previewRestore(JSON.stringify(file));
  expect(preview.counts.payments).toBe(1);
  await target.restoreBackup(JSON.stringify(file), preview);
  const saved = await readNativePaymentState(target);
  expect(saved?.state.mode).toBe('restored');
  expect(saved?.projection.payments).toEqual(v.native.payments);
  expect(saved?.projection.current[0].postings[0]).toMatchObject({
    currentReceipt: { eligible: false },
    nativeUndo: null,
  });
  expect(await target.sales.count()).toBe(1);
  expect((await target.sales.get(sale))?.voidedAt).toBeDefined();
  expect(await target.nativePaymentActions.count()).toBe(0);
  expect(await target.outbox.count()).toBe(0);
  expect(await target.cloudState.count()).toBe(0);
  expect(await target.syncCanonical.count()).toBe(0);
  await expect(target.readPortableBackup()).rejects.toThrow('complete backup');
  const migration = new CloudUploadJournal(
    'native-v3-migration-fence-' + newInboxId(),
  );
  stores.push(migration);
  await expect(migration.prepare(target, newInboxId())).rejects.toThrow(
    'complete JSON backup',
  );
  expect(await migration.uploads.count()).toBe(0);
  const setup = (await target.setup())!,
    review = await openSavedPaymentSource(target, f.item.id, {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    }),
    restored = await savedPaymentReceipt(target, review);
  expect(restored?.payment).toEqual(v.native.payments[0]);
  expect(restored?.associationCurrent).toBe(false);
  expect(restored?.inspection.postings[0].target).toMatchObject({
    kind: 'counter',
    who: 'Exact original',
  });
  await expect(
    editSavedPayment(
      target,
      review,
      { id: newInboxId(), revision: restored!.payment.revision },
      { checked: true, ...paymentCheckedFields(restored!.payment) },
    ),
  ).rejects.toThrow('manual money flow');
  expect(await target.sales.count()).toBe(1);

  await target.recordSale({ expression: '10', method: 'cash' });
  const exported = (await target.readCompleteBackup()).portable;
  expect(exported.formatVersion).toBe(3);
  const checked = await parseNativePaymentBackup(JSON.stringify(exported));
  expect(checked.current.tables.sales).toHaveLength(2);
  expect(checked.projection.payments).toEqual(v.native.payments);
  expect(
    checked.projection.current[0].postings[0].currentReceipt.eligible,
  ).toBe(false);
  expect(
    (
      await server.sql.query(
        'select id from public.sales where business_id=$1',
        [f.setup.business.id],
      )
    ).rows,
  ).toHaveLength(1);
}, 30000);

it('a native graph quota failure during the actual restore rolls every ordinary record, selection and source write back', async () => {
  const f = await fixture(),
    v = await (await download(f)).read(),
    file = await createNativePaymentBackup(v.current, v.records, (link) =>
      f.sources.read(link.id),
    );
  const target = new MiseDatabase('native-v3-quota-restore-' + newInboxId());
  stores.push(target);
  await target.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Keep existing shop',
    phone: '01712345482',
  });
  await target.recordSale({ expression: '42', method: 'cash' });
  const before = await target.readBackup(),
    selection = await target.operatorState.toArray(),
    preview = await target.previewRestore(file);
  const quota = () => {
    throw new Error('fictional native evidence quota failure');
  };
  target.nativePaymentValues.hook('creating', quota);
  await expect(target.restoreBackup(file, preview)).rejects.toThrow('quota');
  target.nativePaymentValues.hook('creating').unsubscribe(quota);
  expect(backupToken(await target.readBackup())).toBe(backupToken(before));
  expect(await target.operatorState.toArray()).toEqual(selection);
  expect(await target.nativePaymentState.count()).toBe(0);
  expect(await target.nativePaymentValues.count()).toBe(0);
  expect(await target.nativePaymentActions.count()).toBe(0);
  expect(await target.outbox.count()).toBe(0);
}, 30000);

it('a fresh actual SDK device installs current money and complete native originals with one accepted cursor and no outgoing money', async () => {
  const f = await fixture(),
    d = await download(f),
    target = d.state.source.target,
    context = {
      version: 1 as const,
      ...parseSyncScope(d.state.window!),
      businessName: null,
      outletName: null,
      actorName: null,
    },
    metadata = createOperatorRemote(
      config,
      () => f.sdk.auth.commandAuthorization(),
      f.options.send,
    ),
    refresh: Parameters<typeof selectCloudOperator>[4] = (c) =>
      metadata.select(c),
    selected = await selectCloudOperator(
      d.db,
      context,
      { authKey: f.sdk.auth.key, targetHash: target.targetHash },
      null,
      refresh,
    ),
    sources = createNativeCanonicalOriginals(
      config,
      {
        scope: f.options.authScope,
        targetHash: target.targetHash,
        accountHash: target.accountHash,
        getAuth: () => f.sdk.auth.commandAuthorization(),
        assertCurrent: (value) => f.sdk.auth.assertCommandAuthorization(value),
      },
      {
        businessId: target.businessId,
        outletId: target.outletId,
        actorId: target.actorId,
      },
      f.options.send,
    );
  sessions.push(sources);
  const input = {
      readId: d.state.id,
      target,
      authKey: f.sdk.auth.key,
      expectedOperatorRevision: selected.revision,
    },
    joined = await joinCanonicalDevice(
      d.db,
      input,
      refresh,
      undefined,
      undefined,
      sources.load,
    ),
    state = await readCanonicalState(d.db),
    native = await readNativePaymentState(d.db);
  expect(state.base.snapshot.readId).toBe(joined.readId);
  expect(native?.state).toMatchObject({
    mode: 'canonical',
    baseHash: state.base.hash,
  });
  expect(native?.projection.payments[0].original.text).toBe(
    'DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be',
  );
  expect(await d.db.sales.count()).toBe(1);
  expect(await d.db.payments.count()).toBe(0);
  expect(await d.db.nativePaymentActions.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
  expect((await d.db.cloudState.get('binding'))?.join?.cursor).toBe(
    d.state.receivedCursor,
  );
  expect(
    await joinCanonicalDevice(
      d.db,
      input,
      refresh,
      undefined,
      undefined,
      sources.load,
    ),
  ).toEqual(joined);
  expect((await d.db.readCompleteBackup()).portable.formatVersion).toBe(3);
  expect(
    (
      await server.sql.query(
        'select id from public.sales where business_id=$1',
        [f.setup.business.id],
      )
    ).rows,
  ).toHaveLength(1);
}, 30000);

it('real native canonical pulls preserve an absent cash intent, then use actual receipt coverage without repeating money or rewriting originals', async () => {
  const f = await fixture(),
    d = await download(f),
    target = d.state.source.target,
    context = {
      version: 1 as const,
      ...parseSyncScope(d.state.window!),
      businessName: null,
      outletName: null,
      actorName: null,
    },
    metadata = createOperatorRemote(
      config,
      () => f.sdk.auth.commandAuthorization(),
      f.options.send,
    ),
    refresh: Parameters<typeof selectCloudOperator>[4] = (c) =>
      metadata.select(c),
    selected = await selectCloudOperator(
      d.db,
      context,
      { authKey: f.sdk.auth.key, targetHash: target.targetHash },
      null,
      refresh,
    ),
    account = {
      scope: f.options.authScope,
      targetHash: target.targetHash,
      accountHash: target.accountHash,
      getAuth: () => f.sdk.auth.commandAuthorization(),
      assertCurrent: (
        value: Awaited<ReturnType<typeof f.sdk.auth.commandAuthorization>>,
      ) => f.sdk.auth.assertCommandAuthorization(value),
    },
    sourceScope = {
      businessId: target.businessId,
      outletId: target.outletId,
      actorId: target.actorId,
    },
    firstSources = createNativeCanonicalOriginals(
      config,
      account,
      sourceScope,
      f.options.send,
    );
  sessions.push(firstSources);
  await joinCanonicalDevice(
    d.db,
    {
      readId: d.state.id,
      target,
      authKey: f.sdk.auth.key,
      expectedOperatorRevision: selected.revision,
    },
    refresh,
    undefined,
    undefined,
    firstSources.load,
  );
  const original = await readNativePaymentState(d.db);
  expect(original).not.toBeNull();
  firstSources.stop();
  const copyOps: string[] = [],
    send: typeof fetch = (url, init) => {
      const op = new Headers(init?.headers).get('X-Mise-Original-Action');
      if (op) copyOps.push(op);
      return f.options.send(url, init);
    },
    sources = createNativeCanonicalOriginals(
      config,
      account,
      sourceScope,
      send,
      undefined,
      () => {},
      async (link) => original!.loadOriginal(link),
    );
  sessions.push(sources);
  const sale = f.recorded.payment.postings![0].receipt.id;
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: sale,
    occurredAt: Date.now(),
    entryId: null,
    creditEventId: null,
  });
  const pendingSale = await d.db.recordSale({
      expression: '19',
      method: 'cash',
    }),
    queued = await d.db.outbox.toArray(),
    command = queued[0].commands[0];
  const coverage = createCloudCoverageRemote(
    config,
    f.options.authScope,
    () => f.sdk.auth.commandAuthorization(),
    f.options.send,
  );
  const pull = async () => {
    const base = (await readCanonicalState(d.db)).base.snapshot,
      native = await readNativePaymentState(d.db),
      prior: NativeCanonicalRead = {
        format: 'mise-native-canonical-read',
        version: 1,
        current: base.backup,
        records: base.records,
        cursor: base.cursor,
        readId: base.readId,
        seal: base.seal,
        scope: base.scope,
        targetHash: base.targetHash,
        native: native!.projection,
      },
      next = await download(f, prior, d.db),
      operator = (await d.db.operatorState.get('active'))!;
    const applied = await applyCanonicalDownload(
      d.db,
      {
        readId: next.state.id,
        target,
        authKey: f.sdk.auth.key,
        expectedOperatorRevision: operator.revision,
      },
      coverage,
      refresh,
      undefined,
      undefined,
      sources.load,
    );
    return {
      applied,
      native: await readNativePaymentState(d.db),
      state: await readCanonicalState(d.db),
    };
  };
  const first = await pull();
  expect(first.applied.pending).toBe(1);
  expect(first.applied.covered).toBe(0);
  expect((await d.db.sales.get(sale))?.voidedAt).toBeDefined();
  expect((await d.db.sales.get(pendingSale.id))?.amount).toBe(1900);
  expect(await d.db.outbox.toArray()).toEqual(queued);
  expect(first.native?.projection.payments).toEqual(
    original!.projection.payments,
  );
  expect(first.native?.projection.current[0].postings[0]).toMatchObject({
    currentReceipt: { eligible: false },
    nativeUndo: null,
  });
  await f.commands.apply(command);
  const second = await pull();
  expect(second.applied.pending).toBe(0);
  expect(second.applied.covered).toBe(1);
  expect(await d.db.sales.count()).toBe(2);
  expect(
    (await d.db.sales.toArray())
      .filter((s) => s.voidedAt === undefined)
      .map((s) => s.amount),
  ).toEqual([1900]);
  expect(second.native?.projection.payments).toEqual(
    original!.projection.payments,
  );
  expect(
    copyOps.filter((op) => op === 'payment-inspect').length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    copyOps.filter((op) => op === 'payment-read' || op === 'payment-read-part'),
  ).toEqual([]);
  expect(
    (
      await server.sql.query(
        'select amount from public.sales where business_id=$1 and voided_at is null',
        [f.setup.business.id],
      )
    ).rows,
  ).toEqual([{ amount: 1900 }]);
  expect(await d.db.nativePaymentActions.count()).toBe(0);
  expect((await d.db.readCompleteBackup()).portable.formatVersion).toBe(3);
}, 60000);

it('the actual product join and sync controllers use a fresh SDK session to install native history and deliver one manual cash entry', async () => {
  const f = await fixture(),
    window = await f.remote.begin({
      type: 'begin',
      id: newInboxId(),
      outletId: f.setup.outlet.id,
      cursor: null,
    }),
    base = '/native-product-' + newInboxId() + '/',
    sessionId = copySdkSubject(301);
  await server.sql.query(
    'insert into auth.sessions(id,user_id) values($1,$2)',
    [sessionId, copySdkSubject(1)],
  );
  const sdk = await createCopySdk(
    config,
    discoveryAuthScope(base),
    f.bridge,
    1,
    undefined,
    sessionId,
  );
  sdks.push(sdk);
  const target = new MiseDatabase('native-product-device-' + newInboxId()),
    journal = new CloudUploadJournal('native-product-uploads-' + newInboxId());
  stores.push(target, journal);
  const options = { config, base, auth: sdk.auth, send: f.bridge },
    context = {
      version: 1 as const,
      ...parseSyncScope(window),
      businessName: null,
      outletName: null,
      actorName: null,
    };
  await prepareCloudJoin(target, options, context);
  const joined = await resumeCloudJoin(target, options);
  expect(joined.phase).toBe('ready');
  expect(
    (await readNativePaymentState(target))?.projection.payments[0].original
      .text,
  ).toBe('DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be');
  expect(await target.nativePaymentActions.count()).toBe(0);
  expect(await target.outbox.count()).toBe(0);
  const cash = await target.recordSale({ expression: '21', method: 'cash' });
  expect(
    await runSyncCycle(target, {
      config,
      scope: base + f.setup.business.id,
      auth: sdk.auth,
      journal,
      send: f.bridge,
    }),
  ).toBe(true);
  expect((await target.outbox.toArray()).map((r) => r.status)).toEqual([
    'accepted',
  ]);
  expect((await target.sales.get(cash.id))?.amount).toBe(2100);
  expect(await target.sales.count()).toBe(2);
  expect(await target.nativePaymentActions.count()).toBe(0);
  const canonical = await readCanonicalState(target),
    native = await readNativePaymentState(target);
  expect(native?.state.baseHash).toBe(canonical.base.hash);
  expect(canonical.application?.pending).toEqual([]);
  expect(native?.projection.payments[0].postings?.[0].receipt.id).toBe(
    f.recorded.payment.postings![0].receipt.id,
  );
  expect(
    (
      await server.sql.query(
        'select amount from public.sales where business_id=$1 order by amount',
        [f.setup.business.id],
      )
    ).rows,
  ).toEqual([{ amount: 1525 }, { amount: 2100 }]);
  expect((await target.readCompleteBackup()).portable.formatVersion).toBe(3);
}, 60000);

async function nativeInstallFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const d = await download(f),
    target = d.state.source.target,
    context = {
      version: 1 as const,
      ...parseSyncScope(d.state.window!),
      businessName: null,
      outletName: null,
      actorName: null,
    },
    metadata = createOperatorRemote(
      config,
      () => f.sdk.auth.commandAuthorization(),
      f.bridge,
    ),
    refresh: Parameters<typeof selectCloudOperator>[4] = (c) =>
      metadata.select(c),
    selected = await selectCloudOperator(
      d.db,
      context,
      { authKey: f.sdk.auth.key, targetHash: target.targetHash },
      null,
      refresh,
    ),
    input = {
      readId: d.state.id,
      target,
      authKey: f.sdk.auth.key,
      expectedOperatorRevision: selected.revision,
    },
    load: Parameters<typeof joinCanonicalDevice>[5] = (link) =>
      f.sources.read(link.id);
  return { d, target, selected, input, refresh, load };
}
async function nativeInstallPrior(
  db: MiseDatabase,
): Promise<NativeCanonicalRead> {
  const base = (await readCanonicalState(db)).base.snapshot,
    native = await readNativePaymentState(db);
  return {
    format: 'mise-native-canonical-read',
    version: 1,
    current: base.backup,
    records: base.records,
    cursor: base.cursor,
    readId: base.readId,
    seal: base.seal,
    scope: base.scope,
    targetHash: base.targetHash,
    native: native!.projection,
  };
}
it('native installation quota failure preserves the empty device and every staged source without accepting a cursor', async () => {
  const f = await fixture(),
    x = await nativeInstallFixture(f),
    before = await x.d.db.operatorState.get('active'),
    quota = () => {
      throw Error('fictional native installation quota');
    };
  x.d.db.nativePaymentValues.hook('creating', quota);
  await expect(
    joinCanonicalDevice(
      x.d.db,
      x.input,
      x.refresh,
      undefined,
      undefined,
      x.load,
    ),
  ).rejects.toThrow('quota');
  x.d.db.nativePaymentValues.hook('creating').unsubscribe(quota);
  expect(await x.d.db.sales.count()).toBe(0);
  expect(await x.d.db.nativePaymentValues.count()).toBe(0);
  expect(await x.d.db.nativePaymentState.count()).toBe(0);
  expect(await x.d.db.syncCanonical.count()).toBe(0);
  expect(await x.d.db.cloudState.count()).toBe(0);
  expect(await x.d.db.operatorState.get('active')).toEqual(before);
  expect(await x.d.db.syncRecords.toArray()).toEqual(x.d.records);
}, 30000);
it('a finite native canonical quota failure preserves the old current money, source graph, cursor and queue together', async () => {
  const f = await fixture(),
    x = await nativeInstallFixture(f);
  await joinCanonicalDevice(
    x.d.db,
    x.input,
    x.refresh,
    undefined,
    undefined,
    x.load,
  );
  const before = await readCanonicalState(x.d.db),
    native = await readNativePaymentState(x.d.db),
    ordinary = await x.d.db.readBackup(),
    queue = await x.d.db.outbox.toArray(),
    prior = await nativeInstallPrior(x.d.db);
  await f.commands.apply({
    id: newInboxId(),
    type: 'sale.undo',
    outletId: f.setup.outlet.id,
    saleId: f.recorded.payment.postings![0].receipt.id,
    occurredAt: Date.now(),
    entryId: null,
    creditEventId: null,
  });
  const next = await download(f, prior, x.d.db),
    operator = (await x.d.db.operatorState.get('active'))!,
    quota = () => {
      throw Error('fictional finite native delta quota');
    };
  x.d.db.nativePaymentValues.hook('creating', quota);
  await expect(
    applyCanonicalDownload(
      x.d.db,
      {
        ...x.input,
        readId: next.state.id,
        expectedOperatorRevision: operator.revision,
      },
      createCloudCoverageRemote(
        config,
        f.options.authScope,
        () => f.sdk.auth.commandAuthorization(),
        f.options.send,
      ),
      x.refresh,
      undefined,
      undefined,
      x.load,
    ),
  ).rejects.toThrow('quota');
  x.d.db.nativePaymentValues.hook('creating').unsubscribe(quota);
  expect(backupToken(await x.d.db.readBackup())).toBe(backupToken(ordinary));
  expect((await readNativePaymentState(x.d.db))!.token).toBe(native!.token);
  expect((await readCanonicalState(x.d.db)).token).toBe(before.token);
  expect(await x.d.db.outbox.toArray()).toEqual(queue);
  expect(
    (await x.d.db.syncRecords.where('readId').equals(next.state.id).toArray())
      .length,
  ).toBe(next.records.length);
}, 30000);
it('warm native validation caches keep caller copies private and reject changed actual stored bytes before export or canonical use', async () => {
  const f = await fixture(),
    x = await nativeInstallFixture(f);
  await joinCanonicalDevice(
    x.d.db,
    x.input,
    x.refresh,
    undefined,
    undefined,
    x.load,
  );
  const original = await readNativePaymentState(x.d.db),
    before = await readCanonicalState(x.d.db),
    expected = structuredClone(original!.projection.payments);
  original!.projection.payments[0].amount = 1;
  original!.wire.values[0].json += ' ';
  const link = original!.projection.actions[0].source,
    source = await f.sources.read(link.id),
    scope = {
      businessId: link.businessId,
      outletId: link.outletId,
      actorId: link.actorId,
    },
    first = prepareNativeCanonicalCopy(
      source.portable,
      scope,
      link.retention.copy.id,
    ),
    expectedCopy = {
      manifest: structuredClone(first.plan.manifest),
      values: structuredClone(first.plan.nodes),
      bases: structuredClone(first.bases),
      nodes: structuredClone(first.nodes),
    };
  first.plan.manifest.root = '0'.repeat(64);
  first.plan.nodes[0].json += ' ';
  first.bases[0] = {
    ...first.bases[0],
    scope: { ...first.bases[0].scope, outletId: newInboxId() },
  };
  first.nodes[0] = { ...first.nodes[0], json: first.nodes[0].json + ' ' };
  first.portable.exportedAt = 0;
  const nextCopy = prepareNativeCanonicalCopy(
    source.portable,
    scope,
    link.retention.copy.id,
  );
  expect(nextCopy.plan.manifest).toEqual(expectedCopy.manifest);
  expect(nextCopy.plan.nodes).toEqual(expectedCopy.values);
  expect(nextCopy.bases).toEqual(expectedCopy.bases);
  expect(nextCopy.nodes).toEqual(expectedCopy.nodes);
  expect(nextCopy.portable.exportedAt).toBe(source.portable.exportedAt);
  const edited = structuredClone(source.portable);
  if (edited.formatVersion !== 2)
    throw Error('Keep the complete shared original.');
  edited.values[0].json += ' ';
  expect(() =>
    prepareNativeCanonicalCopy(edited, scope, link.retention.copy.id),
  ).toThrow();
  expect(() =>
    prepareNativeCanonicalCopy(
      source.portable,
      { ...scope, businessId: newInboxId() },
      link.retention.copy.id,
    ),
  ).toThrow();
  const otherId = newInboxId(),
    otherCopy = prepareNativeCanonicalCopy(source.portable, scope, otherId);
  expect(otherCopy.plan.manifest.id).toBe(otherId);
  expect(otherCopy.plan.manifest.root).toBe(expectedCopy.manifest.root);
  const freshCopy = prepareNativeCanonicalCopy(
    source.portable,
    scope,
    link.retention.copy.id,
    { fresh: true },
  );
  expect(freshCopy.plan.manifest).toEqual(expectedCopy.manifest);
  expect(freshCopy.nodes).toEqual(expectedCopy.nodes);
  const fresh = await readNativePaymentState(x.d.db);
  expect(fresh!.projection.payments).toEqual(expected);
  const wire = (await x.d.db.readCompleteBackup()).portable,
    decoded = await parseNativePaymentBackup(wire);
  expect(wire).toEqual(fresh!.wire);
  expect(wire.exportedAt).toBe(fresh!.wire.exportedAt);
  decoded.projection.payments[0].amount = 2;
  decoded.wire.values[0].json += ' ';
  expect((await parseNativePaymentBackup(wire)).projection.payments).toEqual(
    expected,
  );
  const node = (await x.d.db.nativePaymentValues.toArray())[0];
  await x.d.db.nativePaymentValues.put({ ...node, json: node.json + ' ' });
  await expect(readCanonicalState(x.d.db)).rejects.toThrow();
  await expect(x.d.db.readCompleteBackup()).rejects.toThrow();
  await x.d.db.nativePaymentValues.put(node);
  await expect(
    reviewScopeRecovery(x.d.db, {
      config,
      base: '/native-scope-install/',
      auth: f.sdk.auth,
      send: f.bridge,
    }),
  ).rejects.toMatchObject({ kind: 'review' });
  expect(await x.d.db.scopeRecoveries.count()).toBe(0);
  await expect(
    readRecoveryWorkingSource(
      x.d.db,
      before,
      (await x.d.db.operatorState.get('active'))!.revision,
    ),
  ).rejects.toThrow();
  expect((await readCanonicalState(x.d.db)).token).toBe(before.token);
  expect((await readNativePaymentState(x.d.db))!.projection.payments).toEqual(
    expected,
  );
}, 30000);
it('actual manager revocation after all original reads prevents installation and retains every downloaded source', async () => {
  const f = await fixture(),
    m = await manager(f),
    x = await nativeInstallFixture(m);
  let reads = 0,
    revoked = false;
  const load: typeof x.load = async (link) => {
      const value = await x.load!(link);
      reads++;
      return value;
    },
    refresh: typeof x.refresh = async (context) => {
      if (reads && !revoked) {
        await server.sql.query(
          'delete from public.member_outlets where member_id=$1',
          [m.managerId],
        );
        revoked = true;
      }
      return x.refresh(context);
    };
  await expect(
    joinCanonicalDevice(x.d.db, x.input, refresh, undefined, undefined, load),
  ).rejects.toThrow();
  expect(reads).toBeGreaterThan(0);
  expect(revoked).toBe(true);
  expect(await x.d.db.sales.count()).toBe(0);
  expect(await x.d.db.nativePaymentValues.count()).toBe(0);
  expect(await x.d.db.syncCanonical.count()).toBe(0);
  expect(await x.d.db.cloudState.count()).toBe(0);
  expect(await x.d.db.syncRecords.toArray()).toEqual(x.d.records);
}, 30000);
it('a fresh actual manager product controller installs after uploader Auth deletion and cold restore keeps the original owner identity', async () => {
  const f = await fixture(),
    m = await manager(f),
    window = await m.remote.begin({
      type: 'begin',
      id: newInboxId(),
      outletId: f.setup.outlet.id,
      cursor: null,
    }),
    base = '/native-manager-install-' + newInboxId() + '/',
    sessionId = copySdkSubject(302);
  await server.sql.query(
    'insert into auth.sessions(id,user_id) values($1,$2)',
    [sessionId, copySdkSubject(2)],
  );
  await server.sql.query('delete from auth.users where id=$1', [
    copySdkSubject(1),
  ]);
  const sdk = await createCopySdk(
    config,
    discoveryAuthScope(base),
    f.bridge,
    2,
    undefined,
    sessionId,
  );
  sdks.push(sdk);
  const target = new MiseDatabase('native-manager-installer-' + newInboxId()),
    cold = new MiseDatabase('native-manager-cold-' + newInboxId());
  stores.push(target, cold);
  const options = { config, base, auth: sdk.auth, send: f.bridge },
    context = {
      version: 1 as const,
      ...parseSyncScope(window),
      businessName: null,
      outletName: null,
      actorName: null,
    };
  await prepareCloudJoin(target, options, context);
  expect((await resumeCloudJoin(target, options)).phase).toBe('ready');
  const native = await readNativePaymentState(target);
  expect(
    native!.projection.actions.every(
      (a) =>
        a.source.actorId === f.setup.owner.id &&
        a.invocation.command.actorId === f.setup.owner.id,
    ),
  ).toBe(true);
  expect((await target.setup())!.owner.id).toBe(m.managerId);
  expect(native!.projection.payments[0].createdBy).toBe(f.setup.owner.id);
  expect(await target.sales.count()).toBe(1);
  const complete = (await target.readCompleteBackup()).portable,
    preview = await cold.previewRestore(complete);
  await cold.restoreBackup(complete, preview);
  expect((await readNativePaymentState(cold))!.projection.payments).toEqual(
    native!.projection.payments,
  );
  expect(await cold.sales.count()).toBe(1);
  expect(await cold.outbox.count()).toBe(0);
  expect(await cold.nativePaymentActions.count()).toBe(0);
  expect(await cold.cloudState.count()).toBe(0);
}, 60000);
