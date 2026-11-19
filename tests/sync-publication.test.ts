import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ownerUploadDatabase,
  promoteOwnerUpload,
  ownerUploadRole,
} from './owner-upload-sql-fixture';
let db: Awaited<ReturnType<typeof ownerUploadDatabase>>;
const migration = readFileSync(
  'supabase/migrations/20261119101245_sync_event_insert_hints.sql',
  'utf8',
);
beforeAll(async () => {
  db = await ownerUploadDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});
it('publishes only event inserts and changes no RLS or anonymous grants', async () => {
  expect(
    (
      await db.query(
        "select puballtables,pubinsert,pubupdate,pubdelete,pubtruncate from pg_publication where pubname='supabase_realtime'",
      )
    ).rows,
  ).toEqual([
    {
      puballtables: false,
      pubinsert: true,
      pubupdate: false,
      pubdelete: false,
      pubtruncate: false,
    },
  ]);
  expect(
    (
      await db.query(
        "select schemaname,tablename from pg_publication_tables where pubname='supabase_realtime'",
      )
    ).rows,
  ).toEqual([{ schemaname: 'public', tablename: 'events' }]);
  expect(
    (
      await db.query(
        "select relrowsecurity,relforcerowsecurity,has_table_privilege('anon',oid,'select') as anonymous_read from pg_class where oid='public.events'::regclass",
      )
    ).rows,
  ).toEqual([
    { relrowsecurity: true, relforcerowsecurity: true, anonymous_read: false },
  ]);
  await db.exec(migration);
});
it('retains existing publication choices instead of silently replacing unrelated tables', async () => {
  await db.exec(
    'alter publication supabase_realtime add table public.customers',
  );
  try {
    await expect(db.exec(migration)).rejects.toThrow(
      'Review existing Realtime tables',
    );
    expect(
      (
        await db.query(
          "select count(*)::int n from pg_publication_tables where pubname='supabase_realtime'",
        )
      ).rows[0],
    ).toEqual({ n: 2 });
  } finally {
    await db.exec(
      'alter publication supabase_realtime drop table public.customers',
    );
  }
});
it('the published event table still denies unrelated phone accounts', async () => {
  const original = await promoteOwnerUpload(db);
  const owner = await ownerUploadRole(
    db,
    1,
    'authenticated',
    'select count(*)::int data from public.events where business_id=$1',
    [original.original.tables.businesses[0].id],
  );
  const other = await ownerUploadRole(
    db,
    2,
    'authenticated',
    'select count(*)::int data from public.events where business_id=$1',
    [original.original.tables.businesses[0].id],
  );
  expect(owner).toBeGreaterThan(0);
  expect(other).toBe(0);
});
