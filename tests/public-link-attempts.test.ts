import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newInboxId } from '../packages/core/inbox';
import {
  createPublicReadDatabase,
  type PublicReadDatabase,
} from './public-read-fixture';

type Kind = 'order' | 'khata';
interface Attempt {
  id: string;
  kind: Kind;
  resourceId: string;
  createEventId: string;
  state: 'missing' | 'issued' | 'revoked' | 'expired' | 'closed';
  link: null | { id: string; revokedAt: number | null };
  closure: null | { eventId: string; actorId: string; at: number };
}
let fixture: PublicReadDatabase,
  legacy: { id: string; token: string; createdAt: number; expiresAt: number },
  legacyEvent: string,
  legacyFingerprint: string;
const source = (kind: Kind) =>
  kind === 'order'
    ? fixture.source.tables.orders[0].id
    : fixture.source.tables.creditAccounts[0].id;
const attempt = (kind: Kind = 'order') => ({
  id: newInboxId(),
  event: newInboxId(),
  kind,
  resource: source(kind),
});
type Source = ReturnType<typeof attempt>;
const read = (v: Source, n = 1) =>
  fixture.asRole<Attempt>(
    n,
    'authenticated',
    'select public.read_public_link_attempt($1,$2,$3,$4) data',
    [v.id, v.event, v.kind, v.resource],
  );
const close = (v: Source, event = newInboxId(), n = 1) =>
  fixture.asRole<Attempt>(
    n,
    'authenticated',
    'select public.close_public_link_attempt($1,$2,$3,$4,$5) data',
    [v.id, v.event, event, v.kind, v.resource],
  );
const issue = (v: Source, n = 1) =>
  fixture.asRole<{ id: string; token: string }>(
    n,
    'authenticated',
    'select public.create_public_link($1,$2,$3,$4,null) data',
    [v.id, v.event, v.kind, v.resource],
  );
beforeAll(async () => {
  fixture = await createPublicReadDatabase();
  legacy = await fixture.issue(1, 'order', source('order'));
  legacyEvent = (
    await fixture.db.query<{ id: string }>(
      "select id from public.events where command='public_link.create' and after_data->>'id'=$1",
      [legacy.id],
    )
  ).rows[0].id;
  legacyFingerprint = await fixture.fingerprint();
  await fixture.db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261122184132_public_link_attempt_recovery.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
}, 30000);
afterAll(async () => {
  await fixture?.db.close();
});

it('backfills the original creation event while preserving legacy token, dates and audit contents', async () => {
  expect(await fixture.fingerprint()).toBe(legacyFingerprint);
  const v = {
    id: legacy.id,
    event: legacyEvent,
    kind: 'order' as const,
    resource: source('order'),
  };
  expect(await read(v)).toMatchObject({
    state: 'issued',
    createEventId: legacyEvent,
    closure: null,
    link: {
      id: legacy.id,
      createdAt: legacy.createdAt,
      expiresAt: legacy.expiresAt,
    },
  });
  expect(
    await fixture.read({
      kind: 'order',
      token: legacy.token,
      afterSequence: 0,
      pageSize: 50,
    }),
  ).toHaveProperty('data.order.id', v.resource);
});
it.each(['order', 'khata'] as const)(
  '%s missing response can be inspected without recovering its token or hash',
  async (kind) => {
    const v = attempt(kind);
    expect(await read(v)).toMatchObject({
      state: 'missing',
      link: null,
      closure: null,
    });
    const issued = await issue(v),
      view = await read(v, 2);
    expect(view).toMatchObject({
      id: v.id,
      kind,
      resourceId: v.resource,
      createEventId: v.event,
      state: 'issued',
      closure: null,
      link: { id: v.id, revokedAt: null },
    });
    expect(Object.keys(view).sort()).toEqual([
      'closure',
      'createEventId',
      'id',
      'kind',
      'link',
      'resourceId',
      'state',
    ]);
    expect(Object.keys(view.link!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'kind',
      'resourceId',
      'revokedAt',
    ]);
    expect(JSON.stringify(view)).not.toContain(issued.token);
    expect(JSON.stringify(view)).not.toContain('token_hash');
    await expect(issue(v)).rejects.toMatchObject({ code: '23505' });
  },
);
it.each(['order', 'khata'] as const)(
  '%s closure before issuance fences the delayed original request, without inventing an issuance',
  async (kind) => {
    const v = attempt(kind),
      event = newInboxId(),
      result = await close(v, event, 2);
    expect(result).toMatchObject({
      state: 'closed',
      link: null,
      closure: { eventId: event },
    });
    expect(
      (
        await fixture.db.query(
          "select id from public.events where command='public_link.create' and after_data->>'id'=$1",
          [v.id],
        )
      ).rows,
    ).toEqual([]);
    await expect(issue(v)).rejects.toMatchObject({ code: '55000' });
    // Neither a changed original event nor another authorized resource may reuse it.
    await expect(issue({ ...v, event: newInboxId() })).rejects.toMatchObject({
      code: '55000',
    });
    expect(await close(v, newInboxId())).toEqual(result);
    const replacement = attempt(kind);
    expect((await issue(replacement)).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  },
);
it.each(['order', 'khata'] as const)(
  '%s closure after issuance revokes only the original capability immediately',
  async (kind) => {
    const v = attempt(kind),
      original = await issue(v),
      other = await fixture.issue(1, kind, v.resource),
      event = newInboxId();
    const result = await close(v, event);
    expect(result).toMatchObject({
      state: 'closed',
      link: { id: v.id },
      closure: { eventId: event, actorId: fixture.source.tables.members[0].id },
    });
    expect(result.link!.revokedAt).toBeGreaterThan(0);
    expect(
      await fixture.read({
        kind,
        token: original.token,
        afterSequence: 0,
        pageSize: 50,
      }),
    ).toEqual({ v: 1, state: 'missing' });
    expect(
      await fixture.read({
        kind,
        token: other.token,
        afterSequence: 0,
        pageSize: 50,
      }),
    ).toHaveProperty('state', 'ok');
    const audit = (
      await fixture.db.query<{ actor_id: string; after_data: Attempt }>(
        'select actor_id,after_data from public.events where id=$1',
        [event],
      )
    ).rows[0];
    expect(audit.actor_id).toBe(result.closure!.actorId);
    expect(audit.after_data).toEqual(result);
    expect(JSON.stringify(audit)).not.toContain(original.token);
    const retried = await close(v, newInboxId(), 2);
    expect(retried.closure).toEqual(result.closure);
    expect(
      (
        await fixture.db.query<{ n: number }>(
          "select count(*)::integer n from public.events where command='public_link.close_attempt' and after_data->>'id'=$1",
          [v.id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
it('legacy revocation and expiry remain observable and never return a secret', async () => {
  const v = attempt();
  await issue(v);
  await fixture.asRole(
    2,
    'authenticated',
    'select public.revoke_public_link($1,$2) data',
    [v.id, newInboxId()],
  );
  expect(await read(v)).toMatchObject({ state: 'revoked', closure: null });
  const expired = attempt();
  await issue(expired);
  await fixture.db.query(
    'update private.public_links set created_at=created_at-172800000,expires_at=created_at-1 where id=$1',
    [expired.id],
  );
  expect(await read(expired)).toMatchObject({
    state: 'expired',
    closure: null,
  });
  expect(await close(expired)).toMatchObject({ state: 'closed' });
});
it.each(['event', 'resource', 'kind'] as const)(
  'issued/closed metadata cannot be rebound through changed %s',
  async (field) => {
    for (const issued of [false, true]) {
      const v = attempt();
      if (issued) await issue(v);
      else await close(v);
      const changed = {
        ...v,
        ...(field === 'event'
          ? { event: newInboxId() }
          : field === 'kind'
            ? { kind: 'khata' as const, resource: source('khata') }
            : { resource: fixture.branch.tables.orders[0].id }),
      };
      await expect(read(changed)).rejects.toMatchObject({ code: '42501' });
      await expect(close(changed)).rejects.toMatchObject({ code: '42501' });
    }
  },
);
it.each([3, 4])(
  'operator %s cannot inspect or close another scope, including missing attempts',
  async (n) => {
    for (const state of ['missing', 'issued', 'closed']) {
      const v = attempt();
      if (state === 'issued') await issue(v);
      if (state === 'closed') await close(v);
      await expect(read(v, n)).rejects.toMatchObject({ code: '42501' });
      await expect(close(v, newInboxId(), n)).rejects.toMatchObject({
        code: '42501',
      });
    }
  },
);
it.each(['staff', 'agent'] as const)(
  '%s cannot acquire owner link authority',
  async (role) => {
    const member = (
      await fixture.db.query<{ id: string }>(
        'select id from public.members where auth_user_id=$1',
        ['00000000-0000-4000-8000-000000000002'],
      )
    ).rows[0].id;
    try {
      await fixture.db.query('update public.members set role=$2 where id=$1', [
        member,
        role,
      ]);
      const v = attempt();
      await expect(read(v, 2)).rejects.toMatchObject({ code: '42501' });
      await expect(close(v, newInboxId(), 2)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await fixture.db.query(
        "update public.members set role='manager' where id=$1",
        [member],
      );
    }
  },
);
it.each([
  'phone_confirmed_at=null',
  "banned_until=now()+interval '1 hour'",
  'deleted_at=now()',
  'is_anonymous=true',
])(
  'live Auth check (%s) rejects a stale owner token on both recovery operations',
  async (change) => {
    try {
      await fixture.db.exec(
        `update auth.users set ${change} where id='00000000-0000-4000-8000-000000000002'`,
      );
      const v = attempt();
      await expect(read(v, 2)).rejects.toMatchObject({ code: '42501' });
      await expect(close(v, newInboxId(), 2)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await fixture.db.exec(
        "update auth.users set phone_confirmed_at=now(),banned_until=null,deleted_at=null,is_anonymous=false where id='00000000-0000-4000-8000-000000000002'",
      );
    }
  },
);
it('assignment removal and deactivation apply before metadata disclosure', async () => {
  const member = (
    await fixture.db.query<{ id: string }>(
      'select id from public.members where auth_user_id=$1',
      ['00000000-0000-4000-8000-000000000002'],
    )
  ).rows[0].id;
  try {
    await fixture.db.query(
      'delete from public.member_outlets where member_id=$1',
      [member],
    );
    const v = attempt();
    await expect(read(v, 2)).rejects.toMatchObject({ code: '42501' });
    await expect(close(v, newInboxId(), 2)).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await fixture.db.query(
      'insert into public.member_outlets values($1,$2,$3)',
      [
        fixture.source.tables.businesses[0].id,
        member,
        fixture.source.tables.outlets[0].id,
      ],
    );
  }
  try {
    await fixture.db.query(
      'update public.members set active=false where id=$1',
      [member],
    );
    const v = attempt();
    await expect(read(v, 2)).rejects.toMatchObject({ code: '42501' });
    await expect(close(v, newInboxId(), 2)).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await fixture.db.query(
      'update public.members set active=true where id=$1',
      [member],
    );
  }
});
it('audit collisions roll back both the fence and revocation, leaving no false successful closure', async () => {
  for (const issued of [false, true]) {
    const v = attempt();
    if (issued) await issue(v);
    await expect(
      close(v, fixture.source.tables.events[0].id),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await read(v)).toMatchObject({
      state: issued ? 'issued' : 'missing',
      closure: null,
    });
    if (issued) expect((await read(v)).link!.revokedAt).toBeNull();
    else expect((await issue(v)).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }
});
it.each(['anon', 'authenticated', 'service_role'] as const)(
  '%s has no direct closure table or helper access',
  async (actor) => {
    for (const query of [
      'select * from private.public_link_attempt_closures',
      'delete from private.public_link_attempt_closures',
      'insert into private.public_link_attempt_closures default values',
      'select * from private.public_link_scope($1,$2)',
    ])
      await expect(
        fixture.asRole(
          actor === 'authenticated' ? 1 : null,
          actor,
          query,
          query.includes('$1') ? ['order', source('order')] : [],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    if (actor !== 'authenticated') {
      const v = attempt();
      await expect(
        fixture.asRole(
          null,
          actor,
          'select public.read_public_link_attempt($1,$2,$3,$4) data',
          [v.id, v.event, v.kind, v.resource],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        fixture.asRole(
          null,
          actor,
          'select public.close_public_link_attempt($1,$2,$3,$4,$5) data',
          [v.id, v.event, newInboxId(), v.kind, v.resource],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  },
);
it('forces RLS and retains invoker-only public endpoints and closed default grants', async () => {
  expect(
    (
      await fixture.db.query(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid='private.public_link_attempt_closures'::regclass",
      )
    ).rows,
  ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  expect(
    (
      await fixture.db.query<{ n: number }>(
        "select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
it('bounds new unknown-attempt closures while allowing exact retries and existing-link revocation', async () => {
  const actor = fixture.source.tables.members[0].id;
  await fixture.db.query(
    'update private.public_link_attempt_closures set closed_at=0 where closed_by=$1',
    [actor],
  );
  let last: Source | undefined;
  for (let i = 0; i < 100; i++) {
    last = attempt();
    await close(last);
  }
  await expect(close(attempt())).rejects.toMatchObject({ code: '53400' });
  expect(await close(last!)).toMatchObject({ state: 'closed' });
  const issued = attempt();
  await issue(issued);
  expect(await close(issued)).toMatchObject({ state: 'closed' });
  await fixture.db.query(
    'update private.public_link_attempt_closures set closed_at=0 where closed_by=$1',
    [actor],
  );
  expect(await close(attempt())).toMatchObject({ state: 'closed' });
  // A time-window rollover never removes the durable delayed-request fence.
  await expect(issue(last!)).rejects.toMatchObject({ code: '55000' });
});
