import 'fake-indexeddb/auto';
import { createPhoneAuth } from '../apps/web/src/data/phone-auth';
import {
  createNativeOriginalCopySession,
  createOriginalCopyOwnerSession,
} from '../apps/web/src/data/original-copy-session';
import { createCopySdk } from './fixtures/original-copy-sdk';
import {
  saveCloudConnection,
  cloudConnectionTarget,
} from '../packages/core/cloud-connection';
import { operatorAccountHash } from '../packages/core/operators';
import {
  parsePortableBackup,
  type PortableBackup,
} from '../packages/core/payment-archive';
import { readPaymentOriginalBasis } from '../packages/core/payment-originals';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  it,
  expect,
  vi,
} from 'vitest';
import Dexie from 'dexie';
import { inboxImageFile } from './inbox-fixture';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  OriginalCopyJournal,
  createOriginalCopyRemote,
  type OriginalCopyIdentity,
  type OriginalCopyRemote,
} from '../apps/web/src/data/original-copies';
import {
  originalCopyHandler,
  originalCopyStore,
} from '../supabase/functions/_shared/original-copy-handler';
import {
  prepareOriginalCopy,
  readOriginalCopy,
  type OriginalCopyManifest,
} from '../packages/core/original-copy';
import { sharedJsonWriter, sharedJsonHash } from '../packages/core/shared-json';
import {
  prepareCloudMigration,
  type CloudRecord,
} from '../packages/core/cloud-records';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { retainPaymentOriginal } from '../apps/web/src/data/payment-original-retention';
import { seedPaymentStorage } from './fixtures/payment-storage';
const user = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  origin = 'https://shop.test',
  locals: Dexie[] = [];
let sql: PGlite,
  lastError = '';
let trace = false,
  traceCalls = 0;
const stages = new Set<string>();
function stage(op: string) {
  if (trace) console.log(JSON.stringify({ stage: op }));
}
const current = () => {};
const sdkClients: Awaited<ReturnType<typeof createCopySdk>>[] = [];
const boundSessions: { stop(): void }[] = [];
beforeAll(async () => {
  sql = await PGlite.create();
  for (const f of ['supabase-auth.sql', 'supabase-storage.sql'])
    await sql.exec(
      readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'),
    );
  await sql.exec(
    'create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz)',
  );
  for (const f of readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await sql.exec(readFileSync('supabase/migrations/' + f, 'utf8'));
  for (const n of [1, 2])
    await sql.query(
      'insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',
      [user(n), '880171234548' + n],
    );
}, 30000);
beforeEach(async () => {
  lastError = '';
  trace = false;
  traceCalls = 0;
  stages.clear();
  await sql.exec(
    'truncate public.businesses cascade;truncate private.native_original_copies,private.native_original_nodes,private.native_original_parts,private.native_original_membership,private.native_original_budgets cascade',
  );
  await sql.exec(
    'update auth.users set phone_confirmed_at=now(),deleted_at=null,banned_until=null,is_anonymous=false',
  );
  for (const n of [1, 2])
    await sql.query(
      'insert into auth.sessions(id,user_id) values($1,$2) on conflict(id) do update set user_id=excluded.user_id,not_after=null',
      [user(n + 100), user(n)],
    );
});
afterEach(async () => {
  for (const session of boundSessions.splice(0)) session.stop();
  for (const sdk of sdkClients.splice(0)) await sdk.auth.dispose();
  for (const db of locals.splice(0)) await db.delete();
});
afterAll(async () => {
  await sql.close();
});
async function asUser<T>(
  n: number,
  query: string,
  args: unknown[] = [],
  role = 'authenticated',
) {
  return sql.transaction(async (db) => {
    await db.exec('set local role ' + role);
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({
        sub: user(n),
        session_id: user(n + 100),
        role,
        user_metadata: { role: 'owner' },
      }),
    ]);
    return (await db.query<T>(query, args)).rows;
  });
}
async function rpc(
  n: number,
  op: string,
  outlet: string,
  id: string,
  body: unknown,
) {
  return (
    await asUser<{ v: unknown }>(
      n,
      'select public.native_original_copy($1,$2,$3,$4::jsonb) v',
      [op, outlet, id, JSON.stringify(body)],
    )
  )[0].v;
}
function wire(
  n = 1,
  before?: (op: string) => Promise<void>,
  expectedJwt?: string,
) {
  const rpcFetch: typeof fetch = async (_url, init) => {
    if (
      expectedJwt &&
      new Headers(init?.headers).get('Authorization') !==
        'Bearer ' + expectedJwt
    )
      return new Response('{}', { status: 401 });
    const a = JSON.parse(init!.body as string);
    try {
      await before?.(a.p_op);
      if (trace && (!stages.has(a.p_op) || ++traceCalls % 100 === 0)) {
        stages.add(a.p_op);
        stage('sql-start-' + a.p_op + '-' + traceCalls);
      }
      const v = await rpc(n, a.p_op, a.p_outlet_id, a.p_copy_id, a.p_body);
      if (trace && a.p_op === 'finish') stage('sql-finished');
      return new Response(JSON.stringify(v));
    } catch (e) {
      const x = e as { code?: string; message?: string; where?: string };
      lastError = x.code + ' ' + x.message + ' ' + x.where?.slice(0, 400);
      const status =
        x.code === '42501'
          ? 403
          : x.code === '23505' || x.code === 'PT409'
            ? 409
            : x.code === 'PT429'
              ? 429
              : x.code?.startsWith('22')
                ? 400
                : 500;
      return new Response(JSON.stringify({ code: x.code }), { status });
    }
  };
  const handler = originalCopyHandler(
    new Set([origin]),
    originalCopyStore('https://backend.test', 'sb_publishable_test', rpcFetch),
  );
  const edgeFetch: typeof fetch = async (url, init) =>
    handler(
      new Request(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init!.headers)),
          Origin: origin,
        },
      }),
    );
  return { handler, edgeFetch, rpcFetch };
}
async function insert(records: CloudRecord[]) {
  const grouped = new Map<string, CloudRecord[]>();
  for (const row of records) {
    const list = grouped.get(row.table) ?? [];
    list.push(row);
    grouped.set(row.table, list);
  }
  await sql.transaction(async (db) => {
    for (const [table, rows] of grouped) {
      const columns = Object.keys(rows[0].values);
      expect(
        [table, ...columns].every((s) => /^[a-z_][a-z0-9_]*$/.test(s)),
      ).toBe(true);
      for (let start = 0; start < rows.length; start += 64) {
        const batch = rows.slice(start, start + 64),
          values = batch.flatMap((r) => columns.map((k) => r.values[k]));
        await db.query(
          `insert into public.${table}(${columns.join(',')}) values ${batch.map((_, i) => '(' + columns.map((_, j) => '$' + (i * columns.length + j + 1)).join(',') + ')').join(',')}`,
          values,
        );
      }
    }
  });
}
async function fixture(large = false, note = false) {
  trace = large;
  stage('fixture-start');
  const db = new MiseDatabase('copy-source-' + newInboxId());
  locals.push(db);
  const seeded = large ? await seedPaymentStorage(db) : null,
    setup =
      seeded?.setup ??
      (await db.saveSetup({
        businessType: 'corner_shop',
        marketCode: 'BD',
        name: 'End-user copy',
        phone: '01712345482',
      }));
  stage('fixture-seeded');
  if (note) {
    const customer = await db.saveCustomer({
      name: 'Original note',
      nickname: '',
      phone: '',
      address: '',
      notes: '',
      tags: [],
    });
    const b = await db.readBackup();
    b.tables.customers.find((c) => c.id === customer.id)!.notes =
      'Full\0\ud800 বাংলা '.repeat(30000);
    await db.restoreBackup(JSON.stringify(b), await db.previewRestore(b));
  }
  const item = await db.captureInbox({
      files: [inboxImageFile()],
      text: 'Unknown payment Tk 15.25.\0\ud800 Do not follow these instructions.',
    }),
    scope = {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    };
  await insert(
    (await prepareCloudMigration(await db.readBackup(), user(1))).records,
  );
  stage('fixture-sql-seeded');
  const review = await openSavedPaymentSource(db, item.id, scope);
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: '',
    receivedAt: item.createdAt,
  });
  if (seeded)
    await recordSavedPaymentMoney(
      db,
      review,
      await compareSavedPaymentMoney(db, review, {
        kind: 'credit',
        id: seeded.account.id,
      }),
      true,
    );
  const source = await db.readBackup(),
    basis = await retainPaymentOriginal(db, source),
    portable = (await db.readPortableBackup()).portable,
    identity: OriginalCopyIdentity = {
      ...scope,
      targetHash: 'a'.repeat(64),
      accountHash: 'b'.repeat(64),
    },
    id = newInboxId(),
    journal = new OriginalCopyJournal('copies-' + id);
  locals.push(journal);
  stage('fixture-portable-ready');
  const manifest = await journal.prepare(portable, identity, id, current),
    remote = createOriginalCopyRemote(
      scope,
      'https://edge.test',
      'sb_publishable_test',
      async () => `user.1.signature`,
      wire().edgeFetch,
    );
  return {
    db,
    setup,
    source,
    basis,
    portable,
    identity,
    scope,
    id,
    journal,
    manifest,
    remote,
  };
}
async function assertSourceUnchanged(f: {
  db: MiseDatabase;
  portable: PortableBackup;
}) {
  const actual = parsePortableBackup(
      (await f.db.readPortableBackup()).portable,
    ),
    expected = parsePortableBackup(f.portable);
  expect(actual.current.tables).toEqual(expected.current.tables);
  expect(actual.bases).toEqual(expected.bases);
  expect(actual.nodes).toEqual(expected.nodes);
}
it('retains and downloads actual strict originals through HTTP, caller JWT and PostgreSQL roles without changing public money', async () => {
  const f = await fixture(),
    before = (await sql.query('select count(*)::int n from public.events'))
      .rows;
  const receipt = await f.journal.deliver(f.id, f.identity, f.remote, current);
  expect(receipt.verification).toBe('content-addressed-copy');
  const read = await f.journal.readback(f.id, f.identity, f.remote, current);
  expect(read.bases[0]).toEqual(f.basis);
  expect(read.current.tables.payments[0].original.text).toContain('\0\ud800');
  expect((await f.journal.copies.get(f.id))!.verified).toBe(true);
  expect(
    (await sql.query('select count(*)::int n from public.events')).rows,
  ).toEqual(before);
  expect(await f.journal.deliver(f.id, f.identity, f.remote, current)).toEqual(
    receipt,
  );
});
it('recovers a genuinely lost completion reply with the same original receipt after native journal reload', async () => {
  const f = await fixture();
  let lose = true;
  const remote: OriginalCopyRemote = {
    scope: f.scope,
    async call(op, id, body) {
      const v = await f.remote.call(op, id, body);
      if (op === 'finish' && lose) {
        lose = false;
        throw Error('Lost completed reply');
      }
      return v;
    },
  };
  await expect(
    f.journal.deliver(f.id, f.identity, remote, current),
  ).rejects.toThrow('Lost');
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  f.journal.close();
  await f.journal.open();
  const restored = await f.journal.deliver(f.id, f.identity, f.remote, current);
  expect(restored).toEqual(
    (
      (await rpc(1, 'inspect', f.scope.outletId, f.id, {})) as {
        receipt: unknown;
      }
    ).receipt,
  );
  await f.journal.readback(f.id, f.identity, f.remote, current);
});
it('reuses unchanged content addresses across distinct original copy identities', async () => {
  const f = await fixture();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  const before = (
      await sql.query<{ n: number }>(
        'select count(*)::int n from private.native_original_nodes',
      )
    ).rows[0].n,
    id = newInboxId();
  await f.journal.prepare(f.portable, f.identity, id, current);
  await f.journal.deliver(id, f.identity, f.remote, current);
  expect(
    (
      await sql.query<{ n: number }>(
        'select count(*)::int n from private.native_original_nodes',
      )
    ).rows[0].n,
  ).toBe(before);
});
it('resumes complete multipart UTF-8 nodes without truncating NUL, Bengali or surrogate data', async () => {
  const f = await fixture(false, true);
  let lost = false;
  const remote: OriginalCopyRemote = {
    scope: f.scope,
    async call(op, id, body) {
      const v = await f.remote.call(op, id, body);
      if (op === 'part' && !lost) {
        lost = true;
        throw Error('Lost node part');
      }
      return v;
    },
  };
  await expect(
    f.journal.deliver(f.id, f.identity, remote, current),
  ).rejects.toThrow('Lost node');
  expect(
    (await sql.query('select * from private.native_original_parts')).rows
      .length,
  ).toBeGreaterThan(0);
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  const copy = await f.journal.readback(f.id, f.identity, f.remote, current);
  expect(copy.current.tables.customers[0].notes).toBe(
    f.source.tables.customers[0].notes,
  );
});
it('cannot reuse an original ID for a different declared graph', async () => {
  const f = await fixture();
  await f.remote.call('begin', f.id, { manifest: literalToken(f.manifest) });
  await expect(
    f.remote.call('begin', f.id, {
      manifest: literalToken({ ...f.manifest, root: 'c'.repeat(64) }),
    }),
  ).rejects.toThrow();
  expect(
    (
      (await rpc(1, 'inspect', f.scope.outletId, f.id, {})) as {
        manifest: unknown;
      }
    ).manifest,
  ).toEqual(f.manifest);
});
it('denies a different account before reading a body and ignores editable owner claims', async () => {
  const f = await fixture();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  let consumed = 0;
  const body = new ReadableStream(
    {
      pull(c) {
        consumed++;
        c.enqueue(new TextEncoder().encode('{}'));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request('https://edge.test/copy', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user.2.signature',
      'Content-Type': 'application/json',
      'X-Mise-Original-Action': 'inspect',
      'X-Mise-Original-Id': f.id,
      'X-Mise-Original-Outlet': f.scope.outletId,
    },
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await wire(2).handler(request);
  expect(response.status, lastError).toBe(403);
  expect(consumed).toBe(0);
});
for (const revoke of [
  'inactive',
  'role',
  'assignment',
  'unconfirmed',
  'deleted',
  'banned',
  'anonymous',
  'signed-out',
  'expired-session',
  'session-owner',
] as const)
  it('rechecks ' + revoke + ' immediately before storing a node', async () => {
    const f = await fixture();
    await f.remote.call('begin', f.id, { manifest: literalToken(f.manifest) });
    if (revoke === 'assignment') {
      await sql.query("update public.members set role='manager' where id=$1", [
        f.scope.actorId,
      ]);
      await sql.query(
        'insert into public.member_outlets(business_id,member_id,outlet_id) values($1,$2,$3) on conflict do nothing',
        [f.scope.businessId, f.scope.actorId, f.scope.outletId],
      );
    }
    let checked = false;
    const hooked = wire(1, async (op) => {
      if (op !== 'put') return;
      checked = true;
      if (revoke === 'inactive')
        await sql.query('update public.members set active=false where id=$1', [
          f.scope.actorId,
        ]);
      else if (revoke === 'role')
        await sql.query(
          "update public.members set role='kitchen' where id=$1",
          [f.scope.actorId],
        );
      else if (revoke === 'assignment')
        await sql.query(
          'delete from public.member_outlets where member_id=$1',
          [f.scope.actorId],
        );
      else if (revoke === 'signed-out')
        await sql.query('delete from auth.sessions where id=$1', [user(101)]);
      else if (revoke === 'expired-session')
        await sql.query(
          "update auth.sessions set not_after=now()-interval '1 second' where id=$1",
          [user(101)],
        );
      else if (revoke === 'session-owner')
        await sql.query('update auth.sessions set user_id=$2 where id=$1', [
          user(101),
          user(2),
        ]);
      else
        await sql.query(
          `update auth.users set ${revoke === 'unconfirmed' ? 'phone_confirmed_at=null' : revoke === 'deleted' ? 'deleted_at=now()' : revoke === 'banned' ? "banned_until=now()+interval '1 hour'" : 'is_anonymous=true'} where id=$1`,
          [user(1)],
        );
    });
    const remote = createOriginalCopyRemote(
      f.scope,
      'https://edge.test',
      'sb_publishable_test',
      async () => `user.1.signature`,
      hooked.edgeFetch,
    );
    const node = prepareOriginalCopy(f.portable, f.scope, f.id).nodes[0];
    await expect(remote.call('put', f.id, { nodes: [node] })).rejects.toThrow();
    expect(checked).toBe(true);
    expect(
      (await sql.query('select * from private.native_original_nodes')).rows,
    ).toHaveLength(0);
  });
it('keeps own completed copies readable after membership removal while denying new uploads', async () => {
  const f = await fixture();
  const receipt = await f.journal.deliver(f.id, f.identity, f.remote, current);
  await sql.query('update public.members set active=false where id=$1', [
    f.scope.actorId,
  ]);
  expect(await f.remote.call('finish', f.id, {})).toEqual(receipt);
  expect(
    (await f.journal.readback(f.id, f.identity, f.remote, current)).bases,
  ).toEqual([f.basis]);
  await expect(
    f.remote.call('begin', newInboxId(), {
      manifest: literalToken({ ...f.manifest, id: newInboxId() }),
    }),
  ).rejects.toThrow();
});
it('requires every reachable node and atomic membership before issuing an immutable copy receipt', async () => {
  const f = await fixture();
  await f.remote.call('begin', f.id, { manifest: literalToken(f.manifest) });
  await expect(
    rpc(1, 'finish', f.scope.outletId, f.id, {}),
  ).rejects.toMatchObject({ code: 'PT409' });
  expect(
    (
      (await rpc(1, 'inspect', f.scope.outletId, f.id, {})) as {
        receipt: unknown;
      }
    ).receipt,
  ).toBeNull();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  const before = (
    await sql.query(
      'select count(*)::int n from private.native_original_membership',
    )
  ).rows;
  await f.remote.call('finish', f.id, {});
  expect(
    (
      await sql.query(
        'select count(*)::int n from private.native_original_membership',
      )
    ).rows,
  ).toEqual(before);
});
it('never treats a structural copy receipt as accepted original financial evidence', async () => {
  const f = await fixture(),
    json = literalToken(['s', 'not an archive']),
    digest = sharedJsonHash(json),
    m: OriginalCopyManifest = {
      ...f.manifest,
      id: newInboxId(),
      root: digest,
      nodeCount: 1,
      nodeBytes: new TextEncoder().encode(json).length,
    };
  await rpc(1, 'begin', f.scope.outletId, m.id, { manifest: literalToken(m) });
  await rpc(1, 'put', f.scope.outletId, m.id, { nodes: [{ digest, json }] });
  await rpc(1, 'verify', f.scope.outletId, m.id, {});
  const receipt = await rpc(1, 'finish', f.scope.outletId, m.id, {});
  expect((receipt as { verification: string }).verification).toBe(
    'content-addressed-copy',
  );
  expect(() => readOriginalCopy(m, () => json)).toThrow();
  expect(
    (await sql.query('select count(*)::int n from public.sales')).rows[0],
  ).toEqual({ n: 0 });
});
it('retains the private original unconfirmed when the actual account changes after remote completion', async () => {
  const f = await fixture();
  let active = true;
  const remote: OriginalCopyRemote = {
    scope: f.scope,
    async call(op, id, body) {
      const v = await f.remote.call(op, id, body);
      if (op === 'finish') active = false;
      return v;
    },
  };
  await expect(
    f.journal.deliver(f.id, f.identity, remote, () => {
      if (!active) throw Error('Account changed');
    }),
  ).rejects.toThrow('Account changed');
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
});
it('private source storage and helper functions expose no direct table or public definer access', async () => {
  const rows = (
    await sql.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('native_original_copies','native_original_nodes','native_original_parts','native_original_membership','native_original_budgets')",
    )
  ).rows;
  expect(rows).toHaveLength(5);
  expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
    true,
  );
  for (const role of ['anon', 'authenticated', 'service_role'])
    for (const r of rows)
      await expect(
        asUser(1, 'select * from private.' + r.relname, [], role),
      ).rejects.toMatchObject({ code: '42501' });
  expect(
    (
      await sql.query(
        "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'native_original%' and p.prosecdef",
      )
    ).rows,
  ).toEqual([]);
});

it('keeps copy helpers private, invoker entrypoints scoped and every new foreign-key prefix indexed', async () => {
  const functions = (
    await sql.query<{
      oid: number;
      nspname: string;
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      "select p.oid,n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'native_original_%'",
    )
  ).rows;
  expect(functions).toHaveLength(3);
  for (const f of functions) {
    expect(f.proconfig).toContain('search_path=""');
    if (f.nspname === 'public') expect(f.prosecdef).toBe(false);
    for (const role of ['anon', 'authenticated', 'service_role'])
      expect(
        (
          await sql.query<{ allowed: boolean }>(
            "select has_function_privilege($1,$2::oid,'EXECUTE') allowed",
            [role, f.oid],
          )
        ).rows[0].allowed,
      ).toBe(role === 'authenticated' && f.proname === 'native_original_copy');
  }
  const indexes = (
    await sql.query<{ indexname: string; indexdef: string }>(
      "select indexname,indexdef from pg_indexes where schemaname='private' and tablename like 'native_original_%'",
    )
  ).rows;
  expect(indexes).toHaveLength(7);
  for (const name of [
    'native_original_copies_owner',
    'native_original_nodes_pkey',
    'native_original_parts_pkey',
    'native_original_budgets_pkey',
  ])
    expect(indexes.find((i) => i.indexname === name)!.indexdef).toContain(
      '(owner_uid',
    );
  expect(
    indexes.find((i) => i.indexname === 'native_original_membership_pkey')!
      .indexdef,
  ).toContain('(copy_id, digest)');
});
it('rolls a partial node batch back on a bad hash without changing the retained original', async () => {
  const f = await fixture(),
    nodes = prepareOriginalCopy(f.portable, f.scope, f.id).nodes;
  await f.remote.call('begin', f.id, { manifest: literalToken(f.manifest) });
  await expect(
    rpc(1, 'put', f.scope.outletId, f.id, {
      nodes: [nodes[0], { ...nodes[1], digest: 'f'.repeat(64) }],
    }),
  ).rejects.toThrow();
  expect(
    (await sql.query('select * from private.native_original_nodes')).rows,
  ).toHaveLength(0);
  await assertSourceUnchanged(f);
});
it('rolls local preparation back on genuine quota failure before any transfer', async () => {
  const f = await fixture(),
    journal = new OriginalCopyJournal('quota-' + newInboxId());
  locals.push(journal);
  journal.values.hook('creating', () => {
    throw new DOMException('Full storage', 'QuotaExceededError');
  });
  await expect(
    journal.prepare(f.portable, f.identity, newInboxId(), current),
  ).rejects.toThrow();
  expect(await journal.copies.count()).toBe(0);
  expect(await journal.values.count()).toBe(0);
  await assertSourceUnchanged(f);
});
it('recovers the same remote receipt after actual local receipt quota failure', async () => {
  const f = await fixture();
  const fail = () => {
    throw new DOMException('Receipt storage full', 'QuotaExceededError');
  };
  f.journal.copies.hook('updating', fail);
  await expect(
    f.journal.deliver(f.id, f.identity, f.remote, current),
  ).rejects.toThrow();
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  const server = (await rpc(1, 'inspect', f.scope.outletId, f.id, {})) as {
    receipt: unknown;
  };
  expect(server.receipt).not.toBeNull();
  f.journal.copies.hook('updating').unsubscribe(fail);
  expect(await f.journal.deliver(f.id, f.identity, f.remote, current)).toEqual(
    server.receipt,
  );
  await assertSourceUnchanged(f);
});
it('rejects a different private target before the first network call', async () => {
  const f = await fixture();
  let calls = 0;
  const remote = {
    scope: f.scope,
    async call() {
      calls++;
      throw Error('Unexpected network');
    },
  };
  await expect(
    f.journal.deliver(
      f.id,
      { ...f.identity, targetHash: 'c'.repeat(64) },
      remote,
      current,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it('never confirms a corrupt download or allocates a node beyond the declared complete graph', async () => {
  const f = await fixture();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  for (const oversized of [false, true]) {
    const remote: OriginalCopyRemote = {
      scope: f.scope,
      async call(op, id, body) {
        const value = await f.remote.call(op, id, body);
        if (op === 'read')
          return oversized
            ? {
                nodes: [],
                large: [
                  { digest: f.manifest.root, bytes: f.manifest.nodeBytes + 1 },
                ],
              }
            : {
                nodes: [{ digest: f.manifest.root, json: '["s","corrupt"]' }],
                large: [],
              };
        return value;
      },
    };
    await expect(
      f.journal.readback(f.id, f.identity, remote, current),
    ).rejects.toThrow();
    expect((await f.journal.copies.get(f.id))!.verified).toBe(false);
  }
  await assertSourceUnchanged(f);
});
it('rejects excessive and indefinitely stalled response streams without disclosing backend errors', async () => {
  const scope = {
    businessId: newInboxId(),
    outletId: newInboxId(),
    actorId: newInboxId(),
  };
  let cancelled = false;
  const excessive: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(256001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const remote = createOriginalCopyRemote(
    scope,
    'https://edge.test',
    'sb_publishable_test',
    async () => 'user.1.signature',
    excessive,
  );
  await expect(remote.call('inspect', newInboxId(), {})).rejects.toThrow(
    'local backup',
  );
  expect(cancelled).toBe(true);
  vi.useFakeTimers();
  try {
    const stalled: typeof fetch = async () =>
      new Response(new ReadableStream({}));
    const other = createOriginalCopyRemote(
      scope,
      'https://edge.test',
      'sb_publishable_test',
      async () => 'user.1.signature',
      stalled,
    );
    const result = expect(
      other.call('inspect', newInboxId(), {}),
    ).rejects.toThrow('local backup');
    await vi.advanceTimersByTimeAsync(20001);
    await result;
  } finally {
    vi.useRealTimers();
  }
});
it('the exact configuration-free deployment bundle runs the real SQL copy protocol and keeps empty installation configuration usable offline', async () => {
  // @ts-expect-error Standalone deployment packager.
  const { edgeBundle } = await import('../scripts/edge-bundle.mjs'),
    bundle = await edgeBundle('native-original-copy');
  expect(bundle.runtimeImports).toEqual([]);
  expect(bundle.sourceHashes).toHaveProperty(
    'packages/core/original-copy-wire.ts',
  );
  const runtime = globalThis as unknown as { Deno?: unknown },
    oldDeno = runtime.Deno,
    oldFetch = globalThis.fetch;
  let handler: ((r: Request) => Promise<Response>) | undefined;
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://backend.test',
    MISE_PUBLISHABLE_API_KEY: 'sb_publishable_test',
    MISE_ALLOWED_ORIGINS: origin,
  };
  try {
    runtime.Deno = {
      env: { get: (k: string) => env[k] },
      serve: (h: typeof handler) => {
        handler = h;
      },
    };
    globalThis.fetch = wire().rpcFetch;
    const url =
      'data:text/javascript;base64,' +
      Buffer.from(bundle.files[0].content).toString('base64');
    await import(url + '#copy-configured');
    const f = await fixture();
    const send: typeof fetch = async (url, init) =>
      handler!(new Request(url, init));
    const remote = createOriginalCopyRemote(
      f.scope,
      'https://edge.test',
      'sb_publishable_test',
      async () => 'user.1.signature',
      send,
    );
    await f.journal.deliver(f.id, f.identity, remote, current);
    expect(
      (await f.journal.readback(f.id, f.identity, remote, current)).bases,
    ).toEqual([f.basis]);
    for (const k of Object.keys(env)) delete env[k];
    await import(url + '#copy-empty');
    const response = await handler!(
      new Request('https://edge.test/copy', { method: 'POST' }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('local backup');
  } finally {
    runtime.Deno = oldDeno;
    globalThis.fetch = oldFetch;
  }
}, 30000);
it('transfers the unchanged 5,000-charge history, complete million-code-unit note, real collection and original image through bounded HTTP/SQL and cold journal readback', async () => {
  const f = await fixture(true);
  console.log(
    JSON.stringify({
      stage: 'original-copy-scale-prepared',
      nodeCount: f.manifest.nodeCount,
      nodeBytes: f.manifest.nodeBytes,
    }),
  );
  const before = (
    await sql.query('select count(*)::int n from public.credit_entries')
  ).rows;
  const receipt = await f.journal.deliver(f.id, f.identity, f.remote, current);
  console.log(JSON.stringify({ stage: 'original-copy-scale-delivered' }));
  f.journal.close();
  await f.journal.open();
  const copy = await f.journal.readback(f.id, f.identity, f.remote, current);
  expect(receipt.nodeCount).toBe(f.manifest.nodeCount);
  expect(
    copy.current.tables.creditEntries.filter((e) => e.type === 'charge'),
  ).toHaveLength(5000);
  expect(
    copy.current.tables.creditEntries.filter((e) => e.type === 'payment'),
  ).toHaveLength(1);
  expect(copy.current.tables.customers[0].notes).toBe(
    f.source.tables.customers[0].notes,
  );
  expect(copy.current.tables.customers[0].notes).toHaveLength(1000000);
  expect(copy.current.tables.inboxItems[0].images[0].data).toBe(
    f.source.tables.inboxItems[0].images[0].data,
  );
  expect(copy.bases).toEqual([f.basis]);
  const originalNodes = new Map(copy.nodes.map((n) => [n.digest, n.json]));
  expect(
    readPaymentOriginalBasis(copy.bases[0], (key) => originalNodes.get(key)),
  ).toEqual(f.source);
  expect(
    (await sql.query('select count(*)::int n from public.credit_entries')).rows,
  ).toEqual(before);
  console.log(
    JSON.stringify({
      stage: 'original-copy-scale',
      charges: 5000,
      noteCodeUnits: 1000000,
      nodeCount: receipt.nodeCount,
      nodeBytes: receipt.nodeBytes,
      originalCollections: 1,
      images: 1,
      verified: true,
    }),
  );
}, 600000);

it('recovers a complete known original to a new empty journal using only the same current account, without replacing current shop money', async () => {
  const f = await fixture();
  const receipt = await f.journal.deliver(f.id, f.identity, f.remote, current);
  const fresh = new OriginalCopyJournal('fresh-copy-' + newInboxId());
  locals.push(fresh);
  await sql.query('update public.members set active=false where id=$1', [
    f.scope.actorId,
  ]);
  const copy = await fresh.recover(f.id, f.identity, f.remote, current);
  expect(copy.bases).toEqual([f.basis]);
  expect((await fresh.copies.get(f.id))!.receipt).toEqual(receipt);
  expect((await fresh.copies.get(f.id))!.verified).toBe(true);
  expect(await fresh.values.count()).toBe(f.manifest.nodeCount);
  await assertSourceUnchanged(f);
});
it('rejects a signed-out account before consuming an own-copy download body', async () => {
  const f = await fixture();
  await f.journal.deliver(f.id, f.identity, f.remote, current);
  await sql.query('delete from auth.sessions where id=$1', [user(101)]);
  let consumed = 0;
  const body = new ReadableStream(
    {
      pull(c) {
        consumed++;
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await wire().handler(
    new Request('https://edge.test/copy', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user.1.signature',
        'Content-Type': 'application/json',
        'X-Mise-Original-Action': 'inspect',
        'X-Mise-Original-Id': f.id,
        'X-Mise-Original-Outlet': f.scope.outletId,
      },
      body,
      duplex: 'half',
    } as RequestInit),
  );
  expect(response.status).toBe(403);
  expect(consumed).toBe(0);
});
it('reserves the finite per-account copy index before accepting a new graph', async () => {
  const f = await fixture();
  await f.remote.call('begin', f.id, { manifest: literalToken(f.manifest) });
  // Trusted fixture simulates already-reserved graph index entries without allocating a huge payload.
  await sql.query(
    'update private.native_original_copies set node_count=1638400 where id=$1',
    [f.id],
  );
  const id = newInboxId();
  await expect(
    rpc(1, 'begin', f.scope.outletId, id, {
      manifest: literalToken({ ...f.manifest, id }),
    }),
  ).rejects.toMatchObject({ code: 'PT429' });
  expect(
    (await sql.query('select * from private.native_original_copies')).rows,
  ).toHaveLength(1);
});

it('rejects a fully hashed original whose transport header falsely claims another shop scope', async () => {
  const f = await fixture();
  if (f.portable.formatVersion !== 2) throw Error('Expected original graph');
  const scope = {
      businessId: newInboxId(),
      outletId: newInboxId(),
      actorId: f.scope.actorId,
    },
    writer = sharedJsonWriter(
      new Map(f.portable.values.map((n) => [n.digest, n.json])),
    );
  const header = writer.write({
    format: 'mise-original-copy-header',
    version: 1,
    scope,
    exportedAt: f.portable.exportedAt,
    bases: f.portable.bases,
    originals: f.portable.originals,
  });
  const rootJson = literalToken([
      'a',
      [header, f.portable.current, ...f.portable.originals.map((n) => n.value)],
    ]),
    root = sharedJsonHash(rootJson);
  writer.nodes.set(root, rootJson);
  const manifest = {
    ...f.manifest,
    ...scope,
    root,
    nodeCount: writer.nodes.size,
    nodeBytes: [...writer.nodes.values()].reduce(
      (n, json) => n + new TextEncoder().encode(json).length,
      0,
    ),
  };
  expect(() =>
    readOriginalCopy(manifest, (key) => writer.nodes.get(key)),
  ).toThrow();
});

it('refuses accidental credential-bearing identity objects before private journal persistence', async () => {
  const f = await fixture(),
    journal = new OriginalCopyJournal('identity-' + newInboxId());
  locals.push(journal);
  const accidental = {
    ...f.identity,
    url: 'https://backend.test',
    publishableKey: 'sb_publishable_test',
  };
  await expect(
    journal.prepare(f.portable, accidental, newInboxId(), current),
  ).rejects.toThrow();
  expect(await journal.copies.count()).toBe(0);
  expect(await journal.values.count()).toBe(0);
});

it('resumes a lost verification-step reply without publishing a partial archive or duplicating membership', async () => {
  const f = await fixture();
  let lost = false;
  const remote: OriginalCopyRemote = {
    scope: f.scope,
    async call(op, id, body) {
      const result = await f.remote.call(op, id, body);
      if (op === 'verify' && !lost) {
        lost = true;
        throw Error('Lost verification reply');
      }
      return result;
    },
  };
  await expect(
    f.journal.deliver(f.id, f.identity, remote, current),
  ).rejects.toThrow('Lost verification');
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await expect(
    rpc(1, 'read', f.scope.outletId, f.id, { digests: [f.manifest.root] }),
  ).rejects.toMatchObject({ code: 'PT409' });
  const result = await f.journal.deliver(f.id, f.identity, f.remote, current);
  expect(result.nodeCount).toBe(f.manifest.nodeCount);
  expect(
    (
      await sql.query(
        'select count(*)::int n from private.native_original_membership where copy_id=$1',
        [f.id],
      )
    ).rows[0],
  ).toEqual({ n: f.manifest.nodeCount });
});

const boundConfig = {
  apiUrl: 'https://edge.test',
  publishableKey: 'sb_publishable_test',
};
async function boundFixture(prepare = true, note = false) {
  const f = await fixture(false, note),
    authScope = '/mise/app/' + f.scope.businessId;
  let network: typeof fetch = async () => {
    throw Error('Unconfigured fixture.');
  };
  const sdk = await createCopySdk(boundConfig, authScope, (url, init) =>
    network(url, init),
  );
  sdkClients.push(sdk);
  network = wire(1, undefined, sdk.access).edgeFetch;
  const journal = new OriginalCopyJournal('bound-copies-' + newInboxId());
  locals.push(journal);
  const options = {
      config: boundConfig,
      authScope,
      auth: sdk.auth,
      storage: sdk.storage,
      journal,
      send: sdk.send,
    },
    session = await createNativeOriginalCopySession(f.db, options),
    id = newInboxId();
  boundSessions.push(session);
  const manifest = prepare ? await session.prepare(id) : null;
  return { ...f, sdk, journal, session, options, id, manifest };
}
function locked(f: Awaited<ReturnType<typeof boundFixture>>) {
  return {
    id: 'active' as const,
    version: 1 as const,
    revision: 1,
    phase: 'locked' as const,
    ...f.scope,
    role: 'owner' as const,
    connection: null,
  };
}
it('the actual SDK copy controller derives its own identity and transfers, downloads and verifies strict originals without money', async () => {
  const f = await boundFixture(),
    before = (await sql.query('select count(*)::int n from public.events'))
      .rows;
  expect(f.session.identity).toEqual({
    ...f.scope,
    accountHash: await operatorAccountHash(user(1)),
    targetHash: await cloudConnectionTarget(
      boundConfig,
      f.options.authScope,
      user(1),
    ),
  });
  expect(Object.isFrozen(f.session.identity)).toBe(true);
  const receipt = await f.session.deliver(f.id),
    downloaded = await f.session.readback(f.id);
  expect(downloaded.bases[0]).toEqual(f.basis);
  expect(downloaded.current.tables.payments).toEqual(f.source.tables.payments);
  expect(receipt.verification).toBe('content-addressed-copy');
  expect((await f.journal.copies.get(f.id))!.verified).toBe(true);
  const requests = f.sdk.calls.filter((c) => c.path.includes('/functions/'));
  expect(requests.length).toBeGreaterThan(5);
  expect(
    requests.every((c) => c.authorization === 'Bearer ' + f.sdk.access),
  ).toBe(true);
  expect(f.sdk.calls.some((c) => /otp|verify|settings/.test(c.path))).toBe(
    false,
  );
  const saved = JSON.stringify([
    await f.journal.copies.toArray(),
    await f.journal.values.toArray(),
  ]);
  for (const privateValue of [
    boundConfig.apiUrl,
    boundConfig.publishableKey,
    f.sdk.access,
    f.sdk.saved.refresh_token,
    user(1),
  ])
    expect(saved).not.toContain(privateValue);
  expect(
    (await sql.query('select count(*)::int n from public.events')).rows,
  ).toEqual(before);
  await assertSourceUnchanged(f);
});
it.each(['project', 'publishable-key', 'auth-scope'] as const)(
  'rejects an SDK/configuration %s mismatch before private persistence or copy HTTP',
  async (wrong) => {
    const f = await boundFixture(false),
      config = { ...boundConfig };
    if (wrong === 'project') config.apiUrl = 'https://another.test';
    if (wrong === 'publishable-key')
      config.publishableKey = 'sb_publishable_another_test';
    saveCloudConnection(f.sdk.storage, config);
    await expect(
      createNativeOriginalCopySession(f.db, {
        ...f.options,
        config,
        authScope:
          wrong === 'auth-scope'
            ? f.options.authScope + '/another'
            : f.options.authScope,
      }),
    ).rejects.toThrow();
    expect(await f.journal.copies.count()).toBe(0);
    expect(
      f.sdk.calls.filter((c) => c.path.includes('/functions/')),
    ).toHaveLength(0);
  },
);
it.each(['accountHash', 'targetHash', 'authKey'] as const)(
  'rejects a native operator whose %s belongs to a different SDK account or destination',
  async (field) => {
    const f = await boundFixture(false),
      connection = {
        authKey: f.sdk.key,
        accountHash: f.session.identity.accountHash,
        targetHash: f.session.identity.targetHash,
        epoch: user(31),
        scopeVersion: user(32),
      };
    connection[field] =
      field === 'authKey'
        ? 'mise.cloud.auth.' + 'c'.repeat(64)
        : 'c'.repeat(64);
    await f.db.operatorState.put({ ...locked(f), phase: 'active', connection });
    await expect(
      createNativeOriginalCopySession(f.db, f.options),
    ).rejects.toThrow();
    expect(await f.journal.copies.count()).toBe(0);
    expect(
      f.sdk.calls.filter((c) => c.path.includes('/functions/')),
    ).toHaveLength(0);
  },
);
it('never pairs an altered cached account label with another actual SDK JWT', async () => {
  const f = await boundFixture(false);
  f.sdk.storage.setItem(
    f.sdk.key,
    JSON.stringify({
      ...f.sdk.saved,
      user: { ...f.sdk.saved.user, id: user(2) },
    }),
  );
  await expect(
    createNativeOriginalCopySession(f.db, f.options),
  ).rejects.toThrow();
  expect(await f.journal.copies.count()).toBe(0);
  expect(
    f.sdk.calls.filter((c) => c.path.includes('/functions/')),
  ).toHaveLength(0);
});
it('fresh SDK verification rejects an unconfirmed server phone before the first copy request and preserves the complete local plan', async () => {
  const f = await boundFixture();
  f.sdk.setConfirmed(false);
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  expect(
    f.sdk.calls.filter((c) => c.path.includes('/functions/')),
  ).toHaveLength(0);
  const row = await f.journal.copies.get(f.id);
  expect(row!.receipt).toBeNull();
  expect(row!.verified).toBe(false);
  await assertSourceUnchanged(f);
});
it.each([
  'begin',
  'missing',
  'put',
  'part',
  'seal',
  'verify',
  'finish',
  'inspect',
  'read',
  'read-part',
])(
  'rechecks the actual native operator after the %s HTTP boundary before confirming private data',
  async (op) => {
    const f = await boundFixture(
        true,
        ['part', 'seal', 'read-part'].includes(op),
      ),
      reading = ['inspect', 'read', 'read-part'].includes(op);
    if (reading) await f.session.deliver(f.id);
    let changed = false;
    f.sdk.afterCopy(async (actual) => {
      if (actual === op && !changed) {
        changed = true;
        await f.db.operatorState.put(locked(f));
      }
    });
    await expect(
      reading ? f.session.readback(f.id) : f.session.deliver(f.id),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    const row = await f.journal.copies.get(f.id);
    expect(row!.verified).toBe(false);
    if (!reading) expect(row!.receipt).toBeNull();
    expect(row!.identity).toEqual(f.session.identity);
    expect(row!.manifest).toEqual(f.manifest);
    await assertSourceUnchanged(f);
  },
);
it('a completed remote copy survives a late account removal while its local receipt stays unconfirmed and only a new original-account session recovers it', async () => {
  const f = await boundFixture();
  f.sdk.afterCopy(async (op) => {
    if (op === 'finish') f.sdk.storage.removeItem(f.sdk.key);
  });
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  expect(
    (
      await sql.query(
        'select receipt is not null complete from private.native_original_copies where id=$1',
        [f.id],
      )
    ).rows,
  ).toEqual([{ complete: true }]);
  f.sdk.afterCopy();
  f.sdk.storage.setItem(f.sdk.key, JSON.stringify(f.sdk.saved));
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  const fresh = new OriginalCopyJournal('fresh-owned-' + newInboxId());
  locals.push(fresh);
  const owner = await createOriginalCopyOwnerSession(
    { ...f.options, journal: fresh },
    f.scope,
  );
  boundSessions.push(owner);
  const recovered = await owner.recover(f.id);
  expect(recovered.bases[0]).toEqual(f.basis);
  expect((await fresh.copies.get(f.id))!.verified).toBe(true);
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await assertSourceUnchanged(f);
});
it('a destination changed after remote completion cannot confirm locally or revive the old controller when restored', async () => {
  const f = await boundFixture();
  f.sdk.afterCopy(async (op) => {
    if (op === 'finish')
      saveCloudConnection(f.sdk.storage, {
        ...boundConfig,
        apiUrl: 'https://another.test',
      });
  });
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  saveCloudConnection(f.sdk.storage, boundConfig);
  f.sdk.afterCopy();
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  const next = await createNativeOriginalCopySession(f.db, f.options);
  boundSessions.push(next);
  const receipt = await next.deliver(f.id);
  expect(receipt.verification).toBe('content-addressed-copy');
  expect(
    (
      await sql.query(
        'select count(*)::int n from private.native_original_copies',
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  await assertSourceUnchanged(f);
});
it('historical owner recovery uses the same actual SDK account after both native and server membership removal without installing shop rows', async () => {
  const f = await boundFixture();
  await f.session.deliver(f.id);
  await f.db.operatorState.put(locked(f));
  await sql.query('update public.members set active=false where id=$1', [
    f.scope.actorId,
  ]);
  const journal = new OriginalCopyJournal('former-member-' + newInboxId());
  locals.push(journal);
  const owner = await createOriginalCopyOwnerSession(
    { ...f.options, journal },
    f.scope,
  );
  boundSessions.push(owner);
  expect('deliver' in owner).toBe(false);
  expect('prepare' in owner).toBe(false);
  const recovered = await owner.recover(f.id);
  expect(recovered.current.tables.payments).toEqual(f.source.tables.payments);
  expect((await journal.copies.get(f.id))!.verified).toBe(true);
  await assertSourceUnchanged(f);
});
it('an interrupted copy controller stops an active HTTP result and leaves its native source and original manifest intact', async () => {
  const f = await boundFixture();
  f.sdk.afterCopy(async (op) => {
    if (op === 'begin') f.session.stop();
  });
  await expect(f.session.deliver(f.id)).rejects.toThrow();
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await assertSourceUnchanged(f);
});
it('a misbound account/JWT transport is denied before it can store another user copy', async () => {
  const f = await boundFixture(),
    second = await createCopySdk(
      boundConfig,
      '/unrelated',
      wire(2).edgeFetch,
      2,
    );
  sdkClients.push(second);
  const wrong = await createNativeOriginalCopySession(f.db, {
    ...f.options,
    send: wire(2, undefined, second.access).edgeFetch,
  });
  boundSessions.push(wrong);
  await expect(wrong.deliver(f.id)).rejects.toThrow();
  expect(
    (
      await sql.query(
        'select count(*)::int n from private.native_original_copies',
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await assertSourceUnchanged(f);
});
it('actual private-journal quota failure rolls native-scope preparation back completely without changing shop money', async () => {
  const f = await boundFixture(false),
    fail = () => {
      throw new DOMException('Full private copy journal', 'QuotaExceededError');
    };
  f.journal.copies.hook('creating', fail);
  try {
    await expect(f.session.prepare(f.id)).rejects.toThrow();
  } finally {
    f.journal.copies.hook('creating').unsubscribe(fail);
  }
  expect(await f.journal.copies.count()).toBe(0);
  expect(await f.journal.values.count()).toBe(0);
  await assertSourceUnchanged(f);
  expect((await f.session.prepare(f.id)).id).toBe(f.id);
});

it('a native preparation retry reopens the exact retained original after later current shop changes', async () => {
  const f = await boundFixture();
  await f.db.saveCustomer({
    name: 'Later current customer',
    nickname: '',
    phone: '',
    address: '',
    notes: 'Keep the original copy',
    tags: [],
  });
  const again = await f.session.prepare(f.id);
  expect(again).toEqual(f.manifest);
  expect(await f.journal.copies.count()).toBe(1);
  await f.session.deliver(f.id);
  const original = await f.session.readback(f.id);
  expect(original.current.tables.customers).toEqual(f.source.tables.customers);
  expect(
    (await f.db.customers.toArray()).some(
      (c) => c.name === 'Later current customer',
    ),
  ).toBe(true);
});
it('actual offline SDK continuity permits private preparation and reopening but cannot authorize copy HTTP', async () => {
  const f = await boundFixture(false);
  f.session.stop();
  await f.sdk.auth.dispose();
  f.sdk.setOnline(false);
  f.sdk.auth = await createPhoneAuth(boundConfig, f.options.authScope, {
    storage: f.sdk.storage,
    send: f.sdk.send,
  });
  await f.sdk.auth.check();
  expect(f.sdk.auth.getSnapshot().phase).toBe('offline');
  const session = await createNativeOriginalCopySession(f.db, {
    ...f.options,
    auth: f.sdk.auth,
  });
  boundSessions.push(session);
  const manifest = await session.prepare(f.id);
  expect(await session.prepare(f.id)).toEqual(manifest);
  await expect(session.deliver(f.id)).rejects.toThrow();
  expect(
    f.sdk.calls.filter((c) => c.path.includes('/functions/')),
  ).toHaveLength(0);
  expect((await f.journal.copies.get(f.id))!.receipt).toBeNull();
  await assertSourceUnchanged(f);
});
it('the native identity read lease blocks a second connection from changing operator during the actual private receipt commit', async () => {
  const f = await boundFixture(false),
    other = new MiseDatabase(f.db.name);
  locals.push(other);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.journal.use({
    stack: 'dbcore',
    name: 'verify-native-receipt-lease',
    create(down) {
      return {
        ...down,
        table(name) {
          const table = down.table(name);
          if (name !== 'copies') return table;
          return {
            ...table,
            mutate(request) {
              if (
                request.type === 'put' &&
                request.values.some((v) => v.receipt)
              ) {
                entered();
                return Dexie.Promise.resolve(Dexie.waitFor(gate)).then(() =>
                  table.mutate(request),
                );
              }
              return table.mutate(request);
            },
          };
        },
      };
    },
  });
  await f.session.prepare(f.id);
  const sending = f.session.deliver(f.id).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await reached;
  let switched = false;
  const changing = other.operatorState.put(locked(f)).then(() => {
    switched = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(switched).toBe(false);
  release();
  await sending;
  await changing;
  expect(switched).toBe(true);
  const row = await f.journal.copies.get(f.id);
  expect(row!.receipt!.verification).toBe('content-addressed-copy');
  expect(row!.identity).toEqual(f.session.identity);
  expect(row!.verified).toBe(false);
  await assertSourceUnchanged(f);
  other.close();
});

it('the actual SDK and native identity leases preserve the full 5,000-charge controller prepare, transfer and cold readback without truncation or financial replay', async () => {
  const started = performance.now(),
    f = await fixture(true),
    authScope = '/mise/app/' + f.scope.businessId;
  let network: typeof fetch = async () => {
    throw Error('Unconfigured scale fixture.');
  };
  const sdk = await createCopySdk(boundConfig, authScope, (url, init) =>
    network(url, init),
  );
  sdkClients.push(sdk);
  network = wire(1, undefined, sdk.access).edgeFetch;
  const journal = new OriginalCopyJournal('sdk-scale-' + newInboxId());
  locals.push(journal);
  const session = await createNativeOriginalCopySession(f.db, {
    config: boundConfig,
    authScope,
    auth: sdk.auth,
    storage: sdk.storage,
    journal,
    send: sdk.send,
  });
  boundSessions.push(session);
  const id = newInboxId(),
    manifest = await session.prepare(id);
  expect(await session.prepare(id)).toEqual(manifest);
  const before = (
      await sql.query('select count(*)::int n from public.credit_entries')
    ).rows,
    receipt = await session.deliver(id);
  journal.close();
  await journal.open();
  const recovered = await session.readback(id);
  expect(recovered.current.tables).toEqual(f.source.tables);
  expect(recovered.bases).toEqual([f.basis]);
  expect((await journal.copies.get(id))!.verified).toBe(true);
  expect(
    (await sql.query('select count(*)::int n from public.credit_entries')).rows,
  ).toEqual(before);
  expect(
    sdk.calls.filter((c) => c.path.endsWith('/user')).length,
  ).toBeGreaterThan(
    sdk.calls.filter((c) => c.path.includes('/functions/')).length,
  );
  for (const value of [
    boundConfig.apiUrl,
    boundConfig.publishableKey,
    sdk.access,
    sdk.saved.refresh_token,
  ])
    expect(JSON.stringify(await journal.copies.toArray())).not.toContain(value);
  await assertSourceUnchanged(f);
  console.log(
    JSON.stringify({
      stage: 'sdk-native-copy-scale',
      charges: 5000,
      noteCodeUnits: 1000000,
      nodeCount: receipt.nodeCount,
      nodeBytes: receipt.nodeBytes,
      originalCollections: 1,
      images: 1,
      freshSdkChecks: sdk.calls.filter((c) => c.path.endsWith('/user')).length,
      verified: true,
      durationMs: performance.now() - started,
    }),
  );
}, 600000);
