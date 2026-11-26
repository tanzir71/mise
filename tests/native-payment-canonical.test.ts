import {
  parsePortableBackup,
  createPortableBackup,
} from '../packages/core/payment-archive';
import { createHash } from 'node:crypto';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { inboxImageFile } from './inbox-fixture';
import { inboxImageBytes } from '../packages/core/inbox';
import {
  syncImageSource,
  syncImageSourceHash,
} from '../packages/core/sync-images';

import { defaultCreditTerms, creditBalance } from '../packages/core/khata';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { createCopySdk, copySdkSubject } from './fixtures/original-copy-sdk';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { createNativePaymentOutboxSession } from '../apps/web/src/data/native-payment-session';
import { createLinkedPaymentOriginalSession } from '../apps/web/src/data/original-copy-session';
import { createCloudSyncRemote } from '../apps/web/src/data/cloud-sync-remote';
import {
  prepareSyncDownload,
  runSyncDownload,
} from '../apps/web/src/data/cloud-sync-journal';
import { createShopCommandRemote } from '../apps/web/src/data/shop-command-remote';
import {
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { cloudConnectionTarget } from '../packages/core/cloud-connection';
import { operatorAccountHash } from '../packages/core/operators';
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

const config = {
    apiUrl: 'https://native-canonical.test',
    publishableKey: 'sb_publishable_canonical_test',
  },
  origin = 'https://shop.test';
let server: Awaited<ReturnType<typeof nativePaymentTestServer>>;
const stores: Dexie[] = [],
  sdks: Awaited<ReturnType<typeof createCopySdk>>[] = [],
  sessions: { stop(): void }[] = [];
beforeAll(async () => {
  server = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
  );
}, 30000);
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const s of sdks.splice(0)) await s.auth.dispose();
  for (const s of stores.splice(0)) await s.delete();
});
afterAll(async () => {
  await server.close();
});
async function fixture(
  kind: 'counter' | 'credit' | 'order' = 'counter',
  scale = false,
) {
  const db = new MiseDatabase('native-canonical-source-' + newInboxId());
  stores.push(db);
  const large = scale ? await seedPaymentStorage(db) : null;
  const setup =
    large?.setup ??
    (await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Canonical originals',
      phone: '01712345482',
    }));
  let accountId: string | undefined = large?.account.id;
  if (kind === 'credit' && !large) {
    const customer = await db.saveCustomer(
      {
        name: 'Original customer',
        nickname: 'Apa',
        phone: '01712345482',
        address: '',
        notes: '',
        tags: [],
      },
      {
        credit: { ...defaultCreditTerms, allowed: true, limit: 200000 },
        opening: { amount: 100000, occurredAt: Date.now() },
      },
    );
    accountId = (await db.creditAccounts
      .where('customerId')
      .equals(customer.id)
      .first())!.id;
  }
  const order =
    kind === 'order'
      ? await db.saveOrder({
          source: 'phone',
          sourceText: 'Original unpaid order',
          name: 'Customer',
          phone: '01712345482',
          type: 'pickup',
          address: '',
          table: '',
          lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 1525 }],
          deliveryFee: 0,
          discount: 0,
          payment: { method: 'cash' },
        })
      : null;
  const item = await db.captureInbox({
    text: 'DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be',
    ...(large ? { files: [inboxImageFile()] } : {}),
  });
  await server.seed(await db.readBackup());
  const bridge: typeof fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    return server.handle(new Request(url, { ...init, headers }));
  };
  const authScope = 'canonical/' + db.name,
    sdk = await createCopySdk(config, authScope, bridge);
  sdks.push(sdk);
  const targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    ),
    uploadId = newInboxId();
  await db.cloudState.put({
    id: 'binding',
    version: 1,
    uploadId,
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    ownerId: setup.owner.id,
    targetHash,
    manifestHash: 'b'.repeat(64),
    phase: 'ready',
    sequence: 0,
    receipt: {
      id: uploadId,
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      snapshotHash: 'c'.repeat(64),
      at: Date.now(),
      records: 3,
      images: 0,
    },
  });
  const journal = new OriginalCopyJournal(
    'native-canonical-copies-' + newInboxId(),
  );
  stores.push(journal);
  const send: typeof fetch = (url, init) =>
    new URL(String(url)).pathname.startsWith('/functions/')
      ? bridge(url, init)
      : sdk.send(url, init);
  const options = {
      config,
      authScope,
      auth: sdk.auth,
      storage: sdk.storage,
      journal,
      send,
    },
    session = await createNativePaymentOutboxSession(db, options);
  sessions.push(session);
  const remote = createCloudSyncRemote(
    config,
    async () => (await sdk.auth.commandAuthorization()).jwt,
    send,
  );
  const sources = await createLinkedPaymentOriginalSession(options, {
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
  });
  sessions.push(sources);
  const commands = createShopCommandRemote(
    config.apiUrl,
    config.publishableKey,
    {
      scope: authScope,
      accountHash: await operatorAccountHash(sdk.saved.user.id),
      targetHash,
      getAuth: () => sdk.auth.commandAuthorization(),
      assertCurrent: (v) => sdk.auth.assertCommandAuthorization(v),
    },
    send,
  );
  const review = await session.review(item.id, { sender: 'DBBL' });
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: 'TESTCANONICAL' + item.id,
    receivedAt: item.createdAt,
  });
  const recorded = await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(
      db,
      review,
      order
        ? { kind: 'order', id: order.id }
        : accountId
          ? { kind: 'credit', id: accountId }
          : { kind: 'counter', who: 'Exact original' },
    ),
    true,
  );
  await session.deliver();
  return {
    db,
    setup,
    item,
    sdk,
    session,
    remote,
    sources,
    commands: {
      async apply(...args: Parameters<typeof commands.apply>) {
        try {
          return await commands.apply(
            args[0],
            args[1] ?? setup.outlet.currency,
            args[2],
            args[3],
          );
        } catch (error) {
          throw Error(String(error) + ' ' + server.lastError());
        }
      },
    },
    recorded,
    review,
    targetHash,
    options,
    large,
    bridge,
    accountId,
    order,
  };
}
async function download(
  f: Awaited<ReturnType<typeof fixture>>,
  previous: NativeCanonicalRead | null = null,
) {
  const window = await f.remote.begin({
    type: 'begin',
    id: newInboxId(),
    outletId: f.setup.outlet.id,
    cursor: previous?.cursor ?? null,
  });
  const db = new MiseDatabase('native-canonical-target-' + newInboxId());
  stores.push(db);
  const target = {
    targetHash: f.targetHash,
    businessId: window.businessId,
    outletId: window.outletId,
    actorId: window.actorId,
    accountHash: window.accountHash,
    role: window.role,
  };
  await prepareSyncDownload(db, {
    id: window.id,
    target,
    previousCursor: previous?.cursor ?? null,
  });
  const state = await runSyncDownload(db, window.id, target, f.remote),
    records = await db.syncRecords.toArray();
  const read = () =>
    reconstructNativeCanonicalRead(
      state,
      records,
      [],
      (link) => f.sources.read(link.id),
      previous,
    );
  return { db, state, records, read };
}
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

async function manager(f: Awaited<ReturnType<typeof fixture>>) {
  const managerId = newInboxId();
  await server.sql.query(
    "insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,'manager',$5,$5)",
    [
      managerId,
      f.setup.business.id,
      copySdkSubject(2),
      JSON.stringify('Current manager'),
      Date.now(),
    ],
  );
  await server.sql.query('insert into public.member_outlets values($1,$2,$3)', [
    f.setup.business.id,
    managerId,
    f.setup.outlet.id,
  ]);
  const authScope = 'canonical-manager/' + newInboxId(),
    sdk = await createCopySdk(config, authScope, f.bridge, 2);
  sdks.push(sdk);
  const targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    ),
    journal = new OriginalCopyJournal(
      'canonical-manager-journal-' + newInboxId(),
    );
  stores.push(journal);
  const send: typeof fetch = (url, init) =>
    new URL(String(url)).pathname.startsWith('/functions/')
      ? f.bridge(url, init)
      : sdk.send(url, init);
  const sources = await createLinkedPaymentOriginalSession(
    {
      ...f.options,
      authScope,
      auth: sdk.auth,
      storage: sdk.storage,
      journal,
      send,
    },
    {
      businessId: f.setup.business.id,
      outletId: f.setup.outlet.id,
      actorId: managerId,
    },
  );
  sessions.push(sources);
  const remote = createCloudSyncRemote(
    config,
    async () => (await sdk.auth.commandAuthorization()).jwt,
    send,
  );
  return { ...f, sdk, remote, sources, targetHash, managerId };
}
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
