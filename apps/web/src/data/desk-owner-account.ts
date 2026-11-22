import {
  parseCloudConnection,
  cloudConnectionTarget,
  type CloudConnection,
  type KeyStorage,
  readCloudConnection,
} from '@mise/core/cloud-connection';
import { operatorAccountHash } from '@mise/core/operators';
import { parseDeskBinding, type DeskBinding } from './desk-cache';
import {
  CommandRequestError,
  type CommandAccount,
  type CommandAuthorization,
} from './command-request';
import type { PhoneAuth } from './phone-auth';

/** Personal cleanup uses the actual original phone account, independently of
 * whether that account still has an active native outlet selection. */
export async function createDeskOwnerAccount(
  input: CloudConnection,
  scope: string,
  manager: PhoneAuth,
  value: DeskBinding,
  storage: KeyStorage,
  live: () => boolean,
): Promise<CommandAccount> {
  const config = parseCloudConnection(input),
    binding = parseDeskBinding(value),
    source = JSON.stringify(config);
  const check = () => {
    if (
      live() !== true ||
      JSON.stringify(readCloudConnection(storage)) !== source
    )
      throw new CommandRequestError('auth');
  };
  check();
  const original = await manager.commandAuthorization();
  check();
  const [accountHash, targetHash] = await Promise.all([
    operatorAccountHash(original.userId),
    cloudConnectionTarget(config, scope, original.userId),
  ]);
  if (
    manager.key !== binding.connection.authKey ||
    accountHash !== binding.connection.accountHash ||
    targetHash !== binding.connection.targetHash
  )
    throw new CommandRequestError('auth');
  const assertCurrent = (auth: CommandAuthorization) => {
    check();
    if (
      auth.userId !== original.userId ||
      auth.generation !== original.generation
    )
      throw new CommandRequestError('auth');
    manager.assertCommandAuthorization(auth);
  };
  assertCurrent(original);
  return {
    scope,
    accountHash,
    targetHash,
    getAuth: async () => {
      check();
      const current = await manager.commandAuthorization();
      assertCurrent(current);
      return current;
    },
    assertCurrent,
  };
}
