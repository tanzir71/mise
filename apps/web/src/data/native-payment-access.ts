import type { MiseDatabase } from './db';
import {
  createNativeOriginalCopySession,
  type NativeOriginalCopySession,
} from './original-copy-session';
import {
  parseCloudConnection,
  readCloudConnection,
} from '@mise/core/cloud-connection';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import { literalToken } from '@mise/core/literal-token';
import { CommandRequestError } from './command-request';
import type { OriginalCopyIdentity } from './original-copies';

export interface NativePaymentAccess {
  readonly identity: OriginalCopyIdentity;
  readonly copies: NativeOriginalCopySession;
  stop(): void;
}
type Options = Parameters<typeof createNativeOriginalCopySession>[1];
const issued = new WeakMap<
  NativePaymentAccess,
  {
    db: MiseDatabase;
    current: () => void;
  }
>();
/** A runtime capability from the actual SDK/native controller. Backups and
 * serialized account labels cannot create a connected payment-review permit. */
export async function createNativePaymentAccess(
  db: MiseDatabase,
  options: Options,
) {
  const config = parseCloudConnection(options.config),
    { auth, storage } = options,
    account = auth.journalIdentity(),
    copies = Object.freeze(await createNativeOriginalCopySession(db, options));
  let active = true;
  const current = () => {
    try {
      if (
        !active ||
        literalToken(readCloudConnection(storage)) !== literalToken(config)
      )
        throw Error();
      auth.assertJournalIdentity(account);
    } catch {
      stop();
      throw new CommandRequestError('auth');
    }
  };
  function stop() {
    active = false;
    copies.stop();
  }
  const access: NativePaymentAccess = Object.freeze({
    identity: copies.identity,
    copies,
    stop,
  });
  issued.set(access, { db, current });
  try {
    await assertNativePaymentScope(access, db);
  } catch (error) {
    stop();
    throw error;
  }
  return access;
}
export function assertNativePaymentAccess(
  access: NativePaymentAccess,
  db: MiseDatabase,
  scope?: { businessId: string; outletId: string; actorId: string },
): OriginalCopyIdentity {
  const proof = issued.get(access);
  if (!proof || proof.db !== db) throw new CommandRequestError('auth');
  proof.current();
  if (
    scope &&
    (scope.businessId !== access.identity.businessId ||
      scope.outletId !== access.identity.outletId ||
      scope.actorId !== access.identity.actorId)
  )
    throw new CommandRequestError('auth');
  return access.identity;
}
export async function assertNativePaymentScope(
  access: NativePaymentAccess,
  db: MiseDatabase,
) {
  const identity = assertNativePaymentAccess(access, db);
  await access.copies.assertCurrent();
  const binding = parseLocalCloudState(await db.cloudState.get('binding'));
  if (
    binding.phase !== 'ready' ||
    binding.businessId !== identity.businessId ||
    binding.outletId !== identity.outletId ||
    binding.ownerId !== identity.actorId ||
    binding.targetHash !== identity.targetHash
  )
    throw new CommandRequestError('auth');
  assertNativePaymentAccess(access, db);
  return identity;
}
