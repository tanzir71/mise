import {
  cloudAuthStorageKey,
  cloudConnectionTarget,
  parseCloudConnection,
  readCloudConnection,
  type CloudConnection,
  type KeyStorage,
} from '@mise/core/cloud-connection';
import { operatorAccountHash } from '@mise/core/operators';
import { CommandRequestError } from './command-request';
import { discoveryAuthScope } from './cloud-auth-scope';
import { createPhoneAuth, type PhoneAuth } from './phone-auth';
import { createOwnerTaskAccount } from './owner-task-account';
import {
  parseOwnerTaskJournal,
  parseOwnerTaskLocator,
  type OwnerTaskLocator,
} from './owner-task-journal';
import { createOwnerTaskSession } from './owner-task-session';

/** Personal recovery has its own SDK namespace. It cannot select an operator. */
export const ownerTaskRecoveryAuthScope = (base: string) =>
  base + 'task-recovery';
const connectionKey = 'mise.owner-tasks.recovery.connection.v1';
export function readOwnerTaskRecoveryConnection(
  storage: KeyStorage,
): CloudConnection | null {
  const raw = storage.getItem(connectionKey);
  if (raw === null) return readCloudConnection(storage);
  if (raw.length > 4096)
    throw new Error('Review the original shop connection.');
  return parseCloudConnection(JSON.parse(raw));
}
export function saveOwnerTaskRecoveryConnection(
  storage: KeyStorage,
  input: unknown,
) {
  const config = parseCloudConnection(input),
    raw = JSON.stringify(config);
  storage.setItem(connectionKey, raw);
  if (storage.getItem(connectionKey) !== raw)
    throw new Error('This browser could not save the recovery connection.');
  return config;
}
const bad = () => new CommandRequestError('auth');
async function originalScope(
  config: CloudConnection,
  base: string,
  locator: OwnerTaskLocator,
  manager: PhoneAuth,
) {
  const identity = manager.journalIdentity(),
    accountHash = await operatorAccountHash(identity.userId);
  manager.assertJournalIdentity(identity);
  if (accountHash !== locator.accountHash) throw bad();
  const scopes = [base + locator.businessId, discoveryAuthScope(base)],
    matches: string[] = [];
  for (const scope of scopes)
    if (
      (await cloudConnectionTarget(config, scope, identity.userId)) ===
      locator.targetHash
    )
      matches.push(scope);
  manager.assertJournalIdentity(identity);
  if (matches.length !== 1) throw bad();
  return matches[0];
}
/** Each view is independently owned. Disposing it must preserve other clients. */
export async function openOwnerTaskRecoveryAuth(
  config: CloudConnection,
  base: string,
  key: string,
  deps: { storage: KeyStorage; send?: typeof fetch; separate?: boolean },
) {
  const locator = parseOwnerTaskLocator(key);
  parseCloudConnection(config);
  if (!deps.separate)
    for (const scope of [base + locator.businessId, discoveryAuthScope(base)]) {
      const storageKey = await cloudAuthStorageKey(config, scope);
      if (deps.storage.getItem(storageKey) === null) continue;
      const manager = await createPhoneAuth(config, scope, deps);
      let matches = false;
      try {
        matches =
          (await originalScope(config, base, locator, manager)) === scope;
      } catch {
        /* Another saved account cannot open this journal. */
      }
      if (matches) return { manager, borrowed: true };
      await manager.dispose();
    }
  return {
    manager: await createPhoneAuth(
      config,
      ownerTaskRecoveryAuthScope(base),
      deps,
    ),
    borrowed: false,
  };
}
/** No fresh list, submit, draft, native selection or membership API is exposed. */
export async function openOwnerTaskRecovery(
  input: CloudConnection,
  base: string,
  key: string,
  manager: PhoneAuth,
  deps: {
    storage: KeyStorage;
    assertLocal: () => void;
    locks?: Pick<LockManager, 'request'>;
    send?: typeof fetch;
  },
) {
  const config = parseCloudConnection(input),
    locator = parseOwnerTaskLocator(key);
  deps.assertLocal();
  const scope = await originalScope(config, base, locator, manager),
    allowed = await Promise.all([
      cloudAuthStorageKey(config, scope),
      cloudAuthStorageKey(config, ownerTaskRecoveryAuthScope(base)),
    ]);
  if (!allowed.includes(manager.key)) throw bad();
  const { account, assertDraftAccount } = await createOwnerTaskAccount(
    config,
    scope,
    manager,
    null,
    deps.assertLocal,
  );
  assertDraftAccount();
  if (
    account.accountHash !== locator.accountHash ||
    account.targetHash !== locator.targetHash
  )
    throw bad();
  const saved = parseOwnerTaskJournal(deps.storage.getItem(key), locator);
  assertDraftAccount();
  const context = saved.actions.at(-1)?.intent.scope;
  if (!context) return null;
  const session = createOwnerTaskSession(config, account, context, {
    ...deps,
    assertDraftAccount,
    assertScope: async () => {
      assertDraftAccount();
    },
  });
  return {
    key: session.key,
    saved: session.saved,
    inspect: (id: string, signal?: AbortSignal) =>
      session.call(id, 'inspect', signal),
    close: (id: string, signal?: AbortSignal) =>
      session.call(id, 'close', signal),
    copy: session.copy,
    prepareArchive: session.prepareArchive,
    verifyArchiveFile: session.verifyArchiveFile,
    finishArchive: session.finishArchive,
    assertFile: session.assertFile,
    assertCurrent: session.assertCurrent,
    subscribe: session.subscribe,
    stop: session.stop,
  };
}
export type OwnerTaskRecovery = NonNullable<
  Awaited<ReturnType<typeof openOwnerTaskRecovery>>
>;
