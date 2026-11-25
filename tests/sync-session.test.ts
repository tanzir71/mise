import {localTableNames} from '../packages/core/local-schema';
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  CloudUploadJournal,
  uploadWithLocalOutbox,
} from '../apps/web/src/data/cloud-upload';
import { storedInboxItems } from '../apps/web/src/data/inbox';
import { selectCloudOperator } from '../apps/web/src/data/operator-state';
import {
  ensureSyncSession,
  claimSyncSession,
  sessionLease,
  renewSyncSession,
  syncSessionRead,
  requestSync,
  failSyncSession,
  releaseSyncSession,
  pauseSyncSession,
  freshSyncDownload,
  finishSyncSession,
} from '../apps/web/src/data/sync-session';
import { prepareSyncDownload } from '../apps/web/src/data/cloud-sync-journal';
import {
  parseSyncSession,
  syncRetryDelay,
  syncSessionLabel,
} from '../packages/core/sync-session';
import {
  cloudConnectionTarget,
  cloudAuthStorageKey,
} from '../packages/core/cloud-connection';
import { operatorAccountHash } from '../packages/core/operators';
import { backupTableNames } from '../packages/core/backup-tables';
import { backupToken } from '../packages/core/backup';
import { newInboxId } from '../packages/core/inbox';
import { cloudUploadFixture, MemoryCloudUpload } from './cloud-upload-fixture';
const config = {
    apiUrl: 'https://cloud.test',
    publishableKey: 'sb_publishable_test_only',
  },
  scope = '/test/app/session',
  user = '00000000-0000-4000-8000-000000000001';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function boot() {
  const source = cloudUploadFixture(),
    db = new MiseDatabase('sync-session-' + newInboxId()),
    journal = new CloudUploadJournal('sync-session-upload-' + newInboxId());
  cleanup.push(
    () => db.delete(),
    () => journal.delete(),
  );
  await db.transaction('rw', db.tables, async () => {
    for (const table of backupTableNames)
      await db
        .table(table)
        .bulkPut(
          table === 'inboxItems'
            ? storedInboxItems(source.tables.inboxItems)
            : source.tables[table],
        );
  });
  const target = {
      businessId: source.tables.businesses[0].id,
      outletId: source.tables.outlets[0].id,
      actorId: source.tables.members[0].id,
      accountHash: await operatorAccountHash(user),
      targetHash: await cloudConnectionTarget(config, scope, user),
      role: 'owner' as const,
    },
    authKey = await cloudAuthStorageKey(config, scope),
    plan = await journal.prepare(db, newInboxId());
  await uploadWithLocalOutbox(
    db,
    journal,
    plan.id,
    target.targetHash,
    new MemoryCloudUpload(),
  );
  const { targetHash: _, ...contextTarget } = target;
  void _;
  const context = {
      ...contextTarget,
      version: 1 as const,
      epoch: '00000000-0000-4000-8000-000000000010',
      scopeVersion: '00000000-0000-4000-8000-000000000011',
      businessName: null,
      outletName: null,
      actorName: null,
    },
    operator = await selectCloudOperator(
      db,
      context,
      { authKey, targetHash: target.targetHash },
      null,
      async () => context,
    ),
    input = {
      target,
      authKey,
      operatorRevision: operator.revision,
      epoch: context.epoch,
      scopeVersion: context.scopeVersion,
    },
    state = await ensureSyncSession(db, input, newInboxId());
  return { db, journal, source, target, input, state };
}
it('activation preserves the original local shop, upload receipt and portable backup tables', async () => {
  const f = await boot(),
    before = backupToken(await f.db.readBackup()),
    state = await ensureSyncSession(f.db, f.input, newInboxId());
  expect(state).toEqual(f.state);
  expect(await f.db.syncSessions.count()).toBe(1);
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(Object.keys((await f.db.readBackup()).tables)).toHaveLength(22);
  expect(f.db.tables).toHaveLength(localTableNames.length);
  expect(JSON.stringify(state)).not.toContain(config.apiUrl);
  expect(JSON.stringify(state)).not.toContain(config.publishableKey);
  expect(JSON.stringify(state)).not.toContain(user);
});
it('strict state parsing rejects authority fields, malformed leases and fabricated complete states', async () => {
  const { state } = await boot();
  for (const change of [
    { jwt: 'private' },
    { generation: 0 },
    { requested: 0, confirmed: 1 },
    { readId: newInboxId() },
    { lease: { id: newInboxId(), until: -1 } },
    { paused: 'yes' },
    { authKey: 'private' },
  ])
    expect(() => parseSyncSession({ ...state, ...change })).toThrow();
  expect(syncSessionLabel(state, true, 0)).toBe('Syncing');
  expect(
    syncSessionLabel(
      { ...state, requested: 1, confirmed: 1, lastConfirmedAt: 1 },
      true,
      0,
    ),
  ).toBe('Synced');
  expect(
    syncSessionLabel(
      {
        ...state,
        requested: 1,
        confirmed: 1,
        lastConfirmedAt: 1,
        lease: { id: newInboxId(), until: 1 },
      },
      true,
      0,
    ),
  ).toBe('Syncing');
  expect(syncSessionLabel(state, false, 5)).toBe('Offline');
});
it('only one current lease wins and an old leader cannot renew or complete a replacement lease', async () => {
  const { db } = await boot(),
    first = (await claimSyncSession(db, newInboxId(), 100))!;
  expect(await claimSyncSession(db, newInboxId(), 101)).toBeNull();
  const next = (await claimSyncSession(db, newInboxId(), 45101))!;
  await expect(
    renewSyncSession(db, sessionLease(first), 45102),
  ).rejects.toThrow();
  await expect(
    finishSyncSession(
      db,
      sessionLease(first),
      newInboxId(),
      first.requested,
      45103,
    ),
  ).rejects.toThrow();
  expect((await db.syncSessions.get('active'))?.lease).toEqual(next.lease);
});
it('an exclusive browser lock can take over a closed predecessor without waiting for its old clock lease', async () => {
  const { db } = await boot(),
    old = (await claimSyncSession(db, newInboxId(), 100))!,
    next = (await claimSyncSession(db, newInboxId(), 101, true))!;
  await releaseSyncSession(db, sessionLease(old));
  expect((await db.syncSessions.get('active'))?.lease).toEqual(next.lease);
});
it('wake-ups arriving during a lease survive renewal and cannot be mistaken for a completed pull', async () => {
  const { db } = await boot(),
    state = (await claimSyncSession(db, newInboxId(), 100))!;
  await requestSync(db);
  await renewSyncSession(db, sessionLease(state), 200);
  const current = (await db.syncSessions.get('active'))!;
  expect(current.requested).toBe(state.requested + 1);
  expect(current.confirmed).toBe(0);
  expect(current.lease?.until).toBe(45200);
  await expect(
    finishSyncSession(
      db,
      sessionLease(state),
      newInboxId(),
      state.requested,
      300,
    ),
  ).rejects.toThrow();
});
it('retry deadlines and the exact pending download survive reload', async () => {
  const { db } = await boot(),
    state = (await claimSyncSession(db, newInboxId(), 100))!,
    lease = sessionLease(state),
    read = await syncSessionRead(db, lease, 'a'.repeat(64), newInboxId());
  await failSyncSession(db, lease, 'retry', 1000, 0);
  db.close();
  await db.open();
  const current = (await db.syncSessions.get('active'))!;
  expect(current.readId).toBe(read.readId);
  expect(current.retryAt).toBe(1500);
  expect(current.failures).toBe(1);
  expect(await claimSyncSession(db, newInboxId(), 1499)).toBeNull();
  expect((await claimSyncSession(db, newInboxId(), 1500))?.readId).toBe(
    read.readId,
  );
});
it('unchanged receipts resume the same request while newer receipts preserve the prior saved download', async () => {
  const f = await boot(),
    state = (await claimSyncSession(f.db, newInboxId(), 100))!,
    lease = sessionLease(state),
    first = await syncSessionRead(f.db, lease, 'a'.repeat(64), newInboxId());
  await prepareSyncDownload(f.db, {
    id: first.readId!,
    target: f.target,
    previousCursor: null,
  });
  const original = await f.db.syncReads.get(first.readId!);
  expect(
    (await syncSessionRead(f.db, lease, 'a'.repeat(64), newInboxId())).readId,
  ).toBe(first.readId);
  expect(
    (await syncSessionRead(f.db, lease, 'b'.repeat(64), newInboxId())).readId,
  ).not.toBe(first.readId);
  expect(await f.db.syncReads.get(first.readId!)).toEqual(original);
});
it('pause blocks automatic claims and an explicit resume requests a fresh confirmation', async () => {
  const { db } = await boot();
  await pauseSyncSession(db);
  expect(await claimSyncSession(db, newInboxId(), 100)).toBeNull();
  expect(
    syncSessionLabel((await db.syncSessions.get('active'))!, true, 2),
  ).toBe('Paused');
  await requestSync(db, true);
  expect((await claimSyncSession(db, newInboxId(), 101))?.paused).toBe(false);
});
it('explicit download recovery archives the original session and retains its source pages', async () => {
  const f = await boot(),
    state = (await claimSyncSession(f.db, newInboxId(), 100))!,
    lease = sessionLease(state),
    read = await syncSessionRead(f.db, lease, 'a'.repeat(64), newInboxId());
  await prepareSyncDownload(f.db, {
    id: read.readId!,
    target: f.target,
    previousCursor: null,
  });
  await failSyncSession(f.db, lease, 'review', 200);
  await freshSyncDownload(f.db, newInboxId());
  expect(
    (await f.db.syncSessions.get('saved:' + state.sessionId))?.readId,
  ).toBe(read.readId);
  expect((await f.db.syncSessions.get('active'))?.readId).toBeNull();
  expect(await f.db.syncReads.get(read.readId!)).toBeDefined();
  expect(await f.db.cloudState.count()).toBe(1);
});
it('a changed operator cannot acquire the original session or be silently authorized by metadata', async () => {
  const f = await boot(),
    before = await f.db.syncSessions.get('active'),
    operator = (await f.db.operatorState.get('active'))!;
  await f.db.operatorState.put({
    ...operator,
    phase: 'locked',
    revision: operator.revision + 1,
  });
  await expect(claimSyncSession(f.db, newInboxId(), 100)).rejects.toMatchObject(
    { kind: 'auth' },
  );
  await expect(
    ensureSyncSession(f.db, f.input, newInboxId()),
  ).rejects.toMatchObject({ kind: 'auth' });
  expect(await f.db.syncSessions.get('active')).toEqual(before);
});
it('retry jitter stays bounded through long outages without zero-delay busy loops', () => {
  expect(syncRetryDelay(1, 0)).toBe(500);
  expect(syncRetryDelay(1, 1)).toBe(1500);
  expect(syncRetryDelay(30, 1)).toBe(60000);
  for (const random of [0, 0.5, 1])
    for (let n = 1; n <= 30; n++)
      expect(syncRetryDelay(n, random)).toBeGreaterThanOrEqual(500);
  for (const input of [0, -1, Number.NaN])
    expect(() => syncRetryDelay(input)).toThrow();
});
