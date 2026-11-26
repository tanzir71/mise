import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { readNativePaymentQueue } from '../apps/web/src/data/native-payment-review';
import {
  continueNativePaymentQueue,
  nativePaymentCopyJournalName,
} from '../apps/web/src/data/native-payment-review-session';
import {
  claimPausedSyncSession,
  sessionLease,
  assertPausedSyncSession,
  releaseSyncSession,
  claimSyncSession,
  requestSync,
} from '../apps/web/src/data/sync-session';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { prepareNativeOwnerQueue } from './fixtures/native-payment-owner';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import { saveCloudConnection } from '../packages/core/cloud-connection';
import { backupFile } from '../apps/web/src/data/export-files';
import type { NativePaymentOutboxEntry } from '../packages/core/native-payment-outbox';
const config = {
    apiUrl: 'https://edge.test',
    publishableKey: 'sb_publishable_owner_queue_test',
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
beforeEach(async () => {
  await server.sql.exec(
    'truncate public.businesses cascade;truncate private.native_payment_actions,private.native_payment_events,private.native_payment_write_tickets,private.native_original_copies,private.native_original_nodes,private.native_original_parts,private.native_original_membership,private.native_original_budgets cascade',
  );
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => {
  await server?.close();
});
async function fixture() {
  const db = new MiseDatabase('owner-queue-' + newInboxId());
  cleanup.push(() => db.delete());
  const setup = await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Installation-owned queue',
      phone: '01712345482',
    }),
    item = await db.captureInbox({
      text: 'Unknown received Tk 15.25\0\ud800 বাংলা',
    });
  await server.seed(await db.readBackup());
  const calls: string[] = [];
  let after:
    ((request: Request, response: Response) => Promise<Response>) | undefined;
  const send: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', origin);
    const request = new Request(url, { ...init, headers }),
      path = new URL(request.url).pathname;
    if (
      path === '/functions/v1/native-payment' ||
      path === '/functions/v1/commands'
    )
      calls.push(
        JSON.parse(await request.clone().text()).command?.type ??
          JSON.parse(await request.clone().text()).type,
      );
    const retained = request.clone(),
      response = await server.handle(request);
    return after ? after(retained, response) : response;
  };
  const f = await prepareNativeOwnerQueue(
    db,
    setup,
    item,
    config,
    '/app/' + setup.business.id,
    send,
  ).catch((error) => {
    throw Error(String(error) + ' ' + server.lastError());
  });
  cleanup.push(async () => {
    f.session.stop();
    await f.sdk.auth.dispose();
    f.journal.close();
    await new OriginalCopyJournal(nativePaymentCopyJournalName(db)).delete();
  });
  const options = {
    ...f.options,
    setup,
    expectedToken: (await readNativePaymentQueue(db, setup)).token,
  };
  f.session.stop();
  return {
    ...f,
    db,
    setup,
    item,
    options,
    calls,
    setAfter: (fn: typeof after) => {
      after = fn;
    },
  };
}
it('foreground delivery uses actual approvals in global order without confirming a cursor or rewriting money', async () => {
  const f = await fixture();
  await f.db.saveCustomer({
    name: 'Later owner action',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const before = await readNativePaymentQueue(f.db, f.setup),
    rows = await f.db.nativePaymentActions.toArray(),
    money = literalToken(await f.db.sales.toArray()),
    state = (await f.db.syncSessions.get('active'))!;
  expect(before.canContinue).toBe(true);
  expect(before.rows.map((r) => r.status)).toEqual([
    'Awaiting connected result',
    'Awaiting connected result',
  ]);
  const result = await continueNativePaymentQueue(f.db, {
    ...f.options,
    expectedToken: before.token,
  });
  expect(result.result.blockedEntryId, server.lastError()).toBeNull();
  expect(f.calls).toEqual([
    'payment.capture',
    'payment.record',
    'customer.create',
  ]);
  expect(result.queue.rows.map((r) => r.status)).toEqual([
    'Original result saved',
    'Original result saved',
  ]);
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
    ]),
  ).toEqual(rows.map((r) => [r.original, r.originalHash]));
  expect(literalToken(await f.db.sales.toArray())).toBe(money);
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  expect(await f.db.outbox.where('status').equals('retained').count()).toBe(2);
  expect(await f.db.syncSessions.get('active')).toEqual({
    ...state,
    paused: true,
    lease: null,
  });
  expect(await f.db.syncCanonical.count()).toBe(0);
}, 30000);
it('a lost actual money reply remains uncertain and a reopened production copy journal recovers one original outcome', async () => {
  const f = await fixture();
  let lost = false;
  f.setAfter(async (request, response) => {
    if (
      !lost &&
      new URL(request.url).pathname === '/functions/v1/native-payment' &&
      JSON.parse(await request.clone().text()).command.type ===
        'payment.record' &&
      response.ok
    ) {
      lost = true;
      throw new TypeError('Lost reply after actual commit');
    }
    return response;
  });
  await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow();
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  let view = await readNativePaymentQueue(f.db, f.setup);
  expect(view.rows.map((r) => r.status)).toEqual([
    'Original result saved',
    'Awaiting connected result',
  ]);
  const original = (await f.db.nativePaymentActions.toArray()).map((r) => [
    r.original,
    r.originalHash,
    r.seal,
  ]);
  f.journal.close();
  f.db.close();
  await f.db.open();
  f.setAfter(undefined);
  view = await readNativePaymentQueue(f.db, f.setup);
  const resumed = await continueNativePaymentQueue(f.db, {
    ...f.options,
    expectedToken: view.token,
  });
  expect(resumed.queue.rows.every((r) => r.state === 'applied')).toBe(true);
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
      r.seal,
    ]),
  ).toEqual(original);
  expect((await f.db.syncSessions.get('active'))!.paused).toBe(true);
}, 30000);
it('a stale review token cannot pause or send the changed queue', async () => {
  const f = await fixture();
  await requestSync(f.db, true);
  const before = await f.db.syncSessions.get('active');
  await f.db.saveCustomer({
    name: 'New approved action',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  // Ordinary later work changes the reviewed shared ordering.
  await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow();
  expect(await f.db.syncSessions.get('active')).toEqual(before);
  expect(f.calls).toEqual([]);
}, 30000);
it('foreground ownership excludes active background and other foreground leases; normal sync remains paused', async () => {
  const f = await fixture(),
    first = await claimPausedSyncSession(f.db, newInboxId(), Date.now());
  expect(first).not.toBeNull();
  await expect(
    continueNativePaymentQueue(f.db, f.options),
  ).rejects.toMatchObject({ kind: 'retry' });
  expect(
    await claimPausedSyncSession(f.db, newInboxId(), Date.now()),
  ).toBeNull();
  expect(await claimSyncSession(f.db, newInboxId(), Date.now())).toBeNull();
  expect(f.calls).toEqual([]);
  await releaseSyncSession(f.db, sessionLease(first!));
  await requestSync(f.db, true);
  const background = await claimSyncSession(f.db, newInboxId(), Date.now());
  expect(background).not.toBeNull();
  await expect(
    continueNativePaymentQueue(f.db, f.options),
  ).rejects.toMatchObject({ kind: 'retry' });
  expect((await f.db.syncSessions.get('active'))!.lease!.id).toBe(
    background!.lease!.id,
  );
  await releaseSyncSession(f.db, sessionLease(background!));
}, 30000);
it('stopping after the server commits keeps the uncertain original and a later explicit retry cannot duplicate money', async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.setAfter(async (request, response) => {
    if (
      new URL(request.url).pathname === '/functions/v1/native-payment' &&
      JSON.parse(await request.clone().text()).command.type ===
        'payment.record' &&
      response.ok
    )
      controller.abort();
    return response;
  });
  await expect(
    continueNativePaymentQueue(f.db, f.options, controller.signal),
  ).rejects.toThrow();
  expect((await readNativePaymentQueue(f.db, f.setup)).rows.at(-1)!.state).toBe(
    'pending',
  );
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  f.setAfter(undefined);
  const fresh = await readNativePaymentQueue(f.db, f.setup);
  await continueNativePaymentQueue(f.db, {
    ...f.options,
    expectedToken: fresh.token,
  });
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
}, 30000);
it('lease withdrawal after an accepted reply prevents local acknowledgement and leaves the saved original recoverable', async () => {
  const f = await fixture();
  let withdrew = false;
  f.setAfter(async (request, response) => {
    if (
      !withdrew &&
      new URL(request.url).pathname === '/functions/v1/native-payment' &&
      response.ok
    ) {
      withdrew = true;
      const s = (await f.db.syncSessions.get('active'))!;
      await releaseSyncSession(f.db, sessionLease(s));
    }
    return response;
  });
  await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow();
  expect((await readNativePaymentQueue(f.db, f.setup)).rows[0].state).toBe(
    'pending',
  );
  f.setAfter(undefined);
  const fresh = await readNativePaymentQueue(f.db, f.setup);
  await continueNativePaymentQueue(f.db, {
    ...f.options,
    expectedToken: fresh.token,
  });
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
}, 30000);
it('changed installation credentials deny sends and original rows survive', async () => {
  const f = await fixture(),
    before = literalToken(await f.db.nativePaymentActions.toArray());
  saveCloudConnection(f.sdk.storage, {
    ...config,
    apiUrl: 'https://other.test',
  });
  await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(literalToken(await f.db.nativePaymentActions.toArray())).toBe(before);
}, 30000);
it('paused lease validation refuses expiry and cannot resume normal synchronization', async () => {
  const f = await fixture(),
    s = await claimPausedSyncSession(f.db, newInboxId(), Date.now() - 46000);
  await expect(
    assertPausedSyncSession(f.db, sessionLease(s!)),
  ).rejects.toThrow();
  expect(await claimSyncSession(f.db, newInboxId(), Date.now())).toBeNull();
}, 30000);
it('a private acknowledgement quota failure keeps the original uncertain and retries one actual money receipt', async () => {
  const f = await fixture(),
    original = (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
    ]);
  const fail = (mods: object, _id: unknown, row: NativePaymentOutboxEntry) => {
    if (
      row.original.invocation.command.type === 'payment.record' &&
      'nativeReceipt' in mods &&
      mods.nativeReceipt
    )
      throw new DOMException('Private queue quota', 'QuotaExceededError');
  };
  f.db.nativePaymentActions.hook('updating', fail);
  try {
    await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow(
      'Private queue quota',
    );
  } finally {
    f.db.nativePaymentActions.hook('updating').unsubscribe(fail);
  }
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  const fresh = await readNativePaymentQueue(f.db, f.setup);
  expect(fresh.rows.at(-1)!.state).toBe('pending');
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
    ]),
  ).toEqual(original);
  await continueNativePaymentQueue(f.db, {
    ...f.options,
    expectedToken: fresh.token,
  });
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
}, 30000);
it('an unconfirmed SDK phone cannot turn saved approvals into financial requests', async () => {
  const f = await fixture(),
    original = (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
    ]);
  f.sdk.setConfirmed(false);
  await expect(continueNativePaymentQueue(f.db, f.options)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  const rows = await f.db.nativePaymentActions.toArray();
  expect(rows.map((r) => [r.original, r.originalHash])).toEqual(original);
  expect(
    rows.every(
      (r) =>
        r.state === 'pending' &&
        r.nativeReceipt === null &&
        r.copyReceipt === null,
    ),
  ).toBe(true);
}, 30000);
it('an actual concurrent source archive becomes original review without rebasing or sending later work', async () => {
  const f = await fixture();
  await f.db.saveCustomer({
    name: 'Blocked after original conflict',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const original = (await f.db.nativePaymentActions.toArray()).map((r) => [
    r.original,
    r.originalHash,
  ]);
  let changed = false;
  f.setAfter(async (request, response) => {
    if (
      !changed &&
      new URL(request.url).pathname === '/functions/v1/native-payment' &&
      JSON.parse(await request.clone().text()).command.type ===
        'payment.capture' &&
      response.ok
    ) {
      changed = true;
      const archived = await server.handle(
        new Request(config.apiUrl + '/functions/v1/commands', {
          method: 'POST',
          headers: {
            Origin: origin,
            Authorization: 'Bearer ' + f.sdk.access,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: newInboxId(),
            type: 'inbox.change',
            itemId: f.item.id,
            outletId: f.setup.outlet.id,
            occurredAt: Date.now(),
            revision: f.item.revision,
            change: { archived: true },
          }),
        }),
      );
      expect(archived.status, server.lastError()).toBe(200);
    }
    return response;
  });
  const fresh = await readNativePaymentQueue(f.db, f.setup);
  await expect(
    continueNativePaymentQueue(f.db, {
      ...f.options,
      expectedToken: fresh.token,
    }),
  ).rejects.toMatchObject({ kind: 'review' });
  expect(
    (await readNativePaymentQueue(f.db, f.setup)).rows.at(-1)!.status,
  ).toBe('Needs original review');
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => [
      r.original,
      r.originalHash,
    ]),
  ).toEqual(original);
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(0);
  expect(
    (await server.sql.query('select id from public.customers')).rows,
  ).toHaveLength(0);
  expect(await f.db.sales.count()).toBe(1);
}, 30000);
it('a genuine complete cold restore retains original source and money without recovering outgoing approvals', async () => {
  const f = await fixture(),
    portable = await backupFile(
      (await f.db.readCompleteBackup()).portable,
    ).text(),
    cold = new MiseDatabase('owner-queue-cold-' + newInboxId());
  cleanup.push(() => cold.delete());
  const preview = await cold.previewRestore(portable);
  await cold.restoreBackup(portable, {
    sourceToken: preview.sourceToken,
    currentToken: preview.currentToken,
  });
  const view = await readNativePaymentQueue(cold, f.setup);
  expect(view.rows).toEqual([]);
  expect(view.canContinue).toBe(false);
  expect(await cold.nativePaymentActions.count()).toBe(0);
  expect(await cold.sales.count()).toBe(1);
  expect((await cold.inboxItems.get(f.item.id))!.text).toBe(f.item.text);
  await expect(
    continueNativePaymentQueue(cold, {
      ...f.options,
      expectedToken: view.token,
    }),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
}, 30000);
