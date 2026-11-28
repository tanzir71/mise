import 'fake-indexeddb/auto';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { nativePaymentCopyJournalName } from '../apps/web/src/data/native-payment-review-session';
import { createNativePaymentOutboxSession } from '../apps/web/src/data/native-payment-session';
import { runSyncCycle } from '../apps/web/src/data/sync-cycle';
import { requestSync } from '../apps/web/src/data/sync-session';
import { syncWaitingCount } from '../apps/web/src/data/native-payment-sync-source';
import { readCanonicalState } from '../apps/web/src/data/cloud-canonical-state';
import { readNativePaymentState } from '../apps/web/src/data/native-payment-state';
import { readRetainedPaymentOriginals } from '../apps/web/src/data/payment-original-retention';
import { backupFile } from '../apps/web/src/data/export-files';
import { paymentOriginalReader } from '../packages/core/payment-originals';
import {
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import { readPaymentReviewFrame } from '../apps/web/src/data/payment-review';
import { openConfiguredPaymentSource } from '../apps/web/src/data/payment-review-session';
import {
  prepareSyncWaitingProof,
  assertSyncWaitingProof,
} from '../apps/web/src/data/native-payment-sync-source';
import { saveCloudConnection } from '../packages/core/cloud-connection';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { uploadNativePaymentFixture } from './fixtures/native-payment-upload';
const config = {
    apiUrl: 'https://native-reconcile.test',
    publishableKey: 'sb_publishable_reconcile_test',
  },
  origin = 'https://shop.test';
let server: Awaited<ReturnType<typeof nativePaymentTestServer>>;
const cleanup: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  server = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
  );
}, 30000);
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await server?.close();
});
async function fixture(capture = true) {
  const db = new MiseDatabase('native-reconcile-' + newInboxId());
  cleanup.push(() => db.delete());
  const setup = await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'End-user native sync',
      phone: '01712345482',
    }),
    item = await db.captureInbox({ text: 'Received Tk 15.25\0\ud800 বাংলা' }),
    scope = '/app/' + setup.business.id;
  const actions: string[] = [];
  const send: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    const action = headers.get('X-Mise-Original-Action');
    if (action) actions.push(action);
    headers.set('Origin', origin);
    return server.handle(new Request(url, { ...init, headers }));
  };
  const f = await uploadNativePaymentFixture(db, config, scope, send);
  const journal = new OriginalCopyJournal(nativePaymentCopyJournalName(db)),
    session = await createNativePaymentOutboxSession(db, {
      config,
      authScope: scope,
      auth: f.sdk.auth,
      storage: f.sdk.storage,
      journal,
      send,
    }),
    frame = await readPaymentReviewFrame(db, setup, item.id),
    opened = await openConfiguredPaymentSource(
      db,
      setup,
      item.id,
      frame.key,
      {},
      { storage: f.sdk.storage, auth: f.sdk.auth, send, base: '/app/' },
    ),
    review = opened.review;
  cleanup.push(async () => {
    opened.stop();
    session.stop();
    await f.sdk.auth.dispose();
    await journal.delete();
    await f.journal.delete();
  });
  if (capture) {
    await recordSavedPayment(db, review, {
      checked: true,
      amount: 1525,
      currency: 'BDT',
      method: 'cash',
      methodName: 'Cash',
      reference: 'Original canonical receipt',
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
  }
  return {
    ...f,
    db,
    setup,
    item,
    session,
    copies: journal,
    send,
    scope,
    review,
    actions,
  };
}
it('a real initial upload and original native queue reach one accepted cursor without legacy receipts or repeated money', async () => {
  const f = await fixture();
  await f.db.saveCustomer({
    name: 'After native payment',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const original = (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.original,
      r.originalHash,
    ]),
    markers = (await f.db.outbox.toArray()).filter(
      (r) => r.status === 'retained',
    ),
    money = literalToken(await f.db.sales.toArray());
  await requestSync(f.db, true);
  const completed = await runSyncCycle(f.db, {
    config,
    scope: f.scope,
    auth: f.sdk.auth,
    storage: f.sdk.storage,
    journal: f.journal,
    send: f.send,
  });
  expect(
    completed,
    JSON.stringify(await f.db.syncSessions.get('active')) +
      ' ' +
      server.lastError(),
  ).toBe(true);
  const canonical = await readCanonicalState(f.db),
    native = await readNativePaymentState(f.db),
    state = (await f.db.syncSessions.get('active'))!;
  expect(native!.projection.payments).toHaveLength(1);
  expect(native!.projection.actions).toHaveLength(2);
  expect(await f.db.payments.count()).toBe(0);
  expect(literalToken(await f.db.sales.toArray())).toBe(money);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(await f.db.customers.count()).toBe(1);
  expect(await syncWaitingCount(f.db)).toBe(0);
  expect(state.confirmed).toBe(state.requested);
  expect(state.lastConfirmedAt).not.toBeNull();
  expect(canonical.base.snapshot.cursor).toBeTruthy();
  expect(f.actions).toContain('read');
  expect(f.actions).toContain('payment-inspect');
  expect(f.actions).not.toContain('payment-read');
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.original,
      r.originalHash,
    ]),
  ).toEqual(original);
  expect(
    (await f.db.outbox.toArray()).filter((r) => r.status === 'retained'),
  ).toEqual(markers);
  expect(
    (await f.db.nativePaymentActions.toArray()).every(
      (r) => r.state === 'applied',
    ),
  ).toBe(true);
  await f.db.recordSale({
    expression: '3',
    method: 'cash',
    who: 'Ordinary cash after native adoption',
  });
  await requestSync(f.db, true);
  expect(
    await runSyncCycle(f.db, {
      config,
      scope: f.scope,
      auth: f.sdk.auth,
      storage: f.sdk.storage,
      journal: f.journal,
      send: f.send,
    }),
  ).toBe(true);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(2);
  expect(await syncWaitingCount(f.db)).toBe(0);
}, 60000);

it('verified delivered bytes remain private and cannot outlive their actual connection', async () => {
  const f = await fixture();
  await f.session.deliver();
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  const link = (await readNativePaymentState(f.db))!.projection.actions[0]
      .source,
    first = (await f.session.readDeliveredOriginal(link))!;
  expect(first).not.toBeNull();
  first.portable.exportedAt++;
  const second = (await f.session.readDeliveredOriginal(link))!;
  expect(second.portable.exportedAt).not.toBe(first.portable.exportedAt);
  expect(
    await f.session.readDeliveredOriginal({
      ...link,
      linkedAt: link.linkedAt + 1,
    }),
  ).toBeNull();
  saveCloudConnection(f.sdk.storage, {
    ...config,
    apiUrl: 'https://changed-installation.test',
  });
  await expect(f.session.readDeliveredOriginal(link)).rejects.toThrow();
  saveCloudConnection(f.sdk.storage, config);
  await expect(f.session.readDeliveredOriginal(link)).rejects.toThrow();
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
}, 60000);
it('cached delivered source cannot bypass a fresh backend original inspection after revocation', async () => {
  const f = await fixture();
  let inspected = false;
  const send: typeof fetch = async (url, init) => {
    if (
      new Headers(init?.headers).get('X-Mise-Original-Action') ===
      'payment-inspect'
    ) {
      inspected = true;
      await server.sql.query(
        'update public.members set active=false where id=$1',
        [f.setup.owner.id],
      );
    }
    return f.send(url, init);
  };
  await requestSync(f.db, true);
  expect(await cycle(f, send)).toBe(false);
  expect(inspected).toBe(true);
  expect(await f.db.syncCanonical.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(1);
  expect(await syncWaitingCount(f.db)).toBeGreaterThan(0);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
}, 60000);

const cycle = (
  f: Awaited<ReturnType<typeof fixture>>,
  send = f.send,
  signal?: AbortSignal,
) =>
  runSyncCycle(
    f.db,
    {
      config,
      scope: f.scope,
      auth: f.sdk.auth,
      storage: f.sdk.storage,
      journal: f.journal,
      send,
    },
    signal,
  );

it('local preparation retains the same approvals without HTTP delivery, a lease or backend money', async () => {
  const f = await fixture(),
    before = (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.originalHash,
    ]),
    calls = f.actions.slice();
  await f.session.prepare();
  expect(f.actions).toEqual(calls);
  expect((await f.db.syncSessions.get('active'))!.lease).toBeNull();
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.originalHash,
    ]),
  ).toEqual(before);
  expect(
    (await f.db.nativePaymentActions.toArray()).every(
      (r) => r.seal && !r.copyReceipt && !r.nativeReceipt,
    ),
  ).toBe(true);
  expect(await f.copies.copies.count()).toBe(1);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(0);
}, 60000);
it('a queued native writer cannot deadlock complete original snapshot preparation', async () => {
  const f = await fixture(),
    prepare = f.copies.prepare.bind(f.copies);
  let queued: Promise<unknown> | undefined,
    committed = false;
  const spy = vi
    .spyOn(f.copies, 'prepare')
    .mockImplementationOnce((...args) => {
      queued = Dexie.ignoreTransaction(() =>
        f.db.transaction('rw', f.db.cloudState, async () => {
          await f.db.cloudState.get('binding');
          committed = true;
        }),
      );
      expect(committed).toBe(false);
      return prepare(...args);
    });
  try {
    await f.session.prepare();
    await queued;
  } finally {
    spy.mockRestore();
  }
  expect(committed).toBe(true);
  expect(await f.copies.copies.count()).toBe(1);
  expect(
    (await f.db.nativePaymentActions.toArray()).every(
      (r) => r.seal && !r.copyReceipt && !r.nativeReceipt,
    ),
  ).toBe(true);
}, 60000);
it('a selection changed after snapshot capture cannot commit a private original copy', async () => {
  const f = await fixture(),
    prepare = f.copies.prepare.bind(f.copies),
    selection = (await f.db.operatorState.get('active'))!;
  const spy = vi
    .spyOn(f.copies, 'prepare')
    .mockImplementationOnce(async (...args) => {
      await f.db.operatorState.put({
        ...selection,
        revision: selection.revision + 1,
      });
      return prepare(...args);
    });
  try {
    await expect(f.session.prepare()).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(await f.copies.copies.count()).toBe(0);
  expect(await f.copies.values.count()).toBe(0);
  expect(
    (await f.db.nativePaymentActions.toArray()).every(
      (r) => !r.nativeReceipt && !r.copyReceipt,
    ),
  ).toBe(true);
}, 60000);
it('a lost actual money response retries the original invocation and confirms one financial receipt', async () => {
  const f = await fixture();
  let lost = false;
  const send: typeof fetch = async (url, init) => {
    const response = await f.send(url, init);
    if (
      !lost &&
      new URL(String(url)).pathname === '/functions/v1/native-payment' &&
      JSON.parse(String(init?.body)).command.type === 'payment.record' &&
      response.ok
    ) {
      lost = true;
      throw Error('Lost original money response');
    }
    return response;
  };
  await requestSync(f.db, true);
  expect(await cycle(f, send)).toBe(false);
  expect(lost).toBe(true);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(await f.db.syncCanonical.count()).toBe(0);
  expect(await syncWaitingCount(f.db)).toBeGreaterThan(0);
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(await syncWaitingCount(f.db)).toBe(0);
  expect(
    (await f.db.outbox.toArray())
      .filter((r) => r.status === 'retained')
      .every((r) => !r.commands.length && !r.receipts.length),
  ).toBe(true);
}, 60000);
it('an interrupted owner after backend money commit preserves unconfirmed originals and recovers on the same queue', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let interrupted = false;
  const send: typeof fetch = async (url, init) => {
    const response = await f.send(url, init);
    if (
      !interrupted &&
      new URL(String(url)).pathname === '/functions/v1/native-payment' &&
      JSON.parse(String(init?.body)).command.type === 'payment.record' &&
      response.ok
    ) {
      interrupted = true;
      controller.abort();
    }
    return response;
  };
  const original = literalToken(
    (await f.db.nativePaymentActions.toArray()).map((r) => r.original),
  );
  await requestSync(f.db, true);
  expect(await cycle(f, send, controller.signal)).toBe(false);
  expect(await f.db.syncCanonical.count()).toBe(0);
  expect(await syncWaitingCount(f.db)).toBeGreaterThan(0);
  expect(
    literalToken(
      (await f.db.nativePaymentActions.toArray()).map((r) => r.original),
    ),
  ).toBe(original);
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  expect(
    (
      await server.sql.query('select id from public.sales where outlet_id=$1', [
        f.setup.outlet.id,
      ])
    ).rows,
  ).toHaveLength(1);
}, 60000);
it('a failed canonical writer preserves both planes and accepts the same completed native queue on retry', async () => {
  const f = await fixture(),
    before = literalToken(await f.db.sales.toArray());
  const reject = () => {
    throw new DOMException('Synthetic disk quota', 'QuotaExceededError');
  };
  f.db.nativePaymentState.hook('creating', reject);
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(false);
  expect(await f.db.syncCanonical.count()).toBe(0);
  expect(await f.db.nativePaymentValues.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(1);
  expect(literalToken(await f.db.sales.toArray())).toBe(before);
  f.db.nativePaymentState.hook('creating').unsubscribe(reject);
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  expect(await f.db.payments.count()).toBe(0);
  expect(await syncWaitingCount(f.db)).toBe(0);
}, 60000);
it('a stale or serialized waiting proof cannot confirm changed originals or an altered accepted base', async () => {
  const f = await fixture();
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  const proof = await prepareSyncWaitingProof(f.db),
    row = (await f.db.nativePaymentActions.toArray())[0];
  await expect(
    f.db.transaction('rw', f.db.tables, () =>
      assertSyncWaitingProof(f.db, { ...proof }),
    ),
  ).rejects.toThrow();
  await f.db.nativePaymentActions.update(row.id, {
    originalHash: '0'.repeat(64),
  });
  await expect(
    f.db.transaction('rw', f.db.tables, () =>
      assertSyncWaitingProof(f.db, proof),
    ),
  ).rejects.toThrow();
  expect(await syncWaitingCount(f.db)).toBeGreaterThan(0);
  await f.db.nativePaymentActions.put(row);
  const current = await prepareSyncWaitingProof(f.db),
    base = (await f.db.syncCanonical.get('active'))!;
  await f.db.syncCanonical.put({
    ...base,
    snapshot: { ...base.snapshot, cursor: 'changed accepted cursor' },
  });
  await expect(
    f.db.transaction('rw', f.db.tables, () =>
      assertSyncWaitingProof(f.db, current),
    ),
  ).rejects.toThrow();
  expect(await syncWaitingCount(f.db)).toBeGreaterThan(0);
}, 60000);
it('a checked private copy still rejects changed stored bytes and owns each returned manifest', async () => {
  const f = await fixture();
  await f.session.prepare();
  const row = (await f.copies.copies.toArray())[0],
    identity = f.session.identity,
    first = (await f.copies.prepared(row.id, identity, () => {}))!;
  first.id = newInboxId();
  expect((await f.copies.prepared(row.id, identity, () => {}))!.id).toBe(
    row.id,
  );
  const value = (await f.copies.values.toArray())[0];
  await f.copies.values.put({ ...value, json: 'changed original bytes' });
  await expect(f.copies.prepared(row.id, identity, () => {})).rejects.toThrow();
  await f.copies.values.put(value);
  expect((await f.copies.prepared(row.id, identity, () => {}))!.id).toBe(
    row.id,
  );
}, 60000);
it('a checked archive still validates actual stored bytes and returns independent original nodes', async () => {
  const f = await fixture();
  await f.session.prepare();
  const current = await f.db.readBackup(),
    first = await readRetainedPaymentOriginals(f.db, current),
    original = first.nodes[0].json;
  const source = paymentOriginalReader(
      first.bases[0],
      (key) => first.nodes.find((n) => n.digest === key)?.json,
    ),
    ref = (await f.db.nativePaymentActions.toArray())[0].seal!.ref,
    originalText = source.read(ref).source.text;
  source.snapshot.tables.inboxItems[0].text = 'mutated snapshot';
  expect(source.read(ref).source.text).toBe(originalText);
  Object.assign(first.nodes[0], { json: 'mutated returned original' });
  expect(
    (await readRetainedPaymentOriginals(f.db, current)).nodes[0].json,
  ).toBe(original);
  const value = (await f.db.paymentOriginalValues.toArray())[0];
  await f.db.paymentOriginalValues.put({
    ...value,
    json: 'changed stored bytes',
  });
  await expect(readRetainedPaymentOriginals(f.db, current)).rejects.toThrow();
  await f.db.paymentOriginalValues.put(value);
  expect(
    (await readRetainedPaymentOriginals(f.db, current)).nodes[0].json,
  ).toBe(original);
}, 60000);
it('an exact native file review survives failed writes but cannot restore a changed file', async () => {
  const f = await fixture();
  await requestSync(f.db, true);
  expect(await cycle(f)).toBe(true);
  const wire = await backupFile(
      (await f.db.readCompleteBackup()).portable,
    ).text(),
    cold = new MiseDatabase('native-reviewed-file-' + newInboxId());
  cleanup.push(() => cold.delete());
  const review = await cold.previewRestore(wire),
    reject = (_key: unknown, row: { who?: string }) => {
      row.who = 'mutated failed write';
      throw new DOMException('Native restore quota', 'QuotaExceededError');
    };
  cold.sales.hook('creating', reject);
  try {
    await expect(cold.restoreBackup(wire, review)).rejects.toThrow(
      'Native restore quota',
    );
  } finally {
    cold.sales.hook('creating').unsubscribe(reject);
  }
  expect(await cold.sales.count()).toBe(0);
  expect(await cold.nativePaymentValues.count()).toBe(0);
  await cold.restoreBackup(wire, review);
  expect(await cold.sales.toArray()).toEqual(await f.db.sales.toArray());
  expect(
    (await readNativePaymentState(cold))!.projection.payments,
  ).toHaveLength(1);
  const next = await cold.previewRestore(wire),
    changed = JSON.parse(wire);
  changed.values[0].json = 'changed native source';
  await expect(
    cold.restoreBackup(JSON.stringify(changed), next),
  ).rejects.toThrow();
  expect(
    (await readNativePaymentState(cold))!.projection.payments,
  ).toHaveLength(1);
  expect(await cold.nativePaymentActions.count()).toBe(0);
  expect(await cold.outbox.count()).toBe(0);
}, 60000);
it('configuration and account proof changes never grant a connected payment write capability', async () => {
  const f = await fixture(false),
    frame = await readPaymentReviewFrame(f.db, f.setup, f.item.id),
    connection = {
      storage: f.sdk.storage,
      auth: f.sdk.auth,
      send: f.send,
      base: '/app/',
    };
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    openConfiguredPaymentSource(
      f.db,
      f.setup,
      f.item.id,
      frame.key,
      {},
      connection,
      aborted.signal,
    ),
  ).rejects.toThrow();
  await expect(
    openConfiguredPaymentSource(
      f.db,
      f.setup,
      f.item.id,
      frame.key + 'stale',
      {},
      connection,
    ),
  ).rejects.toThrow();
  saveCloudConnection(f.sdk.storage, {
    ...config,
    apiUrl: 'https://changed-installation.test',
  });
  await expect(
    openConfiguredPaymentSource(
      f.db,
      f.setup,
      f.item.id,
      frame.key,
      {},
      connection,
    ),
  ).rejects.toThrow();
  saveCloudConnection(f.sdk.storage, config);
  await f.sdk.auth.close();
  await expect(
    openConfiguredPaymentSource(
      f.db,
      f.setup,
      f.item.id,
      frame.key,
      {},
      connection,
    ),
  ).rejects.toThrow();
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(0);
  expect(await f.db.sales.count()).toBe(0);
}, 60000);
