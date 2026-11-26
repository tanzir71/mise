import 'fake-indexeddb/auto';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { inboxImageFile } from './inbox-fixture';
import { readSealedNativePaymentAction } from '../apps/web/src/data/native-payment-seal';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as legacyCloudRecords from '../packages/core/cloud-records';
import * as legacySyncSnapshot from '../packages/core/sync-snapshot';
import Dexie from 'dexie';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { createCopySdk, copySdkSubject } from './fixtures/original-copy-sdk';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { createNativePaymentOutboxSession } from '../apps/web/src/data/native-payment-session';
import {
  recordSavedPayment,
  recordSavedPaymentMoney,
  compareSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { createCloudSyncRemote } from '../apps/web/src/data/cloud-sync-remote';
import {
  prepareSyncDownload,
  runSyncDownload,
} from '../apps/web/src/data/cloud-sync-journal';
import { parseLocalSyncDownload } from '../packages/core/sync-download';
import {
  parseSyncPage,
  syncRecordByteLimit,
  syncReadHeader,
} from '../packages/core/sync-read';
import {
  mergeCanonicalRecords,
  reconstructCanonicalSnapshot,
} from '../packages/core/sync-canonical';
import { cloudConnectionTarget } from '../packages/core/cloud-connection';
import { newInboxId } from '../packages/core/inbox';
import {
  decodeNativeSyncRecord,
  nativeSyncRecordByteLimit,
  isNativeSyncTable,
} from '../packages/core/native-sync-records';
const config = {
    apiUrl: 'https://native-feed.test',
    publishableKey: 'sb_publishable_native_feed_test',
  },
  origin = 'https://shop.test';
let server: Awaited<ReturnType<typeof nativePaymentTestServer>>;
const stores: Dexie[] = [],
  clients: Awaited<ReturnType<typeof createCopySdk>>[] = [],
  sessions: Awaited<ReturnType<typeof createNativePaymentOutboxSession>>[] = [];
beforeAll(async () => {
  server = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
  );
}, 30000);
beforeEach(async () => {
  await server.sql.exec(
    'truncate private.native_payment_actions,private.native_payment_events,private.native_payment_write_tickets,private.native_payment_observations,private.native_original_copies,private.native_original_nodes,private.native_original_parts,private.native_original_membership,private.native_original_budgets cascade;truncate public.businesses cascade;truncate auth.sessions;delete from private.sync_read_windows;delete from private.sync_changes',
  );
  await server.sql.exec(
    'update auth.users set phone_confirmed_at=now(),deleted_at=null,banned_until=null,is_anonymous=false',
  );
  for (const n of [1, 2])
    await server.sql.query(
      'insert into auth.sessions(id,user_id) values($1,$2)',
      [copySdkSubject(n + 100), copySdkSubject(n)],
    );
});
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const c of clients.splice(0)) await c.auth.dispose();
  for (const db of stores.splice(0)) await db.delete();
});
afterAll(async () => {
  await server?.close();
});
async function fixture(n = 1, backend = server, scale = false) {
  const db = new MiseDatabase('native-feed-source-' + newInboxId());
  stores.push(db);
  const large = scale ? await seedPaymentStorage(db) : null;
  const setup =
      large?.setup ??
      (await db.saveSetup({
        businessType: 'corner_shop',
        marketCode: 'BD',
        name: 'Native feed shop',
        phone: '01712345482',
      })),
    item = await db.captureInbox({
      text: 'Tk 15.25\0\ud800 বাংলা',
      ...(large ? { files: [inboxImageFile()] } : {}),
    });
  await backend.seed(await db.readBackup(), copySdkSubject(n));
  let afterResponse:
    | ((
        url: RequestInfo | URL,
        init: RequestInit,
        response: Response,
      ) => Promise<Response>)
    | undefined;
  const bridge: typeof fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', origin);
      const response = await backend.handle(
        new Request(url, { ...init, headers }),
      );
      return afterResponse ? afterResponse(url, init, response) : response;
    },
    authScope = 'feed/' + db.name,
    sdk = await createCopySdk(config, authScope, bridge, n);
  clients.push(sdk);
  const targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    ),
    id = newInboxId();
  await db.cloudState.put({
    id: 'binding',
    version: 1,
    uploadId: id,
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    ownerId: setup.owner.id,
    targetHash,
    manifestHash: 'b'.repeat(64),
    phase: 'ready',
    sequence: 0,
    receipt: {
      id,
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      snapshotHash: 'c'.repeat(64),
      at: Date.now(),
      records: 3,
      images: 0,
    },
  });
  const journal = new OriginalCopyJournal('native-feed-copies-' + newInboxId());
  stores.push(journal);
  const send: typeof fetch = (url, init) =>
      new URL(String(url)).pathname.startsWith('/functions/')
        ? bridge(url, init)
        : sdk.send(url, init),
    session = await createNativePaymentOutboxSession(db, {
      config,
      authScope,
      auth: sdk.auth,
      storage: sdk.storage,
      journal,
      send,
    });
  sessions.push(session);
  const remote = createCloudSyncRemote(
    config,
    async () => (await sdk.auth.commandAuthorization()).jwt,
    send,
  );
  return {
    db,
    setup,
    item,
    sdk,
    session,
    remote,
    targetHash,
    send,
    backend,
    large,
    afterResponse: (fn: typeof afterResponse) => {
      afterResponse = fn;
    },
  };
}
async function money(f: Awaited<ReturnType<typeof fixture>>, deliver = true) {
  const review = await f.session.review(f.item.id);
  await recordSavedPayment(f.db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: '',
    receivedAt: f.item.createdAt,
  });
  const posted = await recordSavedPaymentMoney(
    f.db,
    review,
    await compareSavedPaymentMoney(
      f.db,
      review,
      f.large
        ? { kind: 'credit', id: f.large.account.id }
        : { kind: 'counter', who: 'Original native feed counter' },
      f.large ? 'Original full native feed collection' : undefined,
    ),
    true,
  );
  if (deliver)
    try {
      await f.session.deliver();
    } catch (error) {
      throw Error(String(error) + ' ' + f.backend.lastError());
    }
  return posted;
}
async function stage(
  f: Awaited<ReturnType<typeof fixture>>,
  cursor: string | null = null,
) {
  const window = await f.remote.begin({
    type: 'begin',
    id: newInboxId(),
    outletId: f.setup.outlet.id,
    cursor,
  });
  return stageAt(f, window, cursor);
}
async function stageAt(
  f: Awaited<ReturnType<typeof fixture>>,
  window: Awaited<ReturnType<typeof f.remote.begin>>,
  cursor: string | null = null,
) {
  const db = new MiseDatabase('native-feed-stage-' + newInboxId());
  stores.push(db);
  const id = window.id,
    target = {
      targetHash: f.targetHash,
      businessId: window.businessId,
      outletId: window.outletId,
      actorId: window.actorId,
      accountHash: window.accountHash,
      role: window.role,
    };
  await prepareSyncDownload(db, { id, target, previousCursor: cursor });
  const state = await runSyncDownload(db, id, target, f.remote);
  return { db, state, records: await db.syncRecords.toArray(), window, target };
}
it('the unchanged legacy-only stream still reconstructs an empty-device canonical snapshot', async () => {
  const f = await fixture(),
    download = await stage(f),
    canonical = await reconstructCanonicalSnapshot(
      download.state,
      download.records,
      [],
    );
  expect(canonical.backup.tables.inboxItems[0].text).toBe(f.item.text);
  expect(download.records.some((r) => isNativeSyncTable(r.meta.table))).toBe(
    false,
  );
  expect(await download.db.sales.count()).toBe(0);
}, 30000);
it('actual SDK and production HTTP/SQL stage native source, history and outcomes in the same window as one genuine financial collection', async () => {
  const f = await fixture();
  await money(f);
  const download = await stage(f),
    native = download.records.filter((r) => isNativeSyncTable(r.meta.table));
  expect(native.filter((r) => r.meta.table === 'native_payments')).toHaveLength(
    2,
  );
  expect(
    native.filter((r) => r.meta.table === 'native_payment_actions'),
  ).toHaveLength(2);
  expect(native.some((r) => r.meta.table === 'native_payment_events')).toBe(
    true,
  );
  expect(
    download.records.filter(
      (r) => r.meta.table === 'sales' && r.meta.operation === 'upsert',
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(native)).not.toContain('auth_user_id');
  expect(JSON.stringify(native)).not.toContain(copySdkSubject(1));
  expect(download.state.receivedCursor).toBeTruthy();
  expect(await download.db.payments.count()).toBe(0);
  expect(await download.db.sales.count()).toBe(0);
  expect(await download.db.outbox.count()).toBe(0);
  await expect(
    reconstructCanonicalSnapshot(download.state, download.records, []),
  ).rejects.toThrow('Native canonical installation');
  const rows = (
    await server.sql.query<{ record_json: string }>(
      'select record_json from private.native_payment_observations',
    )
  ).rows;
  const merged = await mergeCanonicalRecords(
    [],
    download.records,
    download.state.id,
  );
  expect(
    merged.find((r) => r.table === 'native_payments')!.row!.record_json,
  ).toBe(rows[0].record_json);
  expect(await f.db.sales.count()).toBe(1);
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
}, 30000);
it('all native and financial projections use their actual shared transaction identity', async () => {
  const f = await fixture();
  await money(f);
  const rows = (
    await server.sql.query<{ transaction_id: string; table_name: string }>(
      "select transaction_id::text,table_name from private.sync_changes where table_name in ('sales','native_payments','native_payment_events','native_payment_actions') order by id",
    )
  ).rows;
  const sale = rows.find((r) => r.table_name === 'sales')!;
  expect(sale).toBeDefined();
  for (const table of [
    'native_payments',
    'native_payment_events',
    'native_payment_actions',
  ])
    expect(
      rows.some(
        (r) =>
          r.transaction_id === sale.transaction_id && r.table_name === table,
      ),
    ).toBe(true);
}, 30000);

it('revoked sessions cannot obtain even an already cached native window and admission rejects before reading body bytes', async () => {
  const f = await fixture();
  await money(f);
  const download = await stage(f);
  await server.sql.query('delete from auth.sessions where id=$1', [
    copySdkSubject(101),
  ]);
  for (const type of ['begin', 'page']) {
    let read = false;
    const request = new Request(config.apiUrl + '/functions/v1/sync-read', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + f.sdk.access,
        'Content-Type': 'application/json',
        [syncReadHeader]: f.setup.outlet.id,
      },
      body: JSON.stringify(
        type === 'begin'
          ? {
              type,
              id: newInboxId(),
              outletId: f.setup.outlet.id,
              cursor: null,
            }
          : {
              type,
              id: download.window.id,
              outletId: f.setup.outlet.id,
              index: 0,
            },
      ),
    });
    Object.defineProperty(request, 'body', {
      get() {
        read = true;
        throw Error('Do not consume revoked native body');
      },
    });
    expect((await server.handle(request)).status).toBe(403);
    expect(read).toBe(false);
  }
}, 30000);
it('expiry during actual native page persistence rolls the cached bytes, progress and expiry back before a deliberate retry', async () => {
  const f = await fixture();
  await money(f);
  const window = await f.remote.begin({
    type: 'begin',
    id: newInboxId(),
    outletId: f.setup.outlet.id,
    cursor: null,
  });
  await server.sql.exec(
    `create function private.test_native_feed_expiry() returns trigger language plpgsql as $$begin update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='${copySdkSubject(101)}';return new;end $$;create trigger test_native_feed_expiry after insert on private.sync_read_pages for each row execute function private.test_native_feed_expiry()`,
  );
  try {
    await expect(f.remote.page(window, 0)).rejects.toMatchObject({
      kind: 'auth',
    });
  } finally {
    await server.sql.exec(
      'drop trigger test_native_feed_expiry on private.sync_read_pages;drop function private.test_native_feed_expiry()',
    );
  }
  expect(
    (
      await server.sql.query(
        'select page_index from private.sync_read_pages where window_id=$1',
        [window.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await server.sql.query(
        'select next_page,done from private.sync_read_windows where id=$1',
        [window.id],
      )
    ).rows,
  ).toEqual([{ next_page: 0, done: false }]);
  expect(
    (
      await server.sql.query(
        'select not_after from auth.sessions where id=$1',
        [copySdkSubject(101)],
      )
    ).rows,
  ).toEqual([{ not_after: null }]);
  expect(
    (await f.remote.page(window, 0)).parts.some((p) =>
      isNativeSyncTable(p.table),
    ),
  ).toBe(true);
  expect(await f.db.sales.count()).toBe(1);
}, 30000);

it('another actual account cannot read native source/history/outcomes from a different shop or reuse its saved window', async () => {
  const a = await fixture(),
    b = await fixture(2);
  await money(a);
  await money(b);
  const first = await stage(a),
    second = await stage(b);
  for (const [f, download] of [
    [a, first],
    [b, second],
  ] as const)
    for (const row of download.records.filter((r) =>
      isNativeSyncTable(r.meta.table),
    )) {
      expect(row.row!.business_id).toBe(f.setup.business.id);
      expect(row.row!.outlet_id).toBe(f.setup.outlet.id);
    }
  await expect(b.remote.page(first.window, 0)).rejects.toMatchObject({
    kind: 'auth',
  });
  await expect(a.remote.page(second.window, 0)).rejects.toMatchObject({
    kind: 'auth',
  });
  expect(await a.db.sales.count()).toBe(1);
  expect(await b.db.sales.count()).toBe(1);
}, 30000);
it('a lost real HTTP page resumes its original SQL cache on a recreated native read client without another financial action', async () => {
  const f = await fixture();
  await money(f);
  let lost = true;
  f.afterResponse(async (url, init, response) => {
    if (
      new URL(String(url)).pathname === '/functions/v1/sync-read' &&
      JSON.parse(init.body as string).type === 'page' &&
      lost
    ) {
      lost = false;
      throw Error('Lost actual cached native page reply');
    }
    return response;
  });
  const db = new MiseDatabase('native-lost-page-' + newInboxId());
  stores.push(db);
  const id = newInboxId(),
    window = await f.remote.begin({
      type: 'begin',
      id,
      outletId: f.setup.outlet.id,
      cursor: null,
    }),
    target = {
      targetHash: f.targetHash,
      businessId: window.businessId,
      outletId: window.outletId,
      actorId: window.actorId,
      accountHash: window.accountHash,
      role: window.role,
    };
  await prepareSyncDownload(db, { id, target, previousCursor: null });
  await expect(runSyncDownload(db, id, target, f.remote)).rejects.toMatchObject(
    { kind: 'retry' },
  );
  expect((await db.syncReads.get(id))!.pages).toBe(0);
  const cached = (
    await server.sql.query(
      'select content from private.sync_read_pages where window_id=$1',
      [id],
    )
  ).rows;
  expect(cached).toHaveLength(1);
  const recreated = createCloudSyncRemote(
      config,
      async () => (await f.sdk.auth.commandAuthorization()).jwt,
      f.send,
    ),
    state = await runSyncDownload(db, id, target, recreated);
  expect(state.seal).toBeTruthy();
  expect(
    (await db.syncRecords.toArray()).some((r) =>
      isNativeSyncTable(r.meta.table),
    ),
  ).toBe(true);
  expect(
    (
      await server.sql.query(
        'select content from private.sync_read_pages where window_id=$1',
        [id],
      )
    ).rows,
  ).toEqual(cached);
  expect(
    (await server.sql.query('select id from private.native_payment_actions'))
      .rows,
  ).toHaveLength(2);
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  expect(await db.sales.count()).toBe(0);
}, 30000);
it('native row, intent and outcome tampering is rejected independently of a valid transport checksum', async () => {
  const f = await fixture();
  await money(f);
  const d = await stage(f),
    action = d.records.find((r) => r.meta.table === 'native_payment_actions')!,
    payment = d.records.find((r) => r.meta.table === 'native_payments')!,
    event = d.records.find(
      (r) =>
        r.meta.table === 'native_payment_events' &&
        JSON.parse(r.row!.record_json as string).command.startsWith('payment.'),
    )!,
    scope = d.window;
  const variants: [string, (row: Record<string, unknown>) => void][] = [
    [
      'private Auth identity',
      (r) => {
        r.auth_user_id = copySdkSubject(1);
      },
    ],
    [
      'changed actor',
      (r) => {
        r.actor_id = newInboxId();
      },
    ],
    [
      'changed hash',
      (r) => {
        r.request_hash = '0'.repeat(64);
      },
    ],
    [
      'noncanonical intent',
      (r) => {
        r.intent_json = ' ' + r.intent_json;
      },
    ],
    [
      'changed result hash',
      (r) => {
        (r.receipt as { paymentHash: string }).paymentHash = '0'.repeat(64);
      },
    ],
    [
      'extra receipt field',
      (r) => {
        (r.receipt as Record<string, unknown>).auth_user_id = copySdkSubject(1);
      },
    ],
  ];
  for (const [label, mutate] of variants) {
    const row = structuredClone(action.row!);
    mutate(row);
    expect(
      () => decodeNativeSyncRecord('native_payment_actions', row, scope),
      label,
    ).toThrow();
  }
  for (const record of [payment, event]) {
    const row = structuredClone(record.row!);
    row.record_json = JSON.stringify({
      ...JSON.parse(row.record_json as string),
      id: newInboxId(),
    });
    expect(() =>
      decodeNativeSyncRecord(
        record.meta.table as 'native_payments' | 'native_payment_events',
        row,
        scope,
      ),
    ).toThrow();
  }
  expect(await f.db.sales.count()).toBe(1);
  expect(await d.db.sales.count()).toBe(0);
}, 30000);
it('native record bounds are enforced before full allocation while existing legacy record limits stay unchanged', async () => {
  const f = await fixture();
  await money(f);
  const d = await stage(f);
  for (const table of [
    'native_payments',
    'native_payment_events',
    'native_payment_actions',
  ] as const) {
    const entry = d.records.find((r) => r.meta.table === table)!,
      limit = nativeSyncRecordByteLimit(table),
      part = { ...entry.meta, offset: 0, totalBytes: limit + 1, data: 'e30=' },
      page = {
        ...d.window,
        index: 0,
        parts: [part],
        done: false,
        cursor: null,
      };
    delete (page as Partial<typeof d.window>).createdAt;
    delete (page as Partial<typeof d.window>).expiresAt;
    expect(() => parseSyncPage(page, d.window, 0)).toThrow();
    const staged = {
      ...d.state,
      pages: 1,
      records: 0,
      bytes: 1,
      receivedCursor: null,
      seal: null,
      last: { ...entry.meta, totalBytes: limit + 1, received: 1 },
    };
    expect(() => parseLocalSyncDownload(staged)).toThrow();
  }
  expect(syncRecordByteLimit('sales')).toBe(1073741824);
}, 30000);

it('writes committed after window opening cannot mix newer native outcomes with an older financial snapshot', async () => {
  const f = await fixture();
  await money(f);
  const before = (
      await server.sql.query<{ record_json: string }>(
        'select record_json from private.native_payment_observations',
      )
    ).rows[0].record_json,
    window = await f.remote.begin({
      type: 'begin',
      id: newInboxId(),
      outletId: f.setup.outlet.id,
      cursor: null,
    });
  const review = await f.session.review(f.item.id);
  await undoSavedPaymentMoney(
    f.db,
    review,
    await compareSavedPaymentMoneyUndo(f.db, review),
    true,
  );
  await f.session.deliver();
  const old = await stageAt(f, window),
    oldRows = await mergeCanonicalRecords([], old.records, old.state.id);
  expect(
    oldRows.find((r) => r.table === 'native_payments')!.row!.record_json,
  ).toBe(before);
  expect(
    oldRows.filter((r) => r.table === 'native_payment_actions'),
  ).toHaveLength(2);
  expect(
    oldRows.find((r) => r.table === 'sales')!.row!.voidedAt,
  ).toBeUndefined();
  const later = await stage(f, old.state.receivedCursor),
    current = await mergeCanonicalRecords(
      oldRows,
      later.records,
      later.state.id,
    ),
    actual = (
      await server.sql.query<{ record_json: string }>(
        'select record_json from private.native_payment_observations',
      )
    ).rows[0].record_json;
  expect(actual).not.toBe(before);
  expect(
    current.find((r) => r.table === 'native_payments')!.row!.record_json,
  ).toBe(actual);
  expect(
    current.filter((r) => r.table === 'native_payment_actions'),
  ).toHaveLength(3);
  expect(current.find((r) => r.table === 'sales')!.row!.voidedAt).toBeTypeOf(
    'number',
  );
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
}, 30000);
it('a native capture failure after the actual money insert rolls the money, outcome and every projected byte back together', async () => {
  const f = await fixture();
  await server.sql.exec(
    `create function private.test_native_feed_failure() returns trigger language plpgsql as $$begin if new.type='payment.record' then raise exception 'Native capture unavailable';end if;return new;end $$;create trigger zz_test_native_feed_failure after insert on private.native_payment_actions for each row execute function private.test_native_feed_failure()`,
  );
  try {
    await expect(money(f)).rejects.toThrow('Native capture unavailable');
    expect(
      (await server.sql.query('select id from public.sales')).rows,
    ).toHaveLength(0);
    expect(
      (await server.sql.query('select id from private.native_payment_actions'))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await server.sql.query(
          "select id from private.sync_changes where table_name='sales'",
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await server.sql.exec(
      'drop trigger zz_test_native_feed_failure on private.native_payment_actions;drop function private.test_native_feed_failure()',
    );
  }
  expect(await f.db.sales.count()).toBe(1);
  expect(
    (await f.db.nativePaymentActions.toArray()).find(
      (r) => r.original.invocation.command.type === 'payment.record',
    )!.nativeReceipt,
  ).toBeNull();
  await f.session.deliver();
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  expect(
    (await server.sql.query('select id from private.native_payment_actions'))
      .rows,
  ).toHaveLength(2);
  const d = await stage(f);
  expect(d.state.seal).toBeTruthy();
}, 30000);
it('private native maintenance emits complete tombstones without deleting public money or letting an empty native table bypass the install fence', async () => {
  const f = await fixture();
  await money(f);
  const original = await stage(f),
    before = await mergeCanonicalRecords(
      [],
      original.records,
      original.state.id,
    ),
    native = before.filter((r) => isNativeSyncTable(r.table));
  await server.sql.exec(
    'truncate private.native_payment_actions,private.native_payment_events,private.native_payment_observations',
  );
  const delta = await stage(f, original.state.receivedCursor),
    merged = await mergeCanonicalRecords(before, delta.records, delta.state.id);
  expect(
    delta.records.filter(
      (r) => isNativeSyncTable(r.meta.table) && r.meta.operation === 'delete',
    ),
  ).toHaveLength(native.length);
  expect(
    merged
      .filter((r) => isNativeSyncTable(r.table))
      .every((r) => r.operation === 'delete' && r.row === null),
  ).toBe(true);
  const fresh = await stage(f);
  await expect(
    reconstructCanonicalSnapshot(fresh.state, fresh.records, []),
  ).rejects.toThrow('Native canonical installation');
  expect(
    (await server.sql.query('select id from public.sales')).rows,
  ).toHaveLength(1);
  expect(await f.db.sales.count()).toBe(1);
}, 30000);
it('native capture, identity and session helpers remain invoker-only and unreadable to all client roles', async () => {
  const names = [
    'private.sync_native_member(text,text)',
    'private.sync_native_member_identity()',
    'private.sync_capture_native_payment()',
    'private.sync_require_native_session(public.ulid)',
  ];
  for (const role of ['anon', 'authenticated', 'service_role'])
    for (const name of names)
      expect(
        (
          await server.sql.query<{ granted: boolean }>(
            "select has_function_privilege($1,$2,'execute') granted",
            [role, name],
          )
        ).rows,
      ).toEqual([{ granted: false }]);
  const rows = (
    await server.sql.query<{ prosecdef: boolean }>(
      'select prosecdef from pg_proc where oid=any($1::regprocedure[])',
      [names],
    )
  ).rows;
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => !r.prosecdef)).toBe(true);
  for (const table of [
    'native_payment_observations',
    'native_payment_events',
    'native_payment_actions',
  ])
    for (const role of ['anon', 'authenticated', 'service_role'])
      expect(
        (
          await server.sql.query<{ granted: boolean }>(
            "select has_table_privilege($1,$2,'select,insert,update,delete') granted",
            [role, 'private.' + table],
          )
        ).rows,
      ).toEqual([{ granted: false }]);
}, 30000);

it('an actual prior-schema native shop upgrades by backfilling complete originals and outcomes without replaying money and invalidates its old window', async () => {
  const prior = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
    '20261125214903_native_payment_sessions.sql',
  );
  try {
    const f = await fixture(1, prior);
    await money(f);
    const oldWindow = await f.remote.begin({
      type: 'begin',
      id: newInboxId(),
      outletId: f.setup.outlet.id,
      cursor: null,
    });
    await f.remote.page(oldWindow, 0);
    const originals = (
        await prior.sql.query(
          'select id,record_json from private.native_payment_events order by id',
        )
      ).rows,
      observations = (
        await prior.sql.query(
          'select id,record_json from private.native_payment_observations order by id',
        )
      ).rows,
      actions = (
        await prior.sql.query(
          'select id,intent_json,receipt from private.native_payment_actions order by id',
        )
      ).rows,
      moneyRows = (
        await prior.sql.query(
          'select row_to_json(s)::text as row from public.sales s order by id',
        )
      ).rows;
    await prior.sql.exec(
      readFileSync(
        'supabase/migrations/20261125235037_native_payment_sync_capture.sql',
        'utf8',
      ),
    );
    await expect(f.remote.page(oldWindow, 0)).rejects.toMatchObject({
      kind: 'review',
    });
    const d = await stage(f),
      merged = await mergeCanonicalRecords([], d.records, d.state.id);
    expect(merged.filter((r) => r.table === 'native_payments')).toHaveLength(1);
    expect(
      merged.filter((r) => r.table === 'native_payment_events'),
    ).toHaveLength(originals.length);
    expect(
      merged.filter((r) => r.table === 'native_payment_actions'),
    ).toHaveLength(2);
    expect(
      (
        await prior.sql.query(
          'select id,record_json from private.native_payment_events order by id',
        )
      ).rows,
    ).toEqual(originals);
    expect(
      (
        await prior.sql.query(
          'select id,record_json from private.native_payment_observations order by id',
        )
      ).rows,
    ).toEqual(observations);
    expect(
      (
        await prior.sql.query(
          'select id,intent_json,receipt from private.native_payment_actions order by id',
        )
      ).rows,
    ).toEqual(actions);
    expect(
      (
        await prior.sql.query(
          'select row_to_json(s)::text as row from public.sales s order by id',
        )
      ).rows,
    ).toEqual(moneyRows);
    const review = await f.session.review(f.item.id);
    await undoSavedPaymentMoney(
      f.db,
      review,
      await compareSavedPaymentMoneyUndo(f.db, review),
      true,
    );
    await f.session.deliver();
    expect(
      (await prior.sql.query('select id from public.sales')).rows,
    ).toHaveLength(1);
    expect(
      (await prior.sql.query('select id from private.native_payment_actions'))
        .rows,
    ).toHaveLength(3);
  } finally {
    await prior.close();
  }
}, 30000);

it('the complete 5,000-charge million-code-unit image source crosses actual native delivery and the same-window feed with exactly one collection', async () => {
  const started = performance.now();
  console.log(JSON.stringify({ stage: 'native-feed-scale-start' }));
  const f = await fixture(1, server, true),
    seeded = f.large!;
  console.log(JSON.stringify({ stage: 'native-feed-scale-seeded' }));
  const posted = await money(f, false),
    hashes = (await f.db.nativePaymentActions.toArray()).map(
      (r) => r.originalHash,
    );
  expect((await f.session.deliver()).blockedEntryId).toBeNull();
  console.log(JSON.stringify({ stage: 'native-feed-scale-delivered' }));
  const d = await stage(f),
    merged = await mergeCanonicalRecords([], d.records, d.state.id),
    entries = new Map(
      merged
        .filter((r) => r.table === 'credit_entries' && r.operation === 'upsert')
        .map((r) => [r.id, r.row!]),
    );
  expect(entries.size).toBe(5001);
  for (const original of seeded.entries)
    expect(entries.get(original.id)).toEqual(original);
  const note = merged.find(
    (r) => r.table === 'customers' && r.id === seeded.customer.id,
  )!.row!.notes as string;
  expect(note.length).toBe(1000000);
  const hash = (text: string) =>
    createHash('sha256').update(JSON.stringify(text)).digest('hex');
  expect(hash(note)).toBe(hash(seeded.largeNote));
  const original = await readSealedNativePaymentAction(
    f.db,
    posted.payment.eventId,
  );
  expect(original.original.source.images).toHaveLength(1);
  expect(original.original.financial!.posting.receipt.id).toBe(
    posted.payment.postings![0].receipt.id,
  );
  const native = merged.filter(
      (r) => isNativeSyncTable(r.table) && r.operation === 'upsert',
    ),
    events = (
      await server.sql.query<{ id: string; record_json: string }>(
        'select id,record_json from private.native_payment_events order by id',
      )
    ).rows;
  for (const event of events)
    expect(
      native.find(
        (r) => r.table === 'native_payment_events' && r.id === event.id,
      )!.row!.record_json,
    ).toBe(event.record_json);
  expect(
    native.filter((r) => r.table === 'native_payment_actions'),
  ).toHaveLength(2);
  expect(
    (await f.db.nativePaymentActions.toArray()).map((r) => r.originalHash),
  ).toEqual(hashes);
  expect(
    (await server.sql.query('select id from public.credit_entries')).rows,
  ).toHaveLength(5001);
  expect(await f.db.creditEntries.count()).toBe(5001);
  expect(await d.db.creditEntries.count()).toBe(0);
  expect(await d.db.outbox.count()).toBe(0);
  expect(d.state.seal).toBeTruthy();
  console.log(
    JSON.stringify({
      stage: 'native-feed-scale-verified',
      charges: 5000,
      noteCodeUnits: 1000000,
      images: 1,
      actualCollections: 1,
      completeOriginalEventRows: events.length,
      downloadRecords: d.state.records,
      downloadBytes: d.state.bytes,
      pages: d.state.pages,
      durationMs: performance.now() - started,
    }),
  );
}, 600000);

it('the exact previous production reader rejects all native fragments before accepting a cursor while retaining ordinary fragment parsing', async () => {
  const f = await fixture();
  await money(f);
  const d = await stage(f),
    source = readFileSync('tests/fixtures/sync-read-before-native.txt', 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '32ffb6dbb4198652c7606d0d61038df33e6617a72fa37ef6bdfd593230f63ffb',
  );
  const module = {
      exports: {} as { parseSyncPage: (...args: unknown[]) => unknown },
    },
    code = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === './cloud-records') return legacyCloudRecords;
      if (name === './sync-snapshot') return legacySyncSnapshot;
      throw Error('Unexpected frozen reader dependency');
    },
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
  });
  const pageBase = {
    v: 1,
    businessId: d.window.businessId,
    outletId: d.window.outletId,
    actorId: d.window.actorId,
    accountHash: d.window.accountHash,
    role: d.window.role,
    epoch: d.window.epoch,
    scopeVersion: d.window.scopeVersion,
    id: d.window.id,
    index: 0,
    done: false,
    cursor: null,
  };
  for (const table of [
    'native_payments',
    'native_payment_events',
    'native_payment_actions',
  ] as const) {
    const row = d.records.find((r) => r.meta.table === table)!,
      part = { ...row.meta, offset: 0, data: 'e30=' };
    expect(() =>
      module.exports.parseSyncPage({ ...pageBase, parts: [part] }, d.window, 0),
    ).toThrow('Keep every original sync fragment');
    expect(() =>
      module.exports.parseSyncPage(
        { ...pageBase, parts: [{ ...part, table: 'sales' }] },
        d.window,
        0,
      ),
    ).not.toThrow();
  }
}, 30000);
