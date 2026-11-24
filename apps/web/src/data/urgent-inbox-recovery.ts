import {
  cloudAuthStorageKey,
  cloudConnectionTarget,
  parseCloudConnection,
  readCloudConnection,
  type CloudConnection,
  type KeyStorage,
} from '@mise/core/cloud-connection';
import { operatorAccountHash } from '@mise/core/operators';
import { deskProfileScope, type DeskCache } from './desk-cache';
import {
  createUrgentInboxCache,
  parseUrgentInboxProfile,
  type UrgentInboxProfile,
} from './urgent-inbox-cache';
import { parseUrgentInboxOperation } from './urgent-inbox-operation';
import { resolveCloudAuthScope } from './cloud-auth-scope';
import { createPhoneAuth, type PhoneAuth } from './phone-auth';
import { createOwnerTaskAccount } from './owner-task-account';
import { CommandRequestError } from './command-request';
import { createUrgentInboxRemote } from './urgent-inbox-remote';

const connectionKey = 'mise.urgent-inbox.recovery.connection.v1';
export const urgentRecoveryAuthScope = (base: string) =>
  base + 'urgent-alert-recovery';
export function readUrgentRecoveryConnection(storage: KeyStorage) {
  const raw = storage.getItem(connectionKey);
  if (raw === null) return readCloudConnection(storage);
  if (raw.length > 4096) throw new CommandRequestError('review');
  return parseCloudConnection(JSON.parse(raw));
}
export function saveUrgentRecoveryConnection(
  storage: KeyStorage,
  input: CloudConnection,
) {
  const config = parseCloudConnection(input),
    raw = JSON.stringify(config);
  storage.setItem(connectionKey, raw);
  if (storage.getItem(connectionKey) !== raw)
    throw new CommandRequestError('review');
  return config;
}
async function own(
  input: CloudConnection,
  base: string,
  profile: UrgentInboxProfile,
  manager: PhoneAuth,
) {
  const config = parseCloudConnection(input),
    binding = profile.binding,
    scope = await resolveCloudAuthScope(
      config,
      base,
      binding.businessId,
      binding.connection.authKey,
    ),
    identity = manager.journalIdentity(),
    [accountHash, targetHash] = await Promise.all([
      operatorAccountHash(identity.userId),
      cloudConnectionTarget(config, scope, identity.userId),
    ]);
  manager.assertJournalIdentity(identity);
  if (
    accountHash !== binding.connection.accountHash ||
    targetHash !== binding.connection.targetHash
  )
    throw new CommandRequestError('auth');
  return scope;
}
export async function openUrgentRecoveryAuth(
  input: CloudConnection,
  base: string,
  value: UrgentInboxProfile,
  deps: { storage: KeyStorage; send?: typeof fetch; separate?: boolean },
) {
  const config = parseCloudConnection(input),
    profile = parseUrgentInboxProfile(value),
    scope = await resolveCloudAuthScope(
      config,
      base,
      profile.binding.businessId,
      profile.binding.connection.authKey,
    ),
    key = await cloudAuthStorageKey(config, scope);
  if (!deps.separate && deps.storage.getItem(key) !== null) {
    const manager = await createPhoneAuth(config, scope, deps);
    let matches = false;
    try {
      await own(config, base, profile, manager);
      matches = true;
    } catch {
      /* Another saved account is not this original. */
    }
    if (matches) return { manager, borrowed: true };
    await manager.dispose();
  }
  return {
    manager: await createPhoneAuth(config, urgentRecoveryAuthScope(base), deps),
    borrowed: false,
  };
}
/** Only original inspection and withdrawal. No task read, new consent, native
 * selection or membership method is exposed to a personal recovery view. */
export async function openUrgentRecovery(
  input: CloudConnection,
  base: string,
  value: UrgentInboxProfile,
  manager: PhoneAuth,
  cache: DeskCache,
  deps: { storage: KeyStorage; check: () => void; send?: typeof fetch },
) {
  const config = parseCloudConnection(input),
    profile = parseUrgentInboxProfile(value),
    scope = await own(config, base, profile, manager),
    allowed = [
      await cloudAuthStorageKey(config, scope),
      await cloudAuthStorageKey(config, urgentRecoveryAuthScope(base)),
    ];
  if (!allowed.includes(manager.key)) throw new CommandRequestError('auth');
  const { account, assertDraftAccount } = await createOwnerTaskAccount(
      config,
      scope,
      manager,
      null,
      deps.check,
    ),
    journal = createUrgentInboxCache(cache);
  assertDraftAccount();
  if (
    account.accountHash !== profile.binding.connection.accountHash ||
    account.targetHash !== profile.binding.connection.targetHash
  )
    throw new CommandRequestError('auth');
  function remote(binding: UrgentInboxProfile['binding']) {
    assertDraftAccount();
    return createUrgentInboxRemote(
      config,
      account,
      deskProfileScope(binding),
      deps.send,
    );
  }
  return {
    async inspect() {
      for (const value of await journal.history(profile.binding)) {
        const row = parseUrgentInboxOperation(value);
        if (row.request.kind !== 'register' || row.receipt) continue;
        const proof = await remote(row.binding).inspect(
          row.request.consentId,
          row.request.subscriptionId,
          row.id,
        );
        assertDraftAccount();
        if (proof.registration !== null) await journal.confirm(row, proof);
      }
    },
    async withdraw() {
      for (const row of await journal.pendingWithdrawals(
        account.accountHash,
        account.targetHash,
      )) {
        if (row.profileId !== profile.id) continue;
        const proof = await remote(row.binding).withdraw(
          row.request.consentId,
          row.id,
        );
        assertDraftAccount();
        await journal.confirm(row, proof);
      }
    },
  };
}
