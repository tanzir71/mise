import Dexie, { type Transaction } from 'dexie';
import {
  parseLocalCloudState,
  type LocalCloudState,
} from '@mise/core/local-outbox';
import { parseLocalOperatorState } from '@mise/core/operators';
import {
  parseSyncSession,
  syncRetryDelay,
  SyncSessionError,
  type SyncSession,
  type SyncProblem,
} from '@mise/core/sync-session';
import { materializationHash } from '@mise/core/sync-materialize';
import {
  syncDownloadToken,
  type SyncDownloadTarget,
} from '@mise/core/sync-download';
import type { LocalStore } from './local-store';

export interface SessionSelection {
  target: SyncDownloadTarget;
  authKey: string;
  operatorRevision: number;
  epoch: string;
  scopeVersion: string;
}
export interface SessionLease {
  sessionId: string;
  generation: number;
  id: string;
}
const leaseMs = 45000;
const stable = (binding: LocalCloudState) => ({ ...binding, sequence: 0 });
const leaseToken = (s: SyncSession): SessionLease => ({
  sessionId: s.sessionId,
  generation: s.generation,
  id: s.lease!.id,
});
function native(db: LocalStore, tx: Transaction | undefined) {
  if (
    !tx ||
    Dexie.currentTransaction !== tx ||
    !tx.active ||
    tx.db !== db ||
    tx.mode !== 'readwrite'
  )
    throw new SyncSessionError();
}
async function identity(db: LocalStore, expected: SessionSelection) {
  const binding = parseLocalCloudState(await db.cloudState.get('binding')),
    operator = parseLocalOperatorState(await db.operatorState.get('active')),
    c = operator.connection,
    t = expected.target;
  if (
    binding.phase !== 'ready' ||
    binding.targetHash !== t.targetHash ||
    binding.businessId !== t.businessId ||
    binding.outletId !== t.outletId ||
    binding.ownerId !== t.actorId ||
    (binding.version === 1 && (!binding.receipt || t.role !== 'owner')) ||
    (binding.version === 2 &&
      (!binding.join ||
        binding.join.accountHash !== t.accountHash ||
        binding.join.role !== t.role ||
        binding.join.epoch !== expected.epoch ||
        binding.join.scopeVersion !== expected.scopeVersion)) ||
    operator.phase !== 'active' ||
    operator.revision !== expected.operatorRevision ||
    operator.businessId !== t.businessId ||
    operator.outletId !== t.outletId ||
    operator.actorId !== t.actorId ||
    operator.role !== t.role ||
    !c ||
    c.targetHash !== t.targetHash ||
    c.authKey !== expected.authKey ||
    c.accountHash !== t.accountHash ||
    c.epoch !== expected.epoch ||
    c.scopeVersion !== expected.scopeVersion
  )
    throw new SyncSessionError('auth');
  return materializationHash(stable(binding));
}
async function current(db: LocalStore, lease: SessionLease) {
  const state = parseSyncSession(await db.syncSessions.get('active'));
  if (
    state.sessionId !== lease.sessionId ||
    state.generation !== lease.generation ||
    state.lease?.id !== lease.id
  )
    throw new SyncSessionError();
  if ((await Dexie.waitFor(identity(db, state))) !== state.bindingHash)
    throw new SyncSessionError();
  return state;
}
/** Activation follows a fresh explicit cloud selection; it never activates an operator. */
export async function ensureSyncSession(
  db: LocalStore,
  input: SessionSelection,
  sessionId: string,
): Promise<SyncSession> {
  input = structuredClone(input);
  return db.transaction(
    'rw',
    db.syncSessions,
    db.cloudState,
    db.operatorState,
    async () => {
      const tx = Dexie.currentTransaction,
        bindingHash = await Dexie.waitFor(identity(db, input)),
        raw = await db.syncSessions.get('active'),
        old = raw ? parseSyncSession(raw) : null;
      const same =
        old &&
        syncDownloadToken(old.target) === syncDownloadToken(input.target) &&
        old.authKey === input.authKey &&
        old.epoch === input.epoch &&
        old.scopeVersion === input.scopeVersion &&
        old.bindingHash === bindingHash;
      if (same && old.operatorRevision === input.operatorRevision) return old;
      if (old?.generation === Number.MAX_SAFE_INTEGER)
        throw new SyncSessionError();
      const next = parseSyncSession({
        id: 'active',
        version: 1,
        paused: same ? old.paused : false,
        sessionId,
        generation: (old?.generation ?? 0) + 1,
        ...input,
        bindingHash,
        readId: same ? old.readId : null,
        readQueueHash: same ? old.readQueueHash : null,
        lease: null,
        failures: 0,
        retryAt: 0,
        problem: null,
        lastConfirmedAt: same ? old.lastConfirmedAt : null,
        requested: 1,
        confirmed: 0,
      });
      native(db, tx);
      if (old)
        await db.syncSessions.put({
          ...old,
          id: 'saved:' + old.sessionId,
          lease: null,
        });
      await db.syncSessions.put(next);
      return next;
    },
  );
}
export async function requestSync(
  db: LocalStore,
  manual = false,
  reconnect = false,
): Promise<void> {
  await db.transaction('rw', db.syncSessions, async () => {
    const raw = await db.syncSessions.get('active');
    if (!raw) return;
    const state = parseSyncSession(raw);
    if (state.requested === Number.MAX_SAFE_INTEGER)
      throw new SyncSessionError();
    await db.syncSessions.put({
      ...state,
      requested: state.requested + 1,
      retryAt:
        manual || reconnect || state.problem !== 'retry' ? 0 : state.retryAt,
      ...(manual ? { problem: null, failures: 0, paused: false } : {}),
    });
  });
}
export async function claimSyncSession(
  db: LocalStore,
  id: string,
  now: number,
  takeOver = false,
): Promise<SyncSession | null> {
  return db.transaction(
    'rw',
    db.syncSessions,
    db.cloudState,
    db.operatorState,
    async () => {
      const tx = Dexie.currentTransaction,
        raw = await db.syncSessions.get('active');
      if (!raw) return null;
      const state = parseSyncSession(raw);
      if (
        state.paused ||
        state.problem === 'auth' ||
        state.problem === 'review' ||
        state.retryAt > now ||
        (state.lease && state.lease.until > now && !takeOver)
      )
        return null;
      if ((await Dexie.waitFor(identity(db, state))) !== state.bindingHash)
        throw new SyncSessionError();
      const next = parseSyncSession({
        ...state,
        lease: { id, until: now + leaseMs },
      });
      native(db, tx);
      await db.syncSessions.put(next);
      return next;
    },
  );
}
export const sessionLease = leaseToken;
export async function renewSyncSession(
  db: LocalStore,
  lease: SessionLease,
  now: number,
): Promise<void> {
  await db.transaction(
    'rw',
    db.syncSessions,
    db.cloudState,
    db.operatorState,
    async () => {
      const tx = Dexie.currentTransaction,
        state = await current(db, lease),
        next = parseSyncSession({
          ...state,
          lease: { id: lease.id, until: now + leaseMs },
        });
      native(db, tx);
      await db.syncSessions.put(next);
    },
  );
}
/** A newer acknowledged queue needs a newer window; old requests/pages are never deleted. */
export async function syncSessionRead(
  db: LocalStore,
  lease: SessionLease,
  queueHash: string,
  newReadId: string,
): Promise<SyncSession> {
  return db.transaction(
    'rw',
    db.syncSessions,
    db.cloudState,
    db.operatorState,
    async () => {
      const tx = Dexie.currentTransaction,
        state = await current(db, lease);
      if (state.readId && state.readQueueHash === queueHash) return state;
      const next = parseSyncSession({
        ...state,
        readId: newReadId,
        readQueueHash: queueHash,
      });
      native(db, tx);
      await db.syncSessions.put(next);
      return next;
    },
  );
}
export async function failSyncSession(
  db: LocalStore,
  lease: SessionLease,
  problem: SyncProblem,
  now: number,
  random = Math.random(),
): Promise<void> {
  await db.transaction('rw', db.syncSessions, async () => {
    const raw = await db.syncSessions.get('active');
    if (!raw) return;
    const state = parseSyncSession(raw);
    if (
      state.sessionId !== lease.sessionId ||
      state.generation !== lease.generation ||
      state.lease?.id !== lease.id
    )
      return;
    const failures = Math.min(30, state.failures + 1),
      next = parseSyncSession({
        ...state,
        lease: null,
        problem,
        failures,
        retryAt:
          problem === 'retry'
            ? Math.min(8640000000000000, now + syncRetryDelay(failures, random))
            : 0,
      });
    await db.syncSessions.put(next);
  });
}
export async function releaseSyncSession(
  db: LocalStore,
  lease: SessionLease,
): Promise<void> {
  await db.transaction('rw', db.syncSessions, async () => {
    const raw = await db.syncSessions.get('active');
    if (!raw) return;
    const state = parseSyncSession(raw);
    if (
      state.sessionId === lease.sessionId &&
      state.generation === lease.generation &&
      state.lease?.id === lease.id
    )
      await db.syncSessions.put({ ...state, lease: null });
  });
}
export async function pauseSyncSession(db: LocalStore): Promise<void> {
  await db.transaction('rw', db.syncSessions, async () => {
    const raw = await db.syncSessions.get('active');
    if (raw) {
      const state = parseSyncSession(raw);
      await db.syncSessions.put({ ...state, paused: true });
    }
  });
}
/** A confirmed cursor and the current queue, never a network flag, determine completion. */
export async function finishSyncSession(
  db: LocalStore,
  lease: SessionLease,
  readId: string,
  requested: number,
  now: number,
  assertActive?: () => void,
): Promise<void> {
  await db.transaction(
    'rw',
    db.syncSessions,
    db.cloudState,
    db.operatorState,
    db.syncCanonical,
    db.outbox,
    async () => {
      const tx = Dexie.currentTransaction,
        state = await current(db, lease),
        base = await db.syncCanonical.get('active');
      if (
        state.readId !== readId ||
        base?.snapshot.readId !== readId ||
        requested > state.requested
      )
        throw new SyncSessionError();
      const unsent = await db.outbox
          .filter((r) => r.status !== 'accepted')
          .count(),
        next = parseSyncSession({
          ...state,
          lease: null,
          readId: null,
          readQueueHash: null,
          problem: null,
          failures: 0,
          retryAt: 0,
          lastConfirmedAt: now,
          confirmed: requested,
          requested: unsent
            ? Math.max(state.requested, requested + 1)
            : state.requested,
        });
      native(db, tx);
      assertActive?.();
      await db.syncSessions.put(next);
      assertActive?.();
    },
  );
}
/** Explicit recovery retains all prior session/download/image/source records. */
export async function freshSyncDownload(
  db: LocalStore,
  sessionId: string,
): Promise<void> {
  await db.transaction('rw', db.syncSessions, async () => {
    const raw = await db.syncSessions.get('active');
    if (!raw) throw new SyncSessionError();
    const state = parseSyncSession(raw);
    if (state.lease || state.generation === Number.MAX_SAFE_INTEGER)
      throw new SyncSessionError();
    const next = parseSyncSession({
      ...state,
      sessionId,
      generation: state.generation + 1,
      readId: null,
      readQueueHash: null,
      problem: null,
      failures: 0,
      retryAt: 0,
      requested: state.requested + 1,
    });
    await db.syncSessions.put({ ...state, id: 'saved:' + state.sessionId });
    await db.syncSessions.put(next);
  });
}
