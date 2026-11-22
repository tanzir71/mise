import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createPublicReadDatabase,
  type PublicReadDatabase,
} from './public-read-fixture';
import { newInboxId } from '../packages/core/inbox';
let f: PublicReadDatabase;
beforeAll(async () => {
  f = await createPublicReadDatabase();
  for (const file of [
    '20261122184132_public_link_attempt_recovery.sql',
    '20261122200729_owner_customer_link_controls.sql',
  ])
    await f.db.exec(
      readFileSync(
        new URL('../supabase/migrations/' + file, import.meta.url),
        'utf8',
      ),
    );
}, 30000);
beforeEach(async () => {
  await f.db.exec(
    "delete from private.public_link_attempt_closures;delete from private.public_links;delete from public.events where command like 'public_link.%';",
  );
});
afterAll(async () => {
  await f?.db.close();
});
const read = (
  n: number | null,
  kind: 'order' | 'khata',
  resource: string,
  role: 'anon' | 'authenticated' | 'service_role' = 'authenticated',
  limit = 50,
) =>
  f.asRole<{
    entries: Record<string, unknown>[];
    businessId: string;
    outletId: string;
    actorId: string;
    actorRole: string;
  }>(n, role, 'select public.read_customer_link_page($1,$2,null,$3) data', [
    kind,
    resource,
    limit,
  ]);
it.each(['order', 'khata'] as const)(
  '%s metadata includes only the selected resource across two outlets and two businesses',
  async (kind) => {
    const resources = [f.source, f.branch, f.foreign].map((b) =>
        kind === 'order'
          ? b.tables.orders[0].id
          : b.tables.creditAccounts[0].id,
      ),
      caps = [];
    for (const [i, resource] of resources.entries())
      caps.push(await f.issue(i === 2 ? 4 : 1, kind, resource));
    for (const [i, resource] of resources.entries()) {
      const page = await read(i === 2 ? 4 : 1, kind, resource);
      expect(page.entries.map((v) => v.id)).toEqual([caps[i].id]);
      expect(page.outletId).toBe(
        [f.source, f.branch, f.foreign][i].tables.outlets[0].id,
      );
      const raw = JSON.stringify(page);
      for (const cap of caps) expect(raw).not.toContain(cap.token);
      expect(Object.keys(page.entries[0]).sort()).toEqual([
        'createEventId',
        'createdAt',
        'expiresAt',
        'id',
        'kind',
        'resourceId',
        'revokedAt',
      ]);
    }
  },
);
it.each([2, 3, 4])(
  'operator %s cannot list a foreign outlet or business',
  async (n) => {
    const resource =
      n === 2 ? f.branch.tables.orders[0].id : f.source.tables.orders[0].id;
    await expect(read(n, 'order', resource)).rejects.toMatchObject({
      code: '42501',
    });
  },
);
it('assigned managers receive their real operator identity rather than the resource issuer', async () => {
  const cap = await f.issue(1, 'order', f.source.tables.orders[0].id),
    page = await read(2, 'order', f.source.tables.orders[0].id),
    member = (
      await f.db.query<{ id: string }>(
        'select id from public.members where auth_user_id=$1',
        ['00000000-0000-4000-8000-000000000002'],
      )
    ).rows[0];
  expect(page.entries[0].id).toBe(cap.id);
  expect(page.actorId).toBe(member.id);
  expect(page.actorRole).toBe('manager');
});
it.each(['anon', 'service_role'] as const)(
  '%s cannot execute either owner metadata endpoint',
  async (role) => {
    await expect(
      read(null, 'order', f.source.tables.orders[0].id, role),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.asRole(
        null,
        role,
        'select private.read_customer_link_page($1,$2,null,50) data',
        ['order', f.source.tables.orders[0].id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  },
);
it.each(['staff', 'agent'] as const)(
  '%s cannot turn an assigned phone account into link administration',
  async (role) => {
    try {
      await f.db.query(
        'update public.members set role=$2 where auth_user_id=$1',
        ['00000000-0000-4000-8000-000000000002', role],
      );
      await expect(
        read(2, 'order', f.source.tables.orders[0].id),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await f.db.query(
        "update public.members set role='manager' where auth_user_id=$1",
        ['00000000-0000-4000-8000-000000000002'],
      );
    }
  },
);
it.each([
  'phone_confirmed_at=null',
  'is_anonymous=true',
  "banned_until=now()+interval '1 hour'",
  'deleted_at=now()',
])(
  'current Auth state %s is enforced with a previously signed subject',
  async (change) => {
    try {
      await f.db.exec(
        'update auth.users set ' +
          change +
          " where id='00000000-0000-4000-8000-000000000002'",
      );
      await expect(
        read(2, 'order', f.source.tables.orders[0].id),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await f.db.exec(
        "update auth.users set phone_confirmed_at=now(),is_anonymous=false,banned_until=null,deleted_at=null where id='00000000-0000-4000-8000-000000000002'",
      );
    }
  },
);
it('legacy, revoked and expired grants remain manageable while financial and audit rows stay unchanged by listing', async () => {
  const resource = f.source.tables.orders[0].id,
    legacy = await f.issue(1, 'order', resource),
    revoked = await f.issue(1, 'order', resource),
    expired = await f.issue(1, 'order', resource);
  await f.db.query(
    'update private.public_links set created_event_id=null where id=$1',
    [legacy.id],
  );
  await f.asRole(
    1,
    'authenticated',
    'select public.revoke_public_link($1,$2) data',
    [revoked.id, newInboxId()],
  );
  await f.db.query(
    'update private.public_links set created_at=created_at-172800000,expires_at=created_at-1 where id=$1',
    [expired.id],
  );
  const before = await f.fingerprint(),
    page = await read(1, 'order', resource);
  expect(page.entries).toHaveLength(3);
  expect(page.entries.find((v) => v.id === legacy.id)).toHaveProperty(
    'createEventId',
    null,
  );
  expect(
    page.entries.find((v) => v.id === revoked.id)?.revokedAt,
  ).not.toBeNull();
  expect(await f.fingerprint()).toBe(before);
});
it.each([0, 101, null])(
  'page size %s is bounded before any resource data is returned',
  async (limit) => {
    await expect(
      f.asRole(
        1,
        'authenticated',
        'select public.read_customer_link_page($1,$2,null,$3) data',
        ['order', f.source.tables.orders[0].id, limit],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  },
);
