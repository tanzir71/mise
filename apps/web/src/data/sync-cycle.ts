import { createNativeCanonicalOriginals } from './native-canonical-originals';
import { createNativePaymentOutboxSession } from './native-payment-session';
import { OriginalCopyJournal } from './original-copies';
import { nativePaymentCopyJournalName } from './native-payment-review-session';
import { nativePaymentQueueToken } from './native-payment-sync-source';
import { parseNativePaymentOutbox } from '@mise/core/native-payment-outbox';
import { readNativePaymentState } from './native-payment-state';
import {
  parseCloudConnection,
  cloudConnectionTarget,
  type CloudConnection,
  type KeyStorage,
} from '@mise/core/cloud-connection';
import {
  operatorAccountHash,
  parseOperatorContext,
  OperatorContextError,
} from '@mise/core/operators';
import { parseSyncScope } from '@mise/core/sync-read';
import { syncDownloadToken } from '@mise/core/sync-download';
import {
  parseSyncSession,
  SyncSessionError,
  type SyncSession,
  type SyncProblem,
} from '@mise/core/sync-session';
import {
  materializationHash,
  ReconciliationError,
} from '@mise/core/sync-materialize';
import { newInboxId } from '@mise/core/inbox';
import { SyncImageError } from '@mise/core/sync-images';
import { SyncCoverageError } from '@mise/core/sync-coverage';
import { UploadAdmissionError } from '@mise/core/sync-upload-admission';
import { ScopeRecoveryError } from '@mise/core/scope-recovery';
import { isLocalInboxRetention } from '@mise/core/local-inbox';
import type { MiseDatabase } from './db';
import type { PhoneAuth } from './phone-auth';
import type { CommandAccount, CommandAuthorization } from './command-request';
import { CommandRequestError } from './command-request';
import { createCloudCommandRemote } from './cloud-command-remote';
import { createOperatorRemote } from './operator-remote';
import { createCloudSyncRemote, CloudSyncReadError } from './cloud-sync-remote';
import { createCloudImageRemote } from './cloud-image-remote';
import { createCloudCoverageRemote } from './cloud-coverage-remote';
import { createCloudUploadCoverageRemote } from './cloud-upload-coverage-remote';
import { prepareSyncDownload, runSyncDownload } from './cloud-sync-journal';
import { downloadSyncImages } from './cloud-sync-images';
import { applyCanonicalDownload, adoptOwnerUpload } from './cloud-sync-apply';
import { deliverLocalOutbox, deliverLocalInboxImages } from './local-outbox';
import { createCloudInboxImageUploader } from './cloud-inbox-upload';
import { CloudUploadJournal } from './cloud-upload';
import {
  claimSyncSession,
  sessionLease,
  renewSyncSession,
  syncSessionRead,
  finishSyncSession,
  failSyncSession,
  releaseSyncSession,
} from './sync-session';

export interface SyncCycleOptions {
  config: CloudConnection;
  scope: string;
  auth: PhoneAuth;
  journal: CloudUploadJournal;
  storage?: KeyStorage;
  nativeAuthScope?: string;
  send?: typeof fetch;
  now?: () => number;
  random?: () => number;
  connectionCurrent?: () => boolean;
}
/** Live identity checks remain ephemeral, including the connection check at native receipt write. */
export function cycleAccount(
  options: Pick<SyncCycleOptions, 'config' | 'scope' | 'connectionCurrent'> & {
    auth: Pick<
      PhoneAuth,
      'key' | 'commandAuthorization' | 'assertCommandAuthorization'
    >;
  },
  state: Pick<SyncSession, 'target' | 'authKey'>,
): CommandAccount {
  const config = parseCloudConnection(options.config);
  let generation: number | undefined;
  function assertCurrent(value: CommandAuthorization) {
    try {
      if (
        options.connectionCurrent?.() === false ||
        options.auth.key !== state.authKey
      )
        throw new SyncSessionError('auth');
      options.auth.assertCommandAuthorization(value);
      if (generation !== undefined && value.generation !== generation)
        throw new SyncSessionError('auth');
    } catch (error) {
      if (error instanceof SyncSessionError) throw error;
      throw new SyncSessionError(
        error &&
          typeof error === 'object' &&
          'kind' in error &&
          error.kind === 'retry'
          ? 'retry'
          : 'auth',
      );
    }
  }
  return {
    scope: options.scope,
    accountHash: state.target.accountHash,
    targetHash: state.target.targetHash,
    assertCurrent,
    async getAuth() {
      let value: CommandAuthorization;
      try {
        value = await options.auth.commandAuthorization();
        assertCurrent(value);
        const [account, target] = await Promise.all([
          operatorAccountHash(value.userId),
          cloudConnectionTarget(config, options.scope, value.userId),
        ]);
        if (
          account !== state.target.accountHash ||
          target !== state.target.targetHash
        )
          throw Error();
        assertCurrent(value);
      } catch (error) {
        throw new SyncSessionError(
          error &&
            typeof error === 'object' &&
            'kind' in error &&
            error.kind === 'retry'
            ? 'retry'
            : 'auth',
        );
      }
      generation ??= value.generation;
      return value;
    },
  };
}
function problem(error: unknown): SyncProblem {
  if (
    error instanceof SyncSessionError ||
    error instanceof CommandRequestError ||
    error instanceof CloudSyncReadError ||
    error instanceof SyncImageError ||
    error instanceof SyncCoverageError ||
    error instanceof UploadAdmissionError ||
    error instanceof ScopeRecoveryError
  )
    return error.kind === 'integrity' ? 'review' : error.kind;
  if (error instanceof OperatorContextError) return error.kind;
  if (error instanceof ReconciliationError)
    return error.kind === 'review' ? 'retry' : 'review';
  return 'retry';
}
/** One leased send/pull/apply cycle; only the canonical writer accepts a cursor. */
export async function runSyncCycle(
  db: MiseDatabase,
  options: SyncCycleOptions,
  signal?: AbortSignal,
  takeOver = false,
): Promise<boolean> {
  signal?.throwIfAborted();
  const now = options.now ?? Date.now;
  let preparationProblem: unknown;
  // Complete local originals before claiming a short network-delivery lease.
  // No HTTP or financial action runs here. The subsequent claim still checks
  // current selection, pause/retry state, ownership and competing leases.
  if (await db.nativePaymentActions.count()) {
    const ready = await activeSyncSession(db);
    if (
      !ready ||
      ready.paused ||
      ready.problem === 'auth' ||
      ready.problem === 'review' ||
      ready.retryAt > now() ||
      (ready.lease && ready.lease.until > now() && !takeOver)
    )
      return false;
    const pending = (await db.nativePaymentActions.toArray())
      .map(parseNativePaymentOutbox)
      .some((r) => r.original.marker && !r.nativeReceipt);
    if (pending) {
      const storage =
          options.storage ??
          (typeof window !== 'undefined' ? window.localStorage : undefined),
        journal = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
      let preparation:
        | Awaited<ReturnType<typeof createNativePaymentOutboxSession>>
        | undefined;
      try {
        if (!storage) throw new SyncSessionError('auth');
        preparation = await createNativePaymentOutboxSession(db, {
          config: options.config,
          auth: options.auth,
          authScope: options.nativeAuthScope ?? options.scope,
          storage,
          journal,
          send: options.send,
          signal,
        });
        await preparation.prepare();
      } catch (error) {
        preparationProblem = error ?? new SyncSessionError();
      } finally {
        preparation?.stop();
        journal.close();
      }
    }
  }
  if (signal?.aborted) return false;
  const claimed = await claimSyncSession(db, newInboxId(), now(), takeOver);
  if (!claimed) return false;
  const lease = sessionLease(claimed),
    controller = new AbortController(),
    lifetime = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  let heartbeatProblem: SyncProblem | null = null;
  let nativeJournal: OriginalCopyJournal | undefined,
    nativeDelivery:
      Awaited<ReturnType<typeof createNativePaymentOutboxSession>> | undefined;
  const heartbeat = setInterval(() => {
    void renewSyncSession(db, lease, now()).catch((error) => {
      heartbeatProblem = problem(error);
      controller.abort();
    });
  }, 10000);
  try {
    if (preparationProblem !== undefined) throw preparationProblem;
    const account = cycleAccount(options, claimed),
      send = options.send ?? fetch;
    let latestAuthorization: CommandAuthorization | undefined;
    const auth = async () => {
        latestAuthorization = await account.getAuth();
        return latestAuthorization;
      },
      assertActive = () => {
        lifetime.throwIfAborted();
        if (!latestAuthorization) throw new SyncSessionError('auth');
        account.assertCurrent(latestAuthorization);
      },
      metadata = createOperatorRemote(options.config, auth, send);
    const { targetHash: _, ...contextTarget } = claimed.target;
    void _;
    const context = parseOperatorContext({
      ...contextTarget,
      epoch: claimed.epoch,
      scopeVersion: claimed.scopeVersion,
      version: 1,
      businessName: null,
      outletName: null,
      actorName: null,
    });
    const refresh = async (value: typeof context) => {
      const fresh = await metadata.select(value, lifetime);
      await auth();
      if (
        syncDownloadToken(parseSyncScope(fresh)) !==
        syncDownloadToken(parseSyncScope(context))
      )
        throw new SyncSessionError('review');
      return fresh;
    };
    await refresh(context);
    if (await db.nativePaymentActions.count()) {
      const storage =
        options.storage ??
        (typeof window !== 'undefined' ? window.localStorage : undefined);
      if (!storage) throw new SyncSessionError('auth');
      nativeJournal = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
      nativeDelivery = await createNativePaymentOutboxSession(db, {
        config: options.config,
        auth: options.auth,
        authScope: options.nativeAuthScope ?? options.scope,
        storage,
        journal: nativeJournal,
        send,
        signal: lifetime,
        deliveryLease: lease,
        deliveryPaused: false,
      });
      const delivered = await nativeDelivery.deliver();
      if (delivered.blockedEntryId) throw new SyncSessionError('review');
    } else {
      const commands = createCloudCommandRemote(options.config, account, send),
        delivery = await deliverLocalOutbox(
          db,
          claimed.target.targetHash,
          (command, currency, _signal, parent) =>
            commands(command, currency, lifetime, parent),
        );
      if (delivery.retained) throw new SyncSessionError('review');
    }
    await deliverLocalInboxImages(
      db,
      claimed.target.targetHash,
      createCloudInboxImageUploader(options.config, account, send),
      lifetime,
    );
    lifetime.throwIfAborted();
    const queue = await db.outbox.orderBy('[uploadId+sequence]').toArray(),
      nativeProgress = (await db.nativePaymentActions.toArray()).map(
        parseNativePaymentOutbox,
      ),
      legacyProgress = queue.map((row) => ({
        id: row.id,
        receipts: row.receipts,
      })),
      queueHash = await materializationHash(
        nativeProgress.length
          ? [legacyProgress, nativePaymentQueueToken(nativeProgress)]
          : legacyProgress,
      ),
      state = await syncSessionRead(db, lease, queueHash, newInboxId()),
      readId = state.readId!,
      base = await db.syncCanonical.get('active');
    const alreadyApplied = base?.snapshot.readId === readId;
    if (!alreadyApplied)
      await prepareSyncDownload(db, {
        id: readId,
        target: state.target,
        previousCursor: base?.snapshot.cursor ?? null,
      });
    const read = createCloudSyncRemote(
        options.config,
        async () => (await auth()).jwt,
        send,
      ),
      images = createCloudImageRemote(
        options.config,
        options.scope,
        auth,
        send,
      ),
      coverage = createCloudCoverageRemote(
        options.config,
        options.scope,
        auth,
        send,
      ),
      uploadCoverage = createCloudUploadCoverageRemote(
        options.config,
        options.scope,
        auth,
        send,
      );
    if (!alreadyApplied) {
      await runSyncDownload(db, readId, state.target, read, lifetime);
      await auth();
      await downloadSyncImages(db, readId, state.target, images, lifetime);
    }
    const input = {
      readId,
      target: state.target,
      authKey: state.authKey,
      expectedOperatorRevision: state.operatorRevision,
    };
    const savedNative = await readNativePaymentState(db),
      knownCopies = new Set(
        savedNative?.projection.actions.map(
          (a) => a.source.retention.copy.id,
        ) ?? [],
      ),
      nativeSources = createNativeCanonicalOriginals(
        options.config,
        account,
        {
          businessId: state.target.businessId,
          outletId: state.target.outletId,
          actorId: state.target.actorId,
        },
        send,
        lifetime,
        assertActive,
        async (link) => {
          if (savedNative && knownCopies.has(link.retention.copy.id))
            return savedNative.loadOriginal(link);
          return (await nativeDelivery?.readDeliveredOriginal(link)) ?? null;
        },
      );
    try {
      if (base)
        await applyCanonicalDownload(
          db,
          input,
          coverage,
          refresh,
          lifetime,
          assertActive,
          nativeSources.load,
        );
      else {
        const binding = await db.cloudState.get('binding');
        if (binding?.version !== 1) throw new SyncSessionError('review');
        const original = await options.journal.readSnapshot(binding.uploadId);
        await adoptOwnerUpload(
          db,
          input,
          { manifest: original.manifest, chunks: original.chunks },
          uploadCoverage,
          coverage,
          refresh,
          lifetime,
          assertActive,
          nativeSources.load,
        );
      }
    } finally {
      nativeSources.stop();
    }
    const confirmed = await auth();
    account.assertCurrent(confirmed);
    await finishSyncSession(
      db,
      lease,
      readId,
      claimed.requested,
      now(),
      assertActive,
    );
    return true;
  } catch (error) {
    if (signal?.aborted) {
      await releaseSyncSession(db, lease);
      return false;
    }
    let kind = heartbeatProblem ?? problem(error);
    if (
      error instanceof ReconciliationError &&
      error.kind === 'retained' &&
      !(await db.outbox
        .where('status')
        .equals('retained')
        .filter((row) => !isLocalInboxRetention(row))
        .count()) &&
      (await db.outbox.where('status').equals('pending').count())
    )
      kind = 'retry';
    await failSyncSession(
      db,
      lease,
      kind,
      now(),
      options.random?.() ?? Math.random(),
    );
    return false;
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    nativeDelivery?.stop();
    nativeJournal?.close();
  }
}
export async function activeSyncSession(
  db: MiseDatabase,
): Promise<SyncSession | null> {
  const raw = await db.syncSessions.get('active');
  return raw ? parseSyncSession(raw) : null;
}
