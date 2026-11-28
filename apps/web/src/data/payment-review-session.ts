import type { MiseDatabase } from './db';
import type { SetupSnapshot } from '@mise/core/models';
import type { KeyStorage } from '@mise/core/cloud-connection';
import { readCloudConnection } from '@mise/core/cloud-connection';
import type { PhoneAuth } from './phone-auth';
import { getPhoneAuth } from './phone-auth';
import { resolveCloudAuthScope } from './cloud-auth-scope';
import { readPaymentReviewFrame } from './payment-review';
import { OriginalCopyJournal } from './original-copies';
import { nativePaymentCopyJournalName } from './native-payment-review-session';
import { createNativePaymentOutboxSession } from './native-payment-session';
import type { openSavedPaymentSource } from './payment-capture';

/** Opens the real installation's SDK/native capability. A flag, connection
 * label or serialized review cannot enable a connected payment mutation. */
export async function openConfiguredPaymentSource(
  db: MiseDatabase,
  setup: SetupSnapshot,
  itemId: string,
  frameKey: string,
  options: Parameters<typeof openSavedPaymentSource>[3] = {},
  connection: {
    storage: KeyStorage;
    auth?: PhoneAuth;
    send?: typeof fetch;
    base: string;
  },
  signal?: AbortSignal,
) {
  const check = () => signal?.throwIfAborted();
  check();
  const frame = await readPaymentReviewFrame(db, setup, itemId);
  if (!frame.nativeEligible || frame.key !== frameKey)
    throw Error('Open the current payment source and connection again.');
  const config = readCloudConnection(connection.storage);
  if (!config)
    throw Error(
      'Configure this installation’s backend in Sync settings. The original stays on this device.',
    );
  const selected = await db.operatorState.get('active'),
    state = await db.syncSessions.get('active'),
    scope = await resolveCloudAuthScope(
      config,
      connection.base,
      setup.business.id,
      state?.authKey ?? selected?.connection?.authKey,
    ),
    auth = connection.auth ?? (await getPhoneAuth(config, scope));
  check();
  const journal = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
  let session:
    Awaited<ReturnType<typeof createNativePaymentOutboxSession>> | undefined;
  const stop = () => {
    session?.stop();
    journal.close();
    signal?.removeEventListener('abort', stop);
  };
  try {
    session = await createNativePaymentOutboxSession(db, {
      config,
      auth,
      authScope: scope,
      storage: connection.storage,
      journal,
      send: connection.send,
      signal,
    });
    check();
    const review = await session.review(itemId, options);
    const fresh = await readPaymentReviewFrame(db, setup, itemId);
    check();
    if (fresh.key !== frameKey)
      throw Error(
        'The source, account or accepted payment history changed. Open its current review.',
      );
    signal?.addEventListener('abort', stop, { once: true });
    return { review, native: true as const, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
