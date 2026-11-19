import Dexie, { type Transaction } from 'dexie';
import { backupTableNames } from '@mise/core/backup-tables';
import {
  cloudAuthStorageKey,
  cloudConnectionTarget,
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { newInboxId } from '@mise/core/inbox';
import {
  JoinSessionError,
  parseJoinSession,
  type JoinProblem,
  type JoinSession,
} from '@mise/core/join-session';
import {
  parseLocalOperatorState,
  parseOperatorContext,
  type LocalOperatorState,
  type OperatorContext,
  type OperatorPosition,
} from '@mise/core/operators';
import { syncDownloadToken } from '@mise/core/sync-download';
import { parseSyncScope } from '@mise/core/sync-read';
import type { MiseDatabase } from './db';
import type { PhoneAuth } from './phone-auth';
import { discoveryAuthScope } from './cloud-auth-scope';
import { cycleAccount } from './sync-cycle';
import { createOperatorRemote } from './operator-remote';
import { createCloudSyncRemote } from './cloud-sync-remote';
import { createCloudImageRemote } from './cloud-image-remote';
import { prepareSyncDownload, runSyncDownload } from './cloud-sync-journal';
import { downloadSyncImages } from './cloud-sync-images';
import { joinCanonicalDevice } from './cloud-sync-join';
import { selectCloudOperator } from './operator-state';
import { ensureSyncSession, requestSync } from './sync-session';

export interface JoinOptions {
  config: CloudConnection;
  base: string;
  auth: Pick<
    PhoneAuth,
    'key' | 'commandAuthorization' | 'assertCommandAuthorization'
  >;
  connectionCurrent?: () => boolean;
  send?: typeof fetch;
}
function native(
  db: MiseDatabase,
  tx: Transaction | undefined,
  check: () => void,
) {
  check();
  if (
    !tx ||
    Dexie.currentTransaction !== tx ||
    !tx.active ||
    tx.db !== db ||
    tx.mode !== 'readwrite'
  )
    throw new JoinSessionError();
}
function context(session: JoinSession): OperatorContext {
  return parseOperatorContext({
    version: 1,
    ...parseSyncScope({
      ...session.target,
      epoch: session.epoch,
      scopeVersion: session.scopeVersion,
    }),
    businessName: null,
    outletName: null,
    actorName: null,
  });
}
function sameScope(a: OperatorContext, b: OperatorContext) {
  if (
    syncDownloadToken(parseSyncScope(a)) !==
    syncDownloadToken(parseSyncScope(b))
  )
    throw new JoinSessionError('review');
}
/** No persisted credential, UUID or client-supplied role can establish access. */
async function original(
  options: JoinOptions,
  selected?: OperatorContext,
  signal?: AbortSignal,
) {
  const config = parseCloudConnection(options.config),
    authorization = await options.auth.commandAuthorization();
  const check = () => {
    signal?.throwIfAborted();
    if (options.connectionCurrent?.() === false)
      throw new JoinSessionError('auth');
    options.auth.assertCommandAuthorization(authorization);
  };
  check();
  if (
    options.auth.key !==
    (await cloudAuthStorageKey(config, discoveryAuthScope(options.base)))
  )
    throw new JoinSessionError('auth');
  const getAuth = async () => {
    check();
    const value = await options.auth.commandAuthorization();
    if (
      value.userId !== authorization.userId ||
      value.generation !== authorization.generation
    )
      throw new JoinSessionError('auth');
    check();
    options.auth.assertCommandAuthorization(value);
    return value;
  };
  const targetHash = selected
    ? await cloudConnectionTarget(
        config,
        options.base + selected.businessId,
        authorization.userId,
      )
    : null;
  const account = selected
    ? cycleAccount(
        { ...options, config, scope: options.base + selected.businessId },
        {
          target: { ...parseSyncScope(selected), targetHash: targetHash! },
          authKey: options.auth.key,
        },
      )
    : null;
  check();
  return {
    config,
    authorization,
    check,
    getAuth,
    targetHash,
    account,
    metadata: createOperatorRemote(config, getAuth, options.send),
  };
}
export async function discoverJoinOutlets(
  options: JoinOptions,
  after: OperatorPosition | null = null,
  signal?: AbortSignal,
) {
  const access = await original(options, undefined, signal),
    page = await access.metadata.list(after, 50, signal);
  access.check();
  return page;
}
async function empty(db: MiseDatabase) {
  for (const name of backupTableNames) {
    if (name === 'inboxItems') {
      if ((await db.inboxItems.toArray()).some((row) => row.outletId !== null))
        throw new JoinSessionError();
    } else if (await db.table(name).count()) throw new JoinSessionError();
  }
  for (const table of [
    db.cloudState,
    db.outbox,
    db.syncCanonical,
    db.syncApplications,
    db.syncAdmissions,
    db.syncSessions,
  ])
    if (await table.count()) throw new JoinSessionError();
}
async function pinned(db: MiseDatabase, session: JoinSession) {
  const actual = parseJoinSession(await db.joinSessions.get('active'));
  if (
    syncDownloadToken(actual) !== syncDownloadToken(session) ||
    actual.phase !== 'pending'
  )
    throw new JoinSessionError();
  return actual;
}
/** Explicit choice and read identity commit before the first snapshot request. */
export async function prepareCloudJoin(
  db: MiseDatabase,
  options: JoinOptions,
  input: OperatorContext,
  signal?: AbortSignal,
): Promise<JoinSession> {
  const selected = parseOperatorContext(input),
    access = await original(options, selected, signal),
    fresh = await access.metadata.select(selected, signal);
  sameScope(selected, fresh);
  access.check();
  const target = { ...parseSyncScope(fresh), targetHash: access.targetHash! };
  // Keep only the strict download target, excluding server names and scope versions.
  const { businessId, outletId, actorId, accountHash, role, targetHash } =
    target;
  const fixed = {
    businessId,
    outletId,
    actorId,
    accountHash,
    role,
    targetHash,
  };
  return db.transaction('rw', db.tables, async () => {
    const tx = Dexie.currentTransaction,
      check = () => native(db, tx, access.check);
    check();
    await empty(db);
    const raw = await db.joinSessions.get('active'),
      old = raw ? parseJoinSession(raw) : null,
      saved = await db.operatorState.get('active'),
      previous = saved ? parseLocalOperatorState(saved) : null;
    const same =
      old &&
      ['pending', 'paused'].includes(old.phase) &&
      syncDownloadToken(old.target) === syncDownloadToken(fixed) &&
      old.authKey === options.auth.key &&
      old.epoch === fresh.epoch &&
      old.scopeVersion === fresh.scopeVersion;
    if (
      same &&
      previous?.phase === 'pending' &&
      previous.revision === old.operatorRevision &&
      previous.connection?.authKey === old.authKey &&
      previous.connection.targetHash === targetHash &&
      previous.connection.accountHash === accountHash &&
      previous.connection.epoch === fresh.epoch &&
      previous.connection.scopeVersion === fresh.scopeVersion &&
      previous.businessId === businessId &&
      previous.outletId === outletId &&
      previous.actorId === actorId &&
      previous.role === role
    ) {
      const next = parseJoinSession({
        ...old,
        phase: 'pending',
        problem: null,
      });
      check();
      await db.joinSessions.put(next);
      check();
      return next;
    }
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER)
      throw new JoinSessionError();
    const operator: LocalOperatorState = {
      id: 'active',
      version: 1,
      revision,
      phase: 'pending',
      businessId,
      outletId,
      actorId,
      role,
      connection: {
        targetHash,
        authKey: options.auth.key,
        accountHash,
        epoch: fresh.epoch,
        scopeVersion: fresh.scopeVersion,
      },
    };
    const next = parseJoinSession({
      id: 'active',
      version: 1,
      readId: same ? old.readId : newInboxId(),
      target: fixed,
      authKey: options.auth.key,
      epoch: fresh.epoch,
      scopeVersion: fresh.scopeVersion,
      operatorRevision: revision,
      createdAt: same ? old.createdAt : Date.now(),
      phase: 'pending',
      problem: null,
    });
    check();
    if (old && !same)
      await db.joinSessions.put({ ...old, id: 'saved:' + old.readId });
    check();
    await db.operatorState.put(operator);
    check();
    await db.joinSessions.put(next);
    check();
    if (
      syncDownloadToken(await db.operatorState.get('active')) !==
        syncDownloadToken(operator) ||
      syncDownloadToken(await db.joinSessions.get('active')) !==
        syncDownloadToken(next)
    )
      throw new JoinSessionError();
    return next;
  });
}
export function joinProblem(error: unknown): JoinProblem {
  if (error && typeof error === 'object' && 'kind' in error) {
    if (
      error.kind === 'auth' ||
      error.kind === 'retry' ||
      error.kind === 'review'
    )
      return error.kind;
    if (error.kind === 'integrity') return 'review';
  }
  return 'retry';
}
/** Retain the exact read, pages and image bytes while an explicit resume is needed. */
export async function pauseCloudJoin(
  db: MiseDatabase,
  readId: string,
  problem: JoinProblem | null = null,
) {
  return db.transaction('rw', db.joinSessions, async () => {
    const raw = await db.joinSessions.get('active');
    if (!raw) return;
    const session = parseJoinSession(raw);
    if (
      session.readId !== readId ||
      session.phase === 'ready' ||
      session.phase === 'cancelled'
    )
      return;
    await db.joinSessions.put(
      parseJoinSession({ ...session, phase: 'paused', problem }),
    );
  });
}
/** Leaving before admission removes only this join's pending operator. */
export async function cancelCloudJoin(db: MiseDatabase, readId: string) {
  return db.transaction('rw', db.tables, async () => {
    const raw = await db.joinSessions.get('active');
    if (!raw) return;
    const session = parseJoinSession(raw);
    if (
      session.readId !== readId ||
      session.phase === 'ready' ||
      session.phase === 'cancelled'
    )
      return;
    if (await db.cloudState.count()) throw new JoinSessionError();
    const saved = await db.operatorState.get('active');
    if (
      saved &&
      saved.phase !== 'active' &&
      saved.revision >= session.operatorRevision &&
      saved.connection?.authKey === session.authKey &&
      saved.connection.targetHash === session.target.targetHash &&
      saved.connection.accountHash === session.target.accountHash &&
      saved.businessId === session.target.businessId &&
      saved.outletId === session.target.outletId &&
      saved.actorId === session.target.actorId
    )
      await db.operatorState.delete('active');
    await db.joinSessions.put(
      parseJoinSession({ ...session, phase: 'cancelled', problem: null }),
    );
  });
}
/** Resume never creates a fresh read or replaces an already admitted working shop. */
export async function resumeCloudJoin(
  db: MiseDatabase,
  options: JoinOptions,
  signal?: AbortSignal,
): Promise<JoinSession> {
  let session = parseJoinSession(await db.joinSessions.get('active'));
  if (session.phase === 'cancelled') throw new JoinSessionError();
  if (session.phase === 'ready') return session;
  try {
    // Persist explicit resume before remote verification. A later pause must be
    // visible to the operator writer as well as the final domain admission.
    const beforeResume = session;
    session = await db.transaction('rw', db.joinSessions, async () => {
      const current = parseJoinSession(await db.joinSessions.get('active'));
      if (syncDownloadToken(current) !== syncDownloadToken(beforeResume))
        throw new JoinSessionError();
      const next = parseJoinSession({
        ...current,
        phase: 'pending',
        problem: null,
      });
      await db.joinSessions.put(next);
      return next;
    });
    const access = await original(options, context(session), signal),
      account = access.account!;
    const authorization = await account.getAuth();
    const check = () => {
      access.check();
      account.assertCurrent(authorization);
    };
    if (
      session.authKey !== options.auth.key ||
      session.target.targetHash !== access.targetHash
    )
      throw new JoinSessionError('auth');
    const fresh = await access.metadata.select(context(session), signal);
    sameScope(context(session), fresh);
    check();
    // Explicit resume may freshly reselect a locked original operator. The original
    // pending revision remains the admission identity after the domain commit.
    const binding = await db.cloudState.get('binding');
    let operator = parseLocalOperatorState(
      await db.operatorState.get('active'),
    );
    if (operator.phase === 'locked') {
      operator = await selectCloudOperator(
        db,
        fresh,
        { targetHash: session.target.targetHash, authKey: session.authKey },
        operator.revision,
        async (value) => {
          const next = await access.metadata.select(value, signal);
          sameScope(fresh, next);
          check();
          return next;
        },
        check,
        session,
      );
    }
    const originalSession = session;
    session = await db.transaction(
      'rw',
      db.joinSessions,
      db.operatorState,
      db.cloudState,
      async () => {
        const tx = Dexie.currentTransaction;
        native(db, tx, check);
        const current = parseJoinSession(await db.joinSessions.get('active')),
          actual = parseLocalOperatorState(
            await db.operatorState.get('active'),
          );
        if (
          syncDownloadToken(current) !== syncDownloadToken(originalSession) ||
          syncDownloadToken(actual) !== syncDownloadToken(operator) ||
          syncDownloadToken(await db.cloudState.get('binding')) !==
            syncDownloadToken(binding)
        )
          throw new JoinSessionError();
        if (
          actual.connection?.authKey !== current.authKey ||
          actual.connection.targetHash !== current.target.targetHash ||
          actual.connection.accountHash !== current.target.accountHash ||
          actual.businessId !== current.target.businessId ||
          actual.outletId !== current.target.outletId ||
          actual.actorId !== current.target.actorId ||
          actual.role !== current.target.role ||
          actual.connection.epoch !== current.epoch ||
          actual.connection.scopeVersion !== current.scopeVersion ||
          actual.phase !== (binding ? 'active' : 'pending')
        )
          throw new JoinSessionError('auth');
        const next = parseJoinSession({
          ...current,
          phase: 'pending',
          problem: null,
          operatorRevision: binding
            ? current.operatorRevision
            : actual.revision,
        });
        native(db, tx, check);
        await db.joinSessions.put(next);
        native(db, tx, check);
        return next;
      },
    );
    if (!binding) {
      check();
      await prepareSyncDownload(db, {
        id: session.readId,
        target: session.target,
        previousCursor: null,
      });
      const read = createCloudSyncRemote(
        access.config,
        async () => {
          const value = await account.getAuth();
          check();
          return value.jwt;
        },
        options.send,
      );
      await runSyncDownload(db, session.readId, session.target, read, signal);
      await downloadSyncImages(
        db,
        session.readId,
        session.target,
        createCloudImageRemote(
          access.config,
          options.base + session.target.businessId,
          account.getAuth,
          options.send,
        ),
        signal,
      );
    }
    check();
    const joined = await joinCanonicalDevice(
      db,
      {
        readId: session.readId,
        target: session.target,
        authKey: session.authKey,
        expectedOperatorRevision: session.operatorRevision,
        session,
      },
      async (value) => {
        const next = await access.metadata.select(value, signal);
        sameScope(fresh, next);
        check();
        return next;
      },
      signal,
      check,
    );
    return await db.transaction('rw', db.tables, async () => {
      const tx = Dexie.currentTransaction;
      native(db, tx, check);
      const current = parseJoinSession(await db.joinSessions.get('active'));
      if (
        current.phase === 'ready' &&
        syncDownloadToken({ ...current, phase: 'pending' }) ===
          syncDownloadToken(session)
      )
        return current;
      await pinned(db, session);
      const active = parseLocalOperatorState(
        await db.operatorState.get('active'),
      );
      if (
        active.phase !== 'active' ||
        active.revision < joined.operatorRevision ||
        active.connection?.authKey !== session.authKey
      )
        throw new JoinSessionError('auth');
      await ensureSyncSession(
        db,
        {
          target: session.target,
          authKey: session.authKey,
          operatorRevision: active.revision,
          epoch: session.epoch,
          scopeVersion: session.scopeVersion,
        },
        newInboxId(),
      );
      native(db, tx, check);
      await requestSync(db, true);
      native(db, tx, check);
      await pinned(db, session);
      const bindingBefore = await db.cloudState.get('binding');
      const next = parseJoinSession({
        ...session,
        phase: 'ready',
        problem: null,
      });
      const syncBefore = await db.syncSessions.get('active');
      await db.joinSessions.put(next);
      native(db, tx, check);
      if (
        syncDownloadToken(await db.joinSessions.get('active')) !==
          syncDownloadToken(next) ||
        syncDownloadToken(await db.operatorState.get('active')) !==
          syncDownloadToken(active) ||
        syncDownloadToken(await db.cloudState.get('binding')) !==
          syncDownloadToken(bindingBefore) ||
        syncDownloadToken(await db.syncSessions.get('active')) !==
          syncDownloadToken(syncBefore)
      )
        throw new JoinSessionError();
      return next;
    });
  } catch (error) {
    // Do not let an older runner pause a newer selection or completed admission.
    await db.transaction('rw', db.joinSessions, async () => {
      const raw = await db.joinSessions.get('active');
      if (raw && syncDownloadToken(raw) === syncDownloadToken(session))
        await db.joinSessions.put(
          parseJoinSession({
            ...session,
            phase: 'paused',
            problem: joinProblem(error),
          }),
        );
    });
    throw new JoinSessionError(joinProblem(error));
  }
}
