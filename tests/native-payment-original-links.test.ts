import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { createCopySdk, copySdkSubject } from './fixtures/original-copy-sdk';
import { inboxImageFile } from './inbox-fixture';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { createNativePaymentOutboxSession } from '../apps/web/src/data/native-payment-session';
import {
  createLinkedPaymentOriginalSession,
  createOriginalCopyOwnerSession,
} from '../apps/web/src/data/original-copy-session';
import {
  recordSavedPayment,
  recordSavedPaymentMoney,
  compareSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { cloudConnectionTarget } from '../packages/core/cloud-connection';
import { newInboxId } from '../packages/core/inbox';
import { parseNativePaymentOutbox } from '../packages/core/native-payment-outbox';
import {
  readLinkedPaymentOriginal,
  parseNativePaymentOriginalLink,
} from '../packages/core/native-payment-originals';
import { literalToken } from '../packages/core/literal-token';
const config = {
    apiUrl: 'https://payment-original.test',
    publishableKey: 'sb_publishable_original_links_test',
  },
  origin = 'https://shop.test';
const servers: Awaited<ReturnType<typeof nativePaymentTestServer>>[] = [],
  stores: Dexie[] = [],
  clients: Awaited<ReturnType<typeof createCopySdk>>[] = [],
  sessions: { stop(): void }[] = [];
let preparedServer: Awaited<ReturnType<typeof nativePaymentTestServer>>;
beforeEach(async () => {
  preparedServer = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
  );
  servers.push(preparedServer);
}, 30000);
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const c of clients.splice(0)) await c.auth.dispose();
  for (const d of stores.splice(0)) await d.delete();
  for (const s of servers.splice(0)) await s.close();
});
async function fixture(large = false) {
  const server = preparedServer;
  const db = new MiseDatabase('payment-original-source-' + newInboxId());
  stores.push(db);
  const setup = await db.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Retained original shop',
    phone: '01712345482',
  });
  const text =
    'Received Tk 15.25\0\ud800 বাংলা' +
    (large ? '\n' + 'literal \" বাংলা\0\ud800'.repeat(400) : '');
  const image = large
    ? new File(
        [
          readFileSync(
            'handover/exports/landing/lp-bd-detail-01-every-channel-one-queue.png',
          ),
        ],
        'original.png',
        { type: 'image/png' },
      )
    : inboxImageFile();
  const item = await db.captureInbox({ text, files: [image] });
  await server.seed(await db.readBackup());
  let after:
    | ((
        op: string,
        id: string,
        response: Response,
        path: string,
      ) => Promise<Response>)
    | undefined;
  const bridge: typeof fetch = async (url, init = {}) => {
    const h = new Headers(init.headers);
    h.set('Origin', origin);
    const response = await server.handle(
      new Request(url, { ...init, headers: h }),
    );
    return after
      ? after(
          h.get('X-Mise-Original-Action') ?? '',
          h.get('X-Mise-Original-Id') ?? '',
          response,
          new URL(String(url)).pathname,
        )
      : response;
  };
  const authScope = 'retention/' + db.name,
    sdk = await createCopySdk(config, authScope, bridge);
  clients.push(sdk);
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
      images: 1,
    },
  });
  const journal = new OriginalCopyJournal('retention-journal-' + newInboxId());
  stores.push(journal);
  const send: typeof fetch = (url, init) =>
    new URL(String(url)).pathname.startsWith('/functions/')
      ? bridge(url, init)
      : sdk.send(url, init);
  const session = await createNativePaymentOutboxSession(db, {
    config,
    authScope,
    auth: sdk.auth,
    storage: sdk.storage,
    journal,
    send,
  });
  sessions.push(session);
  const review = await session.review(item.id, { sender: 'bKash' });
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'wallet',
    methodName: 'bKash',
    reference: 'TESTSOURCE' + item.id,
    receivedAt: item.createdAt,
  });
  await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(db, review, {
      kind: 'counter',
      who: 'Original customer',
    }),
    true,
  );
  return {
    server,
    db,
    setup,
    item,
    text,
    sdk,
    session,
    send,
    bridge,
    authScope,
    journal,
    setAfter: (f?: typeof after) => {
      after = f;
    },
  };
}
async function reader(
  f: Awaited<ReturnType<typeof fixture>>,
  n = 1,
  actorId = f.setup.owner.id,
) {
  const authScope = 'fresh-reader/' + newInboxId(),
    sdk = await createCopySdk(config, authScope, f.bridge, n);
  clients.push(sdk);
  const journal = new OriginalCopyJournal('reader-journal-' + newInboxId());
  stores.push(journal);
  const send: typeof fetch = (url, init) =>
    new URL(String(url)).pathname.startsWith('/functions/')
      ? f.bridge(url, init)
      : sdk.send(url, init);
  const session = await createLinkedPaymentOriginalSession(
    { config, authScope, auth: sdk.auth, storage: sdk.storage, journal, send },
    { businessId: f.setup.business.id, outletId: f.setup.outlet.id, actorId },
  );
  sessions.push(session);
  return { sdk, session, journal };
}
async function action(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = (await f.db.nativePaymentActions.toArray()).map(
    parseNativePaymentOutbox,
  );
  const r = rows.find(
    (r) => r.original.invocation.command.type === 'payment.record',
  );
  expect(r?.nativeReceipt).toBeTruthy();
  return r!;
}
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await f.server.sql.query<{
      sales: number;
      actions: number;
      links: number;
      copies: number;
    }>(
      'select (select count(*)::int from public.sales) sales,(select count(*)::int from private.native_payment_actions) actions,(select count(*)::int from private.payment_original_links) links,(select count(*)::int from private.payment_original_copies) copies',
    )
  ).rows[0];
}
async function manager(f: Awaited<ReturnType<typeof fixture>>) {
  const id = newInboxId();
  try {
    await f.server.sql.query(
      "insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$5,'manager',$4,$4)",
      [
        id,
        f.setup.business.id,
        copySdkSubject(2),
        Date.now(),
        JSON.stringify('Current manager'),
      ],
    );
    await f.server.sql.query(
      'insert into public.member_outlets values($1,$2,$3)',
      [f.setup.business.id, id, f.setup.outlet.id],
    );
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      detail?: string;
      where?: string;
    };
    throw Error(
      'Manager fixture SQL: ' +
        JSON.stringify({
          code: e.code,
          message: e.message,
          detail: e.detail,
          where: e.where,
        }),
    );
  }
  return id;
}
it('a fresh actual SDK reader downloads the exact linked literal source/image/financial original without domain installation or money replay', async () => {
  const f = await fixture(true);
  await f.session.deliver();
  const r = await action(f),
    before = await counts(f),
    fresh = await reader(f);
  const got = await fresh.session.read(r.id),
    proof = readLinkedPaymentOriginal(
      got.link,
      r.original.invocation,
      r.nativeReceipt!,
      got.portable,
    );
  expect(digest(proof.action.source.text)).toBe(digest(f.text));
  expect(proof.action.source.images).toEqual(
    (await f.db.readBackup()).tables.inboxItems[0].images,
  );
  expect(proof.action.after.postings?.[0].receipt.kind).toBe('sale');
  expect(got.link.ref).toEqual(r.seal!.ref);
  expect(await counts(f)).toEqual(before);
  expect(before).toEqual({ sales: 1, actions: 2, links: 2, copies: 1 });
  expect((await f.db.readBackup()).tables.sales).toHaveLength(1);
}, 120000);
it('a current manager retains the origin actor and recovers the complete outlet original after the uploading Auth account and personal copy pool are actually deleted', async () => {
  const f = await fixture();
  await f.session.deliver();
  const r = await action(f),
    id = await manager(f),
    fresh = await reader(f, 2, id);
  await f.server.sql.query('delete from auth.users where id=$1', [
    copySdkSubject(1),
  ]);
  expect(
    (
      await f.server.sql.query<{ n: number }>(
        'select count(*)::int n from private.native_original_copies',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.server.sql.query<{ n: number }>(
        'select count(*)::int n from private.native_original_nodes',
      )
    ).rows[0].n,
  ).toBe(0);
  const got = await fresh.session.read(r.id),
    proof = readLinkedPaymentOriginal(
      got.link,
      r.original.invocation,
      r.nativeReceipt!,
      got.portable,
    );
  expect(fresh.session.identity.actorId).toBe(id);
  expect(got.link.actorId).toBe(f.setup.owner.id);
  expect(proof.action.source.text).toBe(f.text);
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
});
it('expiry during actual outlet-byte persistence rolls retention and feed work back before any native money and the original retry records once', async () => {
  const f = await fixture();
  await f.server.sql.exec(
    `create function public.expire_original_test() returns trigger language plpgsql as $$begin update auth.sessions set not_after=now()-interval '1 second';return new;end$$;create trigger expire_original_test after insert on private.payment_original_copies for each row execute function public.expire_original_test()`,
  );
  await expect(f.session.deliver()).rejects.toThrow();
  expect(await counts(f)).toEqual({
    sales: 0,
    actions: 0,
    links: 0,
    copies: 0,
  });
  expect((await f.db.readBackup()).tables.sales).toHaveLength(1);
  await f.server.sql.exec(
    'drop trigger expire_original_test on private.payment_original_copies;drop function public.expire_original_test()',
  );
  await f.session.deliver();
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
});
it('a lost actual financial-source-link reply recovers the same native receipt and link without another payment or duplicate retained graph', async () => {
  const f = await fixture(),
    record = (await f.db.nativePaymentActions.toArray())
      .map(parseNativePaymentOutbox)
      .find((r) => r.original.invocation.command.type === 'payment.record')!;
  let lost = false;
  f.setAfter(async (op, id, response) => {
    if (!lost && op === 'payment-link' && id === record.id && response.ok) {
      lost = true;
      throw Error('Lost genuine source link reply');
    }
    return response;
  });
  await expect(f.session.deliver()).rejects.toThrow();
  expect(lost).toBe(true);
  const first = await action(f),
    before = await counts(f);
  expect(before).toEqual({ sales: 1, actions: 2, links: 2, copies: 1 });
  await f.session.deliver();
  const final = await action(f);
  expect(final.originalHash).toBe(record.originalHash);
  expect(final.nativeReceipt).toEqual(first.nativeReceipt);
  expect(await counts(f)).toEqual(before);
});
it('current outlet removal between genuine multipart reads denies the next part and preserves original money and source bytes', async () => {
  const f = await fixture(true);
  await f.session.deliver();
  const r = await action(f),
    id = await manager(f),
    fresh = await reader(f, 2, id);
  let revoked = false;
  f.setAfter(async (op, _id, response) => {
    if (!revoked && op === 'payment-read-part' && response.ok) {
      revoked = true;
      await f.server.sql.query(
        'delete from public.member_outlets where member_id=$1',
        [id],
      );
    }
    return response;
  });
  await expect(fresh.session.read(r.id)).rejects.toThrow();
  expect(revoked).toBe(true);
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
  expect((await f.db.readBackup()).tables.inboxItems[0].text).toBe(f.text);
}, 120000);
it('a changed complete-graph root cannot masquerade as the original accepted invocation even when locator shape and hashes are valid', async () => {
  const f = await fixture();
  await f.session.deliver();
  const r = await action(f),
    fresh = await reader(f),
    got = await fresh.session.read(r.id);
  const changed = parseNativePaymentOriginalLink({
    ...got.link,
    ref: { ...got.link.ref, root: 'f'.repeat(64) },
  });
  expect(() =>
    readLinkedPaymentOriginal(
      changed,
      r.original.invocation,
      r.nativeReceipt!,
      got.portable,
    ),
  ).toThrow();
  expect(literalToken((await action(f)).nativeReceipt)).toBe(
    literalToken(r.nativeReceipt),
  );
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
});

it('accepted native money and its original locator share one actual transaction before the financial HTTP response is returned', async () => {
  const f = await fixture();
  await f.session.deliver();
  const r = await action(f),
    receipt = r.nativeReceipt!;
  const rows = (
    await f.server.sql.query<{ table_name: string; transaction_id: string }>(
      "select table_name,transaction_id::text from private.sync_changes where (table_name in ('native_payment_actions','native_payment_events','native_payment_originals') and record_id=$1) or (table_name='sales' and record_id=$2)",
      [r.id, receipt.financial!.receiptId],
    )
  ).rows;
  expect(new Set(rows.map((r) => r.table_name))).toEqual(
    new Set([
      'native_payment_actions',
      'native_payment_events',
      'native_payment_originals',
      'sales',
    ]),
  );
  expect(new Set(rows.map((r) => r.transaction_id)).size).toBe(1);
  expect(
    (
      await f.server.sql.query<{ n: number }>(
        'select count(*)::int n from private.payment_original_stages',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('deleting the uploader after actual money completion but before its response cannot orphan the accepted original on another authorized device', async () => {
  const f = await fixture(),
    id = await manager(f);
  let deleted = false;
  f.setAfter(async (_op, _id, response, path) => {
    if (!deleted && path === '/functions/v1/native-payment' && response.ok) {
      const receipt = await response.clone().json();
      if (receipt.type === 'payment.record') {
        deleted = true;
        await f.server.sql.query('delete from auth.users where id=$1', [
          copySdkSubject(1),
        ]);
      }
    }
    return response;
  });
  await expect(f.session.deliver()).rejects.toThrow();
  expect(deleted).toBe(true);
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
  const raw = (
      await f.server.sql.query<{ intent_json: string; receipt: unknown }>(
        "select intent_json,receipt from private.native_payment_actions where type='payment.record'",
      )
    ).rows[0],
    fresh = await reader(f, 2, id),
    command = JSON.parse(raw.intent_json),
    got = await fresh.session.read(command.command.id);
  const proof = readLinkedPaymentOriginal(
    got.link,
    command,
    raw.receipt as Parameters<typeof readLinkedPaymentOriginal>[2],
    got.portable,
  );
  expect(proof.action.source.text).toBe(f.text);
  expect((await f.db.readBackup()).tables.sales).toHaveLength(1);
}, 30000);
it('a locator persistence failure inside actual native acceptance rolls money and its outcome back while retaining the staged original for one real retry', async () => {
  const f = await fixture();
  await f.server.sql.exec(
    `create function public.reject_original_link_test() returns trigger language plpgsql as $$begin if (new.record_json::jsonb->'ref'->>'revision')::int=2 then raise sqlstate 'PT429' using message='Controlled link capacity failure';end if;return new;end$$;create trigger reject_original_link_test before insert on private.payment_original_links for each row execute function public.reject_original_link_test()`,
  );
  await expect(f.session.deliver()).rejects.toThrow();
  expect(await counts(f)).toEqual({
    sales: 0,
    actions: 1,
    links: 1,
    copies: 1,
  });
  expect((await f.db.readBackup()).tables.sales).toHaveLength(1);
  expect(
    (
      await f.server.sql.query<{ n: number }>(
        'select count(*)::int n from private.payment_original_stages',
      )
    ).rows[0].n,
  ).toBe(1);
  await f.server.sql.exec(
    'drop trigger reject_original_link_test on private.payment_original_links;drop function public.reject_original_link_test()',
  );
  await f.session.deliver();
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
}, 30000);
it('a separately labelled reader actor cannot stand in for the actual current SDK member', async () => {
  const f = await fixture();
  await f.session.deliver();
  await manager(f);
  const r = await action(f),
    labelled = await reader(f, 2, f.setup.owner.id);
  await expect(labelled.session.read(r.id)).rejects.toThrow();
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
});
it('current scoped source reads are revoked without broadening the separate historical-owner copy capability or replaying money', async () => {
  const f = await fixture();
  await f.session.deliver();
  const r = await action(f),
    fresh = await reader(f);
  await f.server.sql.query(
    'update public.members set active=false where id=$1',
    [f.setup.owner.id],
  );
  await expect(fresh.session.read(r.id)).rejects.toThrow();
  const historical = await createOriginalCopyOwnerSession(
    {
      config,
      authScope: f.authScope,
      auth: f.sdk.auth,
      storage: f.sdk.storage,
      journal: f.journal,
      send: f.send,
    },
    {
      businessId: f.setup.business.id,
      outletId: f.setup.outlet.id,
      actorId: f.setup.owner.id,
    },
  );
  sessions.push(historical);
  const original = await historical.readback(r.seal!.copyId);
  expect(original.bases.some((b) => b.root === r.seal!.ref.root)).toBe(true);
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
}, 30000);
it('all five new private tables force RLS and direct client/service reads remain denied while the public wrapper stays invoker-only', async () => {
  const f = await fixture(),
    names = [
      'payment_original_copies',
      'payment_original_nodes',
      'payment_original_membership',
      'payment_original_links',
      'payment_original_stages',
    ];
  const rows = (
    await f.server.sql.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      client: boolean;
      service: boolean;
    }>(
      "select c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('authenticated',c.oid,'select') client,has_table_privilege('service_role',c.oid,'select') service from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any($1::text[])",
      [names],
    )
  ).rows;
  expect(rows).toHaveLength(5);
  for (const row of rows)
    expect(row).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      client: false,
      service: false,
    });
  const funcs = (
    await f.server.sql.query<{
      nspname: string;
      prosecdef: boolean;
      anonymous: boolean;
      service: boolean;
    }>(
      "select n.nspname,p.prosecdef,has_function_privilege('anon',p.oid,'execute') anonymous,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='payment_original' and n.nspname in ('public','private')",
    )
  ).rows;
  expect(funcs).toHaveLength(2);
  expect(funcs.find((f) => f.nspname === 'public')).toMatchObject({
    prosecdef: false,
    anonymous: false,
    service: false,
  });
  expect(funcs.find((f) => f.nspname === 'private')).toMatchObject({
    prosecdef: true,
    anonymous: false,
    service: false,
  });
});
it('an actual foreign-outlet denial occurs before a malicious body getter is consumed', async () => {
  const f = await fixture();
  await f.session.deliver();
  const r = await action(f);
  let consumed = 0;
  const headers = new Headers({
    Origin: origin,
    Authorization: 'Bearer ' + f.sdk.access,
    'Content-Type': 'application/json',
    'X-Mise-Original-Action': 'payment-inspect',
    'X-Mise-Original-Id': r.id,
    'X-Mise-Original-Outlet': newInboxId(),
  });
  const request = {
    url: config.apiUrl + '/functions/v1/native-original-copy',
    method: 'POST',
    headers,
    get body() {
      consumed++;
      throw Error('Body must stay unread');
    },
  } as unknown as Request;
  const response = await f.server.handle(request);
  expect(response.status).toBe(403);
  expect(consumed).toBe(0);
  expect(await counts(f)).toEqual({
    sales: 1,
    actions: 2,
    links: 2,
    copies: 1,
  });
});
