import 'fake-indexeddb/auto';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { inboxImageFile } from './inbox-fixture';
import { defaultCreditTerms } from '../packages/core/khata';
import { readSealedNativePaymentAction } from '../apps/web/src/data/native-payment-seal';
import {
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import Dexie from 'dexie';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { createCopySdk, copySdkSubject } from './fixtures/original-copy-sdk';
import { createNativePaymentOutboxSession } from '../apps/web/src/data/native-payment-session';
import {
  recordSavedPayment,
  editSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import {
  prepareCloudMigration,
  type CloudRecord,
} from '../packages/core/cloud-records';
import {
  saveCloudConnection,
  cloudConnectionTarget,
} from '../packages/core/cloud-connection';
import { literalToken } from '../packages/core/literal-token';
import { newInboxId } from '../packages/core/inbox';
import { parseNativePaymentOutbox, type NativePaymentOutboxEntry } from '../packages/core/native-payment-outbox';
import { deliverLocalOutbox } from '../apps/web/src/data/local-outbox';
import {
  createNativePaymentHandler,
  createNativePaymentStore,
} from '../supabase/functions/_shared/native-payment-handler';
import {
  originalCopyHandler,
  originalCopyStore,
} from '../supabase/functions/_shared/original-copy-handler';
import {
  createCommandsHandler,
  createCommandStore,
} from '../supabase/functions/_shared/commands-handler';
const config = {
    apiUrl: 'https://edge.test',
    publishableKey: 'sb_publishable_delivery_test',
  },
  serviceKey = 'sb_secret_delivery_test',
  origin = 'https://shop.test';
let sql: PGlite,
  lastError = '';
const databases: Dexie[] = [],
  clients: Awaited<ReturnType<typeof createCopySdk>>[] = [],
  sessions: { stop(): void }[] = [];
beforeAll(async () => {
  sql = await PGlite.create();
  for (const file of ['supabase-auth.sql', 'supabase-storage.sql'])
    await sql.exec(readFileSync('tests/fixtures/' + file, 'utf8'));
  await sql.exec(
    'create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz)',
  );
  for (const file of readdirSync('supabase/migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    await sql.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
  for (const n of [1, 2])
    await sql.query(
      'insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',
      [copySdkSubject(n), '880171234548' + n],
    );
}, 30000);
beforeEach(async () => {
  lastError = '';
  await sql.exec(
    'truncate public.businesses cascade;truncate private.native_payment_actions,private.native_payment_events,private.native_payment_write_tickets,private.native_original_copies,private.native_original_nodes,private.native_original_parts,private.native_original_membership,private.native_original_budgets cascade;truncate auth.sessions',
  );
  await sql.exec(
    'update auth.users set phone_confirmed_at=now(),deleted_at=null,banned_until=null,is_anonymous=false',
  );
  for (const n of [1, 2])
    await sql.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      copySdkSubject(n + 100),
      copySdkSubject(n),
    ]);
});
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const c of clients.splice(0)) await c.auth.dispose();
  for (const d of databases.splice(0)) await d.delete();
});
afterAll(async () => {
  await sql?.close();
});
async function seed(records: CloudRecord[]) {
  await sql.transaction(async (tx) => {
    for (const record of records) {
      const keys = Object.keys(record.values);
      if (![record.table, ...keys].every((v) => /^[a-z_][a-z_0-9]*$/.test(v)))
        throw Error('Invalid fixture column');
      await tx.query(
        `insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
        keys.map((k) => record.values[k]),
      );
    }
  });
}
async function fixture(
  kind: 'counter' | 'order' | 'credit' | 'large' = 'counter',
) {
  const db = new MiseDatabase('native-delivery-' + newInboxId());
  databases.push(db);
  const large = kind === 'large' ? await seedPaymentStorage(db) : null;
  const setup =
    large?.setup ??
    (await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Installation-owned delivery',
      phone: '01712345482',
    }));
  const order =
    kind === 'order'
      ? await db.saveOrder({
          source: 'phone',
          sourceText: 'Original order',
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
  const customer =
    kind === 'credit'
      ? await db.saveCustomer(
          {
            name: 'Original credit customer',
            nickname: '',
            phone: '',
            address: '',
            notes: '',
            tags: [],
          },
          { credit: { ...defaultCreditTerms, allowed: true, limit: 100000 } },
        )
      : null;
  const account =
    large?.account ??
    (customer
      ? (await db.creditAccounts.toArray()).find(
          (a) => a.customerId === customer.id,
        )!
      : null);
  if (kind === 'credit')
    await db.recordCreditSale({
      accountId: account!.id,
      customerId: customer!.id,
      expression: '30',
    });
  const item = await db.captureInbox({
    text: 'Unknown received Tk 15.25\0\ud800 বাংলা',
    ...(large ? { files: [inboxImageFile()] } : {}),
  });
  await seed(
    (await prepareCloudMigration(await db.readBackup(), copySdkSubject(1)))
      .records,
  );
  const calls: { path: string; type: string | null }[] = [];
  let beforeNative:
      ((body: Record<string, unknown>) => Promise<void>) | undefined,
    afterNative:
      | ((
          body: Record<string, unknown>,
          response: Response,
        ) => Promise<Response>)
      | undefined;
  const rpc: typeof fetch = async (url, init = {}) => {
    const name = new URL(String(url)).pathname.split('/').at(-1)!;
    if (!/^[a-z_]+$/.test(name)) throw Error('Invalid fixture RPC');
    const a = JSON.parse(init.body as string) as Record<string, unknown>,
      keys = Object.keys(a),
      h = new Headers(init.headers),
      service = h.get('apikey') === serviceKey;
    if (!service && h.get('apikey') !== config.publishableKey)
      throw Error('Unexpected fixture key');
    const jwt = h.get('Authorization')?.replace(/^Bearer /, ''),
      claims = service
        ? { role: 'service_role' }
        : JSON.parse(
            Buffer.from(jwt!.split('.')[1], 'base64url').toString('utf8'),
          );
    try {
      const rows = await sql.transaction(async (tx) => {
        await tx.exec(
          'set local role ' + (service ? 'service_role' : 'authenticated'),
        );
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify(claims),
        ]);
        return (
          await tx.query<{ value: unknown }>(
            `select public.${name}(${keys.map((k, i) => k + ' => $' + (i + 1)).join(',')}) value`,
            keys.map((k) =>
              a[k] !== null && typeof a[k] === 'object'
                ? JSON.stringify(a[k])
                : a[k],
            ),
          )
        ).rows;
      });
      return new Response(JSON.stringify(rows[0].value), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const e = error as { code: string; message: string; where?: string };
      lastError =
        e.code + ' ' + e.message + ' ' + (e.where ?? '').slice(0, 500);
      return new Response(
        JSON.stringify({ code: e.code, message: e.message }),
        {
          status:
            e.code === '42501'
              ? 403
              : ['PT409', '23505'].includes(e.code)
                ? 409
                : e.code === '22023'
                  ? 400
                  : 500,
        },
      );
    }
  };
  const originals = originalCopyHandler(
      new Set([origin]),
      originalCopyStore(config.apiUrl, config.publishableKey, rpc),
    ),
    native = createNativePaymentHandler({
      origins: new Set([origin]),
      store: createNativePaymentStore(
        config.apiUrl,
        config.publishableKey,
        serviceKey,
        rpc,
      ),
    }),
    commands = createCommandsHandler({
      origins: new Set([origin]),
      store: createCommandStore(config.apiUrl, config.publishableKey, rpc, {
        serviceKey,
      }),
    });
  const copyFetch: typeof fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    return originals(new Request(url, { ...init, headers }));
  };
  const authScope = '/mise/app/' + setup.business.id,
    sdk = await createCopySdk(config, authScope, copyFetch);
  clients.push(sdk);
  const send: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (
      path === '/functions/v1/native-payment' ||
      path === '/functions/v1/commands'
    ) {
      const body = JSON.parse(init.body as string),
        headers = new Headers(init.headers);
      headers.set('Origin', origin);
      calls.push({
        path,
        type: path.endsWith('native-payment') ? body.command.type : body.type,
      });
      if (path.endsWith('native-payment')) {
        await beforeNative?.(body);
        const response = await native(new Request(url, { ...init, headers }));
        return afterNative ? afterNative(body, response) : response;
      }
      return commands(new Request(url, { ...init, headers }));
    }
    return sdk.send(url, init);
  };
  const uploadId = newInboxId(),
    targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    );
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
    'native-delivery-copy-' + newInboxId(),
  );
  databases.push(journal);
  const options = {
    config,
    authScope,
    auth: sdk.auth,
    storage: sdk.storage,
    journal,
    send,
  };
  const session = await createNativePaymentOutboxSession(db, options);
  sessions.push(session);
  return {
    db,
    setup,
    order,
    account,
    large,
    item,
    journal,
    sdk,
    session,
    options,
    copyFetch,
    commands,
    calls,
    review: await session.review(item.id),
    input: {
      checked: true as const,
      amount: 1525,
      currency: 'BDT',
      method: 'cash' as const,
      methodName: 'Cash',
      reference: '',
      receivedAt: item.createdAt,
    },
    beforeNative: (fn: typeof beforeNative) => {
      beforeNative = fn;
    },
    afterNative: (fn: typeof afterNative) => {
      afterNative = fn;
    },
  };
}
async function counter(f: Awaited<ReturnType<typeof fixture>>) {
  await recordSavedPayment(f.db, f.review, f.input);
  return recordSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoney(f.db, f.review, {
      kind: 'counter',
      who: 'Actual native counter',
    }),
    true,
  );
}
it('actual SDK/copy/SQL delivery preserves global legacy order, original hashes and local money while retaining native v1 markers', async () => {
  const f = await fixture();
  await f.db.saveCustomer({
    name: 'Earlier',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  await counter(f);
  await f.db.saveCustomer({
    name: 'Later',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const before = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    money = literalToken(await f.db.sales.toArray());
  const delivered = await f.session.deliver();
  expect(delivered.blockedEntryId, lastError).toBeNull();
  expect(delivered.nativeGroups).toBe(2);
  expect(f.calls.map((c) => c.type)).toEqual([
    'customer.create',
    'payment.capture',
    'payment.record',
    'customer.create',
  ]);
  const rows = (await f.db.nativePaymentActions.toArray()).map(
    parseNativePaymentOutbox,
  );
  expect(
    rows.every(
      (r) =>
        r.state === 'applied' &&
        r.outcomeHash &&
        r.copyReceipt &&
        r.nativeReceipt,
    ),
  ).toBe(true);
  expect(rows.map((r) => r.original)).toEqual(before.map((r) => r.original));
  expect(rows.map((r) => r.originalHash)).toEqual(
    before.map((r) => r.originalHash),
  );
  expect(literalToken(await f.db.sales.toArray())).toBe(money);
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  const markers = await f.db.outbox.toArray();
  expect(markers.filter((r) => r.status === 'retained')).toHaveLength(2);
  expect(markers.filter((r) => r.status === 'accepted')).toHaveLength(2);
  let legacySent = 0;
  await deliverLocalOutbox(f.db, f.session.identity.targetHash, async () => {
    legacySent++;
    throw Error(
      'Native barriers cannot be skipped by the plain legacy sender.',
    );
  });
  expect(legacySent).toBe(0);
  for (const value of [
    config.apiUrl,
    config.publishableKey,
    serviceKey,
    f.sdk.access,
    f.sdk.saved.refresh_token,
  ])
    expect(JSON.stringify(rows)).not.toContain(value);
}, 30000);
it('a lost genuine native money response recovers its immutable receipt and sends later legacy work only after original readback', async () => {
  const f = await fixture();
  await counter(f);
  await f.db.saveCustomer({
    name: 'After money',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  let lost = false;
  f.afterNative(async (body, response) => {
    if (
      !lost &&
      (body.command as { type: string }).type === 'payment.record' &&
      response.ok
    ) {
      lost = true;
      throw new TypeError('Lost original response');
    }
    return response;
  });
  await expect(f.session.deliver()).rejects.toThrow();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(0);
  const pending = (await f.db.nativePaymentActions.toArray()).find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  expect(pending.nativeReceipt).toBeNull();
  expect(pending.copyReceipt).not.toBeNull();
  f.afterNative(undefined);
  f.session.stop();
  const next = await createNativePaymentOutboxSession(f.db, f.options);
  sessions.push(next);
  expect((await next.deliver()).blockedEntryId, lastError).toBeNull();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(1);
  expect((await f.db.nativePaymentActions.get(pending.id))!.state).toBe(
    'applied',
  );
  expect(await f.db.sales.count()).toBe(1);
}, 30000);
it('a shared physical native marker delivers all original invocations in execution order before later legacy work', async () => {
  const f = await fixture();
  await f.db.transaction('rw', f.db.tables, async () => {
    const saved = await recordSavedPayment(f.db, f.review, f.input);
    await editSavedPayment(
      f.db,
      f.review,
      { id: newInboxId(), revision: saved.payment.revision },
      { ...f.input, reference: 'Original checked edit' },
    );
  });
  await f.db.saveCustomer({
    name: 'After group',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
  expect(f.calls.map((c) => c.type)).toEqual([
    'payment.capture',
    'payment.edit',
    'customer.create',
  ]);
  expect(
    (await f.db.outbox.toArray()).filter((r) => r.status === 'retained'),
  ).toHaveLength(1);
  expect(
    (await sql.query('select id from private.native_payment_observations'))
      .rows,
  ).toHaveLength(1);
}, 30000);

it('a 409 from an actual concurrent source archive retains separate review observations and never sends later work or reinterprets local cash', async () => {
  const f = await fixture();
  await counter(f);
  await f.db.saveCustomer({
    name: 'After conflict',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  let changed = false;
  f.beforeNative(async (body) => {
    if (
      !changed &&
      (body.command as { type: string }).type === 'payment.record'
    ) {
      changed = true;
      const response = await f.commands(
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
      expect(response.status, lastError).toBe(200);
    }
  });
  const original = (await f.db.nativePaymentActions.toArray()).find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'review' });
  let row = (await f.db.nativePaymentActions.get(original.id))!;
  expect(row.state).toBe('review');
  expect(row.review).toMatchObject({ status: 409, observations: 1 });
  expect(row.nativeReceipt).toBeNull();
  expect(row.originalHash).toBe(original.originalHash);
  expect(row.original).toEqual(original.original);
  expect(await f.db.sales.count()).toBe(1);
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(0);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(0);
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'review' });
  row = (await f.db.nativePaymentActions.get(original.id))!;
  expect(row.review!.observations).toBe(2);
  expect(row.originalHash).toBe(original.originalHash);
}, 30000);
it('a private acknowledgement quota failure after actual server money preserves the source and recovers exactly one original receipt', async () => {
  const f = await fixture();
  await counter(f);
  await f.db.saveCustomer({
    name: 'After quota',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const fail = (
    mods: object,
    _id: unknown,
    row: NativePaymentOutboxEntry,
  ) => {
    if (
      row?.original.invocation.command.type === 'payment.record' &&
      'nativeReceipt' in mods &&
      mods.nativeReceipt
    )
      throw new DOMException('Private journal quota', 'QuotaExceededError');
  };
  f.db.nativePaymentActions.hook('updating', fail);
  try {
    await expect(f.session.deliver()).rejects.toThrow('Private journal quota');
  } finally {
    f.db.nativePaymentActions.hook('updating').unsubscribe(fail);
  }
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(0);
  expect(await f.db.sales.count()).toBe(1);
  const row = (await f.db.nativePaymentActions.toArray()).find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  expect(row.nativeReceipt).toBeNull();
  expect(row.state).toBe('pending');
  expect(row.copyReceipt).not.toBeNull();
  expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(1);
}, 30000);
it('a destination changed after actual server completion cannot acknowledge or revive the old controller, and a new original controller recovers without replay', async () => {
  const f = await fixture();
  await counter(f);
  let changed = false;
  f.afterNative(async (body, response) => {
    if (
      !changed &&
      (body.command as { type: string }).type === 'payment.record' &&
      response.ok
    ) {
      changed = true;
      saveCloudConnection(f.sdk.storage, {
        apiUrl: 'https://different.test',
        publishableKey: 'sb_publishable_different_test',
      });
    }
    return response;
  });
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'auth' });
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  const row = (await f.db.nativePaymentActions.toArray()).find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  expect(row.nativeReceipt).toBeNull();
  saveCloudConnection(f.sdk.storage, config);
  f.afterNative(undefined);
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'auth' });
  const next = await createNativePaymentOutboxSession(f.db, f.options);
  sessions.push(next);
  expect((await next.deliver()).blockedEntryId, lastError).toBeNull();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
}, 30000);
it('a malformed successful native receipt cannot become financial authority or let later legacy work pass', async () => {
  const f = await fixture();
  await counter(f);
  await f.db.saveCustomer({
    name: 'After bad receipt',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  f.afterNative(async (body, response) => {
    if (
      (body.command as { type: string }).type === 'payment.record' &&
      response.ok
    ) {
      const receipt = await response.json();
      return new Response(
        JSON.stringify({ ...receipt, paymentHash: 'f'.repeat(64) }),
      );
    }
    return response;
  });
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'review' });
  const row = (await f.db.nativePaymentActions.toArray()).find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  expect(row.nativeReceipt).toBeNull();
  expect(row.review).toBeNull();
  expect(row.state).toBe('pending');
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
  expect(
    (await sql.query('select id from public.customers')).rows,
  ).toHaveLength(0);
  f.afterNative(undefined);
  expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
}, 30000);
it('revocation after a verified copy still denies native money, and a fresh actual SDK session of the same user recovers the retained original', async () => {
  const f = await fixture();
  await counter(f);
  let removed = false;
  f.beforeNative(async (body) => {
    if (
      !removed &&
      (body.command as { type: string }).type === 'payment.record'
    ) {
      removed = true;
      await sql.query('delete from auth.sessions where id=$1', [
        copySdkSubject(101),
      ]);
    }
  });
  await expect(f.session.deliver()).rejects.toMatchObject({ kind: 'auth' });
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(0);
  expect(await f.db.sales.count()).toBe(1);
  f.beforeNative(undefined);
  f.session.stop();
  await f.sdk.auth.dispose();
  await sql.query('insert into auth.sessions(id,user_id) values($1,$2)', [
    copySdkSubject(201),
    copySdkSubject(1),
  ]);
  const sdk = await createCopySdk(
    config,
    f.options.authScope,
    f.copyFetch,
    1,
    f.sdk.storage,
    copySdkSubject(201),
  );
  clients.push(sdk);
  const next = await createNativePaymentOutboxSession(f.db, {
    ...f.options,
    auth: sdk.auth,
    storage: sdk.storage,
  });
  sessions.push(next);
  expect((await next.deliver()).blockedEntryId, lastError).toBeNull();
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(1);
}, 30000);
it('the actual SDK offline path can retain a complete source seal but cannot send copy or native money requests', async () => {
  const f = await fixture();
  await counter(f);
  f.sdk.setOnline(false);
  await expect(f.session.deliver()).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(0);
  expect(await f.db.sales.count()).toBe(1);
  expect(
    (await f.db.nativePaymentActions.toArray()).every(
      (r) => r.seal && r.copyReceipt === null && r.nativeReceipt === null,
    ),
  ).toBe(true);
}, 30000);
it('unknown retained work blocks native and later legacy delivery even when its raw row happened to be unchanged', async () => {
  const f = await fixture(),
    customer = await f.db.saveCustomer({
      name: 'Before unknown',
      nickname: '',
      phone: '',
      address: '',
      notes: '',
      tags: [],
    });
  await f.db.customers.put(customer);
  const unknown = (await f.db.outbox.toArray()).find(
    (r) => r.status === 'retained',
  )!;
  await counter(f);
  await f.db.saveCustomer({
    name: 'After unknown',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const result = await f.session.deliver();
  expect(result.blockedEntryId).toBe(unknown.id);
  expect(result.nativeGroups).toBe(0);
  expect(f.calls.map((c) => c.type)).toEqual(['customer.create']);
  expect((await sql.query('select id from public.sales')).rows).toHaveLength(0);
  expect(await f.db.sales.count()).toBe(1);
}, 30000);
it('a serialized barrier cannot skip a real native marker even when its durable outcomes were already applied', async () => {
  const f = await fixture();
  await counter(f);
  await f.session.deliver();
  let sent = 0;
  await expect(
    deliverLocalOutbox(
      f.db,
      f.session.identity.targetHash,
      async () => {
        sent++;
        throw Error('Unexpected legacy send');
      },
      undefined,
      JSON.parse('{"kind":"verified-native-payment-barriers"}'),
    ),
  ).rejects.toMatchObject({ kind: 'review' });
  expect(sent).toBe(0);
}, 30000);
it('new actual Inbox metadata reaches the backend before its native capture and is never replaced by its original-copy storage receipt', async () => {
  const f = await fixture(),
    item = await f.db.captureInbox({ text: 'New original received Tk 2.50' }),
    review = await f.session.review(item.id);
  await recordSavedPayment(f.db, review, {
    ...f.input,
    amount: 250,
    receivedAt: item.createdAt,
  });
  expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
  expect(f.calls.map((c) => c.type)).toEqual([
    'inbox.capture',
    'payment.capture',
  ]);
  expect(
    (
      await sql.query('select id from public.inbox_items where id=$1', [
        item.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (await sql.query('select id from private.native_payment_observations'))
      .rows,
  ).toHaveLength(1);
}, 30000);

it.each(['order', 'credit', 'counter'] as const)(
  'actual connected %s recording and original undo preserve every native child and apply once in global order',
  async (kind) => {
    const f = await fixture(kind);
    await recordSavedPayment(f.db, f.review, f.input);
    const target =
      kind === 'order'
        ? { kind: 'order' as const, id: f.order!.id }
        : kind === 'credit'
          ? { kind: 'credit' as const, id: f.account!.id }
          : { kind: 'counter' as const, who: 'Actual original counter' };
    const posted = await recordSavedPaymentMoney(
        f.db,
        f.review,
        await compareSavedPaymentMoney(f.db, f.review, target),
        true,
      ),
      undone = await undoSavedPaymentMoney(
        f.db,
        f.review,
        await compareSavedPaymentMoneyUndo(f.db, f.review),
        true,
      );
    const local = literalToken([
      await f.db.sales.toArray(),
      await f.db.orders.toArray(),
      await f.db.creditEntries.toArray(),
    ]);
    expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
    expect(f.calls.map((c) => c.type)).toEqual([
      'payment.capture',
      'payment.record',
      'payment.record-undo',
    ]);
    const rows = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    );
    expect(rows.every((r) => r.state === 'applied')).toBe(true);
    const original = await readSealedNativePaymentAction(
      f.db,
      posted.payment.eventId,
    );
    expect(original.original.financial!.posting.undo).toBeUndefined();
    expect(original.original.financial!.posting.receipt.id).toBe(
      posted.payment.postings![0].receipt.id,
    );
    const undo = await readSealedNativePaymentAction(
      f.db,
      undone.payment.eventId,
    );
    expect(undo.original.financial!.posting.undo!.eventId).toBe(
      undone.payment.eventId,
    );
    expect(
      literalToken([
        await f.db.sales.toArray(),
        await f.db.orders.toArray(),
        await f.db.creditEntries.toArray(),
      ]),
    ).toBe(local);
    const before = (
      await sql.query('select id from private.native_payment_actions')
    ).rows;
    await f.session.deliver();
    expect(
      (await sql.query('select id from private.native_payment_actions')).rows,
    ).toEqual(before);
  },
  30000,
);
it('the actual controller delivers the complete 5,000-charge/million-code-unit/image original and one genuine collection without truncation or money replay', async () => {
  const started = performance.now(),
    f = await fixture('large'),
    seeded = f.large!;
  await recordSavedPayment(f.db, f.review, f.input);
  const posted = await recordSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoney(
      f.db,
      f.review,
      { kind: 'credit', id: f.account!.id },
      'Original full collection',
    ),
    true,
  );
  const originals = (await f.db.nativePaymentActions.toArray()).map(
    (r) => r.originalHash,
  );
  expect((await f.session.deliver()).blockedEntryId, lastError).toBeNull();
  const rows = (await f.db.nativePaymentActions.toArray()).map(
    parseNativePaymentOutbox,
  );
  expect(rows.map((r) => r.originalHash)).toEqual(originals);
  expect(rows.every((r) => r.state === 'applied')).toBe(true);
  expect(
    (await sql.query('select id from public.credit_entries')).rows,
  ).toHaveLength(5001);
  expect(await f.db.creditEntries.count()).toBe(5001);
  const original = await readSealedNativePaymentAction(
    f.db,
    posted.payment.eventId,
  );
  expect(original.original.source.images).toHaveLength(1);
  expect(original.original.financial!.posting.receipt.id).toBe(
    posted.payment.postings![0].receipt.id,
  );
  const backup = await f.db.readPortableBackup();
  expect(backup.current.tables.customers[0].notes).toBe(seeded.largeNote);
  expect(
    backup.current.tables.creditEntries.filter((e) => e.type === 'charge'),
  ).toHaveLength(5000);
  const paid = rows.find((r) => r.id === posted.payment.eventId)!;
  expect(paid.copyReceipt!.nodeBytes).toBeGreaterThan(20000000);
  expect(paid.nativeReceipt!.financial!.receiptId).toBe(
    posted.payment.postings![0].receipt.id,
  );
  console.log(
    JSON.stringify({
      stage: 'actual-native-delivery-scale',
      charges: 5000,
      noteCodeUnits: 1000000,
      images: 1,
      actualCollections: 1,
      originalHashesUnchanged: true,
      nodeCount: paid.copyReceipt!.nodeCount,
      nodeBytes: paid.copyReceipt!.nodeBytes,
      durationMs: performance.now() - started,
    }),
  );
}, 600000);
