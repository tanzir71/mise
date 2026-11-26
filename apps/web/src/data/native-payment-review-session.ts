import type { SetupSnapshot } from '@mise/core/models';
import type { CloudConnection, KeyStorage } from '@mise/core/cloud-connection';
import { newInboxId } from '@mise/core/inbox';
import type { MiseDatabase } from './db';
import type { PhoneAuth } from './phone-auth';
import { OriginalCopyJournal } from './original-copies';
import { createNativePaymentOutboxSession } from './native-payment-session';
import { readNativePaymentQueue } from './native-payment-review';
import {
  pauseSyncSession,
  claimPausedSyncSession,
  assertPausedSyncSession,
  sessionLease,
  renewSyncSession,
  releaseSyncSession,
} from './sync-session';
import { CommandRequestError } from './command-request';

export interface NativePaymentQueueOptions {
  setup: SetupSnapshot;
  config: CloudConnection;
  auth: PhoneAuth;
  storage: KeyStorage;
  authScope: string;
  expectedToken: string;
  send?: typeof fetch;
}
export const nativePaymentCopyJournalName = (db: Pick<MiseDatabase, 'name'>) =>
  'mise-native-payment-copies:' + db.name;

/** Continue only persisted original approvals. Normal sync remains paused:
 * a financial outcome is not a canonical cursor or historical registration. */
export async function continueNativePaymentQueue(
  db: MiseDatabase,
  options: NativePaymentQueueOptions,
  signal?: AbortSignal,
) {
  options = {
    ...options,
    setup: structuredClone(options.setup),
    config: { ...options.config },
  };
  signal?.throwIfAborted();
  const before = await readNativePaymentQueue(db, options.setup);
  if (!before.canContinue || before.token !== options.expectedToken)
    throw new CommandRequestError('review');
  await pauseSyncSession(db);
  const claimed = await claimPausedSyncSession(db, newInboxId(), Date.now());
  if (!claimed) throw new CommandRequestError('retry');
  const lease = sessionLease(claimed),
    lifetime = new AbortController(),
    abort = () => lifetime.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) lifetime.abort();
  let heartbeatFailure = false;
  const heartbeat = setInterval(() => {
    void assertPausedSyncSession(db, lease)
      .then(() => renewSyncSession(db, lease, Date.now()))
      .catch(() => {
        heartbeatFailure = true;
        lifetime.abort();
      });
  }, 10000);
  const journal = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
  let session:
    Awaited<ReturnType<typeof createNativePaymentOutboxSession>> | undefined;
  try {
    lifetime.signal.throwIfAborted();
    const fresh = await readNativePaymentQueue(db, options.setup);
    if (!fresh.canContinue || fresh.token !== options.expectedToken)
      throw new CommandRequestError('review');
    session = await createNativePaymentOutboxSession(db, {
      config: options.config,
      auth: options.auth,
      storage: options.storage,
      authScope: options.authScope,
      journal,
      send: options.send,
      signal: lifetime.signal,
      deliveryLease: lease,
    });
    lifetime.signal.throwIfAborted();
    const result = await session.deliver();
    await assertPausedSyncSession(db, lease);
    lifetime.signal.throwIfAborted();
    if (heartbeatFailure) throw new CommandRequestError('retry');
    return { result, queue: await readNativePaymentQueue(db, options.setup) };
  } finally {
    lifetime.abort();
    session?.stop();
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
    journal.close();
    await releaseSyncSession(db, lease);
  }
}
