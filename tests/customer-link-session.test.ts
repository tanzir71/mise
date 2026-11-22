import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createPublicReadDatabase,
  type PublicReadDatabase,
} from './public-read-fixture';
import { newInboxId } from '../packages/core/inbox';
import { createCustomerLinkSession } from '../apps/web/src/data/customer-link-session';
import { assertLiveCommandReceipt } from '../apps/web/src/data/command-request';
import { testCommandAccount } from './command-account-fixture';
import {
  parseCustomerLinkJournal,
  type CustomerLinkSource,
  type CustomerLinkScope,
} from '../packages/core/customer-link-admin';
let fixture: PublicReadDatabase;
const config = {
  apiUrl: 'https://shop-backend.example',
  publishableKey: 'sb_publishable_test_only',
};
beforeAll(async () => {
  fixture = await createPublicReadDatabase();
  for (const file of [
    '20261122184132_public_link_attempt_recovery.sql',
    '20261122200729_owner_customer_link_controls.sql',
  ])
    await fixture.db.exec(
      readFileSync(
        new URL('../supabase/migrations/' + file, import.meta.url),
        'utf8',
      ),
    );
}, 30000);
afterAll(async () => {
  await fixture?.db.close();
});
beforeEach(async () => {
  await fixture.db.exec(
    "delete from private.public_link_attempt_closures;delete from private.public_links;delete from public.events where command like 'public_link.%';",
  );
});
function boot(kind: 'order' | 'khata' = 'order') {
  const scope: CustomerLinkScope = {
    businessId: fixture.source.tables.businesses[0].id,
    outletId: fixture.source.tables.outlets[0].id,
    actorId: fixture.source.tables.members[0].id,
    kind,
    resourceId:
      kind === 'order'
        ? fixture.source.tables.orders[0].id
        : fixture.source.tables.creditAccounts[0].id,
  };
  const rows = new Map<string, string>(),
    storage = {
      getItem: (k: string) => rows.get(k) ?? null,
      setItem: (k: string, v: string) => {
        rows.set(k, v);
      },
      removeItem: (k: string) => {
        rows.delete(k);
      },
    },
    assertScope = vi.fn(async () => {});
  let held = false,
    authorized = true;
  const locks = {
    request: async (
      _key: string,
      _options: unknown,
      fn: (v: unknown) => Promise<unknown>,
    ) => {
      if (held) return fn(null);
      held = true;
      try {
        return await fn({ name: 'fixture', mode: 'exclusive' });
      } finally {
        held = false;
      }
    },
  } as unknown as Pick<LockManager, 'request'>;
  const account = testCommandAccount(config, async () => {
    if (!authorized) throw Error();
    return 'owner.original.signature';
  });
  account.assertCurrent = () => {
    if (!authorized) throw Error();
  };
  const routes: Record<string, { sql: string; args: string[] }> = {
    read_customer_link_page: {
      sql: 'select public.read_customer_link_page($1,$2,$3,$4) data',
      args: ['p_kind', 'p_resource_id', 'p_after_id', 'p_page_size'],
    },
    create_public_link: {
      sql: 'select public.create_public_link($1,$2,$3,$4,$5) data',
      args: ['p_id', 'p_event_id', 'p_kind', 'p_resource_id', 'p_expires_at'],
    },
    read_public_link_attempt: {
      sql: 'select public.read_public_link_attempt($1,$2,$3,$4) data',
      args: ['p_id', 'p_create_event_id', 'p_kind', 'p_resource_id'],
    },
    close_public_link_attempt: {
      sql: 'select public.close_public_link_attempt($1,$2,$3,$4,$5) data',
      args: [
        'p_id',
        'p_create_event_id',
        'p_event_id',
        'p_kind',
        'p_resource_id',
      ],
    },
    revoke_public_link: {
      sql: 'select public.revoke_public_link($1,$2) data',
      args: ['p_id', 'p_event_id'],
    },
  };
  const native: typeof fetch = async (url, options) => {
    const name = new URL(String(url)).pathname.split('/').at(-1)!,
      route = routes[name];
    if (!route) throw Error('Unknown RPC');
    const body = JSON.parse(String(options?.body));
    const value = await fixture.asRole(
      1,
      'authenticated',
      route.sql,
      route.args.map((k) => body[k]),
    );
    return new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const send = vi.fn<typeof fetch>(native),
    make = () =>
      createCustomerLinkSession(config, account, scope, {
        storage,
        assertScope,
        locks,
        send,
      }),
    session = make();
  const source = (): CustomerLinkSource => ({
    id: newInboxId(),
    createEventId: newInboxId(),
    kind,
    resourceId: scope.resourceId,
    expiresAt: null,
  });
  return {
    scope,
    rows,
    storage,
    assertScope,
    locks,
    account,
    send,
    native,
    make,
    session,
    source,
    lose: () => {
      authorized = false;
    },
  };
}
const count = async (command: string) =>
  (
    await fixture.db.query<{ n: number }>(
      'select count(*)::int n from public.events where command=$1',
      [command],
    )
  ).rows[0].n;
it.each(['order', 'khata'] as const)(
  '%s issuance crosses the real SQL boundary only after the original source is durable, and keeps secrets in memory',
  async (kind) => {
    const f = boot(kind),
      source = f.source();
    let secret = '';
    f.send.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/create_public_link'))
        expect(f.session.saved().lifecycle).toEqual({
          type: 'create',
          source,
          link: null,
        });
      return f.native(url, options);
    });
    const metadata = await f.session.create(source);
    expect(metadata).not.toHaveProperty('token');
    const shared = await f.session.share();
    secret = shared.token;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    assertLiveCommandReceipt(shared);
    const raw = [...f.rows.values()].join();
    for (const privateValue of [
      secret,
      config.apiUrl,
      config.publishableKey,
      'owner.original.signature',
      'token_hash',
    ])
      expect(raw).not.toContain(privateValue);
    expect(await count('public_link.create')).toBe(1);
    const reloaded = f.make();
    await expect(reloaded.share()).rejects.toMatchObject({ kind: 'review' });
    expect(await reloaded.inspect()).toMatchObject({
      state: 'issued',
      createEventId: source.createEventId,
    });
    const closed = await reloaded.close(newInboxId());
    expect(closed.state).toBe('closed');
    expect(
      await fixture.read({
        kind,
        token: secret,
        afterSequence: 0,
        pageSize: 50,
      }),
    ).toEqual({ v: 1, state: 'missing' });
    f.send.mockImplementation(f.native);
    await reloaded.create(f.source());
    expect(await count('public_link.create')).toBe(2);
  },
);
it('an actually committed creation with a lost response cannot be silently replaced or reissued', async () => {
  const f = boot(),
    source = f.source();
  f.send.mockImplementation(async (url, options) => {
    const result = await f.native(url, options);
    if (String(url).endsWith('/create_public_link'))
      throw Error('Lost accepted response');
    return result;
  });
  await expect(f.session.create(source)).rejects.toMatchObject({
    kind: 'retry',
  });
  expect(f.session.saved().lifecycle).toEqual({
    type: 'create',
    source,
    link: null,
  });
  f.send.mockImplementation(f.native);
  const reloaded = f.make();
  expect(await reloaded.inspect()).toMatchObject({ state: 'issued' });
  await expect(reloaded.create(f.source())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await count('public_link.create')).toBe(1);
  await reloaded.close(newInboxId());
  await reloaded.create(f.source());
  expect(await count('public_link.create')).toBe(2);
});
it('a lost committed closure retains its original event and exact retry across reload', async () => {
  const f = boot(),
    source = f.source(),
    event = newInboxId();
  await f.session.create(source);
  f.send.mockImplementation(async (url, options) => {
    const response = await f.native(url, options);
    if (String(url).endsWith('/close_public_link_attempt'))
      throw Error('Lost closure response');
    return response;
  });
  await expect(f.session.close(event)).rejects.toMatchObject({ kind: 'retry' });
  expect(f.session.saved().lifecycle).toMatchObject({
    type: 'close',
    source,
    eventId: event,
    closure: null,
  });
  f.send.mockImplementation(f.native);
  const resumed = f.make();
  await expect(resumed.close(newInboxId())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await resumed.close(event)).toMatchObject({
    state: 'closed',
    closure: { eventId: event },
  });
  expect(await count('public_link.close_attempt')).toBe(1);
});
it('closing an absent saved creation attempt fences the actual late create before a deliberate replacement', async () => {
  const f = boot(),
    source = f.source();
  f.send.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/create_public_link'))
      throw Error('Request never arrived');
    return f.native(url, options);
  });
  await expect(f.session.create(source)).rejects.toMatchObject({
    kind: 'retry',
  });
  f.send.mockImplementation(f.native);
  expect(await f.session.inspect()).toMatchObject({ state: 'missing' });
  await f.session.close(newInboxId());
  await expect(
    fixture.asRole(
      1,
      'authenticated',
      'select public.create_public_link($1,$2,$3,$4,null) data',
      [source.id, source.createEventId, source.kind, source.resourceId],
    ),
  ).rejects.toMatchObject({ code: '55000' });
  await f.session.create(f.source());
  expect(await count('public_link.create')).toBe(1);
});
it('the first actual closure by another authorized member is observed without inventing acceptance of the later event', async () => {
  const f = boot(),
    source = f.source(),
    first = newInboxId(),
    later = newInboxId();
  await f.session.create(source);
  const actual = await fixture.asRole(
    2,
    'authenticated',
    'select public.close_public_link_attempt($1,$2,$3,$4,$5) data',
    [source.id, source.createEventId, first, source.kind, source.resourceId],
  );
  expect(await f.session.close(later)).toEqual(actual);
  expect(f.session.saved().lifecycle).toMatchObject({
    type: 'close',
    eventId: later,
    closure: { eventId: first },
  });
  expect(await count('public_link.close_attempt')).toBe(1);
});
it('current revocation invalidates a memory token before it can be shared again', async () => {
  const f = boot(),
    source = f.source();
  await f.session.create(source);
  const shared = await f.session.share();
  await fixture.asRole(
    2,
    'authenticated',
    'select public.revoke_public_link($1,$2) data',
    [source.id, newInboxId()],
  );
  await expect(f.session.share()).rejects.toMatchObject({ kind: 'review' });
  expect(() => assertLiveCommandReceipt(shared)).toThrow();
  expect(await f.session.inspect()).toMatchObject({ state: 'revoked' });
});
it('an unwritable journal allows authority inspection but prevents the mutating RPC', async () => {
  const f = boot();
  vi.spyOn(f.storage, 'setItem').mockImplementation(() => {
    throw Error('Quota');
  });
  await expect(f.session.create(f.source())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(
    f.send.mock.calls.some(([url]) =>
      String(url).endsWith('/create_public_link'),
    ),
  ).toBe(false);
  expect(await count('public_link.create')).toBe(0);
});
it('a post-commit journal failure drops the token and retains the original source for explicit recovery', async () => {
  const f = boot(),
    source = f.source();
  const write = f.storage.setItem;
  let writes = 0;
  vi.spyOn(f.storage, 'setItem').mockImplementation((key, value) => {
    if (++writes === 2) throw Error('Quota after acceptance');
    write(key, value);
  });
  await expect(f.session.create(source)).rejects.toMatchObject({
    kind: 'review',
  });
  expect(f.session.saved().lifecycle).toEqual({
    type: 'create',
    source,
    link: null,
  });
  await expect(f.session.share()).rejects.toMatchObject({ kind: 'review' });
  expect(await count('public_link.create')).toBe(1);
  vi.restoreAllMocks();
  expect(await f.session.inspect()).toMatchObject({ state: 'issued' });
  await f.session.close(newInboxId());
});
it('an Auth change after actual SQL acceptance retains the source and never publishes the returned token', async () => {
  const f = boot(),
    source = f.source();
  f.send.mockImplementation(async (url, options) => {
    const result = await f.native(url, options);
    if (String(url).endsWith('/create_public_link')) f.lose();
    return result;
  });
  await expect(f.session.create(source)).rejects.toMatchObject({
    kind: 'auth',
  });
  expect(f.session.saved().lifecycle).toEqual({
    type: 'create',
    source,
    link: null,
  });
  expect(await count('public_link.create')).toBe(1);
});
it('Web Locks prevent concurrent tabs from granting two links or overwriting the original journal', async () => {
  const f = boot(),
    a = f.source(),
    b = f.source(),
    other = f.make();
  let release!: () => void;
  const wait = new Promise<void>((done) => (release = done));
  let entered!: () => void;
  const entry = new Promise<void>((done) => (entered = done));
  f.send.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/create_public_link')) {
      entered();
      await wait;
    }
    return f.native(url, options);
  });
  const first = f.session.create(a);
  await entry;
  await expect(other.create(b)).rejects.toMatchObject({ kind: 'retry' });
  expect(f.session.saved().lifecycle).toMatchObject({ source: a });
  release();
  await first;
  expect(await count('public_link.create')).toBe(1);
});
it('caller mutation during asynchronous authorization cannot rebind the submitted original IDs or expiry', async () => {
  const f = boot(),
    source = f.source(),
    original = structuredClone(source);
  f.assertScope.mockImplementationOnce(async () => {
    source.id = newInboxId();
    source.createEventId = newInboxId();
    source.expiresAt = 0;
  });
  await f.session.create(source);
  expect(f.session.saved().lifecycle).toMatchObject({ source: original });
});
it.each([{ token: 'private' }, { connection: config }, { jwt: 'signature' }])(
  'a journal with credential fields %j is retained for review and never submitted',
  async (extra) => {
    const f = boot();
    f.rows.set(
      f.session.key,
      JSON.stringify({ v: 1, lifecycle: null, revoke: null, ...extra }),
    );
    await expect(f.session.create(f.source())).rejects.toMatchObject({
      kind: 'review',
    });
    expect(f.send).not.toHaveBeenCalled();
  },
);
it('a legacy link on another device can be revoked, and a lost reply retries the exact pending event', async () => {
  const f = boot(),
    legacy = await fixture.issue(2, 'order', f.scope.resourceId),
    page = await f.session.page(),
    link = page.entries.find((x) => x.id === legacy.id)!;
  const { createEventId, ...metadata } = link,
    event = newInboxId();
  expect(createEventId).not.toBeNull();
  f.send.mockImplementation(async (url, options) => {
    const response = await f.native(url, options);
    if (String(url).endsWith('/revoke_public_link'))
      throw Error('Lost revoke reply');
    return response;
  });
  await expect(f.session.revoke(metadata, event)).rejects.toMatchObject({
    kind: 'retry',
  });
  expect(f.session.saved().revoke).toEqual({ link: metadata, eventId: event });
  f.send.mockImplementation(f.native);
  expect(await f.make().revoke(metadata, event)).toMatchObject({
    id: legacy.id,
  });
  expect(f.session.saved().revoke).toBeNull();
  expect(await count('public_link.revoke')).toBe(1);
});
it('recovery metadata pagination includes issued, expired and revoked links without exposing secret material', async () => {
  const f = boot();
  for (let i = 0; i < 7; i++)
    await fixture.issue(i % 2 ? 2 : 1, 'order', f.scope.resourceId);
  const all = [];
  let after: string | null = null;
  do {
    const page = await f.session.page(after, 2);
    expect(page.actorRole).toBe('owner');
    all.push(...page.entries);
    after = page.next;
  } while (after);
  expect(all).toHaveLength(7);
  expect(new Set(all.map((x) => x.id)).size).toBe(7);
  expect(all.map((x) => x.id)).toEqual([...all.map((x) => x.id)].sort());
  for (const row of all) {
    expect(row).not.toHaveProperty('token');
    expect(row).not.toHaveProperty('token_hash');
    expect(row.createEventId).toBeTruthy();
  }
});
it('a changed actual server operator is refused before creating a link or writing a journal', async () => {
  const f = boot();
  f.send.mockImplementation(async (url, options) => {
    const result = await f.native(url, options);
    if (String(url).endsWith('/read_customer_link_page')) {
      const value = await result.json();
      return Response.json({ ...value, actorId: newInboxId() });
    }
    return result;
  });
  await expect(f.session.create(f.source())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(f.rows.size).toBe(0);
  expect(await count('public_link.create')).toBe(0);
});
it('malformed cursors and limits fail before HTTP, and raw secrets never pass the journal schema', async () => {
  const f = boot();
  await expect(f.session.page('bad', 1)).rejects.toThrow();
  await expect(f.session.page(null, 101)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
  const source = f.source();
  expect(() =>
    parseCustomerLinkJournal(
      {
        v: 1,
        lifecycle: {
          type: 'create',
          source,
          link: null,
          token: 'x'.repeat(43),
        },
        revoke: null,
      },
      f.scope,
    ),
  ).toThrow();
});
