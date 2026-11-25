import Dexie from 'dexie';
import {
  cloudAuthStorageKey,
  cloudConnectionStorageKey,
  cloudConnectionTarget,
  parseCloudConnection,
  readCloudConnection,
  type CloudConnection,
  type KeyStorage,
} from '@mise/core/cloud-connection';
import { operatorAccountHash, operatorId } from '@mise/core/operators';
import { literalToken } from '@mise/core/literal-token';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import type { OriginalCopyScope } from '@mise/core/original-copy';
import type { MiseDatabase } from './db';
import type { PhoneAuth } from './phone-auth';
import {
  CommandRequestError,
  createOriginalCopyRequest,
  type CommandAccount,
} from './command-request';
import {
  OriginalCopyJournal,
  type OriginalCopyIdentity,
  type OriginalCopyMutation,
  type OriginalCopyRemote,
} from './original-copies';
import { captureBindingToken } from './inbox';
import { readDatabasePortableBackup } from './payment-original-retention';

interface Options {
  config: CloudConnection;
  authScope: string;
  auth: PhoneAuth;
  storage: KeyStorage;
  journal: OriginalCopyJournal;
  send?: typeof fetch;
}
const bad = () => new CommandRequestError('auth');
function parseScope(value: OriginalCopyScope): OriginalCopyScope {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== 'actorId,businessId,outletId' ||
    ![value.actorId, value.businessId, value.outletId].every(operatorId)
  )
    throw bad();
  return Object.freeze({ ...value });
}
/** Uses the real phone SDK manager. Callers cannot inject a separately labelled
 * target, account hash, JWT supplier or copy remote into this controller. */
async function binding(options: Options, value: OriginalCopyScope) {
  const config = parseCloudConnection(options.config),
    scope = parseScope(value),
    { auth, storage, authScope, journal } = options,
    account = auth.journalIdentity(),
    controller = new AbortController();
  let active = true,
    busy = false,
    responseGuard: (() => void) | undefined;
  function stop() {
    active = false;
    controller.abort();
    if (typeof window !== 'undefined')
      window.removeEventListener('storage', changed);
  }
  function draft() {
    try {
      if (
        !active ||
        literalToken(readCloudConnection(storage)) !== literalToken(config)
      )
        throw bad();
      auth.assertJournalIdentity(account);
    } catch {
      stop();
      throw bad();
    }
  }
  function current() {
    draft();
    try {
      responseGuard?.();
    } catch {
      stop();
      throw bad();
    }
  }
  function changed(event: StorageEvent) {
    if (
      (event.key === null || event.key === cloudConnectionStorageKey) &&
      event.oldValue !== event.newValue
    )
      stop();
  }
  current();
  if (!authScope || authScope.length > 2048) throw bad();
  const [key, accountHash, targetHash] = await Promise.all([
    cloudAuthStorageKey(config, authScope),
    operatorAccountHash(account.userId),
    cloudConnectionTarget(config, authScope, account.userId),
  ]);
  current();
  if (key !== auth.key) throw bad();
  const identity: OriginalCopyIdentity = Object.freeze({
    ...scope,
    accountHash,
    targetHash,
  });
  const commandAccount: CommandAccount = {
    scope: authScope,
    accountHash,
    targetHash,
    async getAuth() {
      draft();
      const value = await auth.commandAuthorization();
      draft();
      if (value.userId !== account.userId) throw bad();
      return value;
    },
    assertCurrent(value) {
      draft();
      if (value.userId !== account.userId) throw bad();
      auth.assertCommandAuthorization(value);
    },
  };
  const request = createOriginalCopyRequest(
    config,
    commandAccount,
    options.send ?? fetch,
  );
  const remote: OriginalCopyRemote = {
    scope,
    async call(op, id, body) {
      current();
      const result = await request(
        JSON.stringify(body),
        {
          'Content-Type': 'application/json',
          'X-Mise-Original-Action': op,
          'X-Mise-Original-Id': id,
          'X-Mise-Original-Outlet': scope.outletId,
        },
        20000,
        controller.signal,
      );
      result.guard();
      responseGuard = result.guard;
      current();
      return result.value;
    },
  };
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    current();
    if (busy) throw new CommandRequestError('retry');
    busy = true;
    try {
      const result = await run();
      current();
      return result;
    } finally {
      busy = false;
    }
  }
  if (typeof window !== 'undefined')
    window.addEventListener('storage', changed);
  return { identity, current, remote, exclusive, stop, journal };
}

/** Historical reads need the same actual account and known original scope.
 * They grant no current outlet role and never install current shop records. */
export async function createOriginalCopyOwnerSession(
  options: Options,
  scope: OriginalCopyScope,
) {
  const b = await binding(options, scope);
  return {
    identity: b.identity,
    readback: (id: string) =>
      b.exclusive(() =>
        b.journal.readback(id, b.identity, b.remote, b.current),
      ),
    recover: (id: string) =>
      b.exclusive(() => b.journal.recover(id, b.identity, b.remote, b.current)),
    stop: b.stop,
  };
}
function identityTables(db: MiseDatabase) {
  return [
    db.businesses,
    db.outlets,
    db.members,
    db.operatorState,
    db.cloudState,
  ];
}
async function nativeIdentity(db: MiseDatabase) {
  const [setup, selection, raw] = await Promise.all([
    db.setup(),
    db.operatorState.get('active'),
    db.cloudState.get('binding'),
  ]);
  if (!setup) throw bad();
  const cloud = raw ? parseLocalCloudState(raw) : null;
  return {
    setup,
    selection: selection ?? null,
    token: literalToken({
      setup,
      selection: selection ?? null,
      binding: raw ? captureBindingToken(raw) : null,
      phase: cloud?.phase ?? null,
    }),
  };
}
/** Transfer the actual selected shop's complete retained originals. Ordinary
 * payments, canonical writes and financial permissions are never changed here. */
export async function createNativeOriginalCopySession(
  db: MiseDatabase,
  options: Options,
) {
  const original = await db.transaction('r', identityTables(db), () =>
    nativeIdentity(db),
  );
  const { setup } = original,
    b = await binding(options, {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    });
  const connection = original.selection?.connection;
  if (
    connection &&
    (connection.authKey !== options.auth.key ||
      connection.accountHash !== b.identity.accountHash ||
      connection.targetHash !== b.identity.targetHash)
  ) {
    b.stop();
    throw bad();
  }
  async function checkNative() {
    b.current();
    try {
      if ((await nativeIdentity(db)).token !== original.token) throw bad();
      b.current();
    } catch {
      b.stop();
      throw bad();
    }
  }
  async function check() {
    return db.transaction('r', identityTables(db), checkNative);
  }
  // Read locks cover only local persistence. Network calls hold no native lock.
  const mutate: OriginalCopyMutation = (run) =>
    db.transaction('r', identityTables(db), async () => {
      await checkNative();
      return Dexie.waitFor(
        Dexie.ignoreTransaction(async () => {
          b.current();
          const value = await run();
          b.current();
          return value;
        }),
      );
    });
  const remote: OriginalCopyRemote = {
    scope: b.remote.scope,
    async call(op, id, body) {
      await check();
      const value = await b.remote.call(op, id, body);
      await check();
      return value;
    },
  };
  try {
    await check();
  } catch (error) {
    b.stop();
    throw error;
  }
  const run = <T>(action: () => Promise<T>) =>
    b.exclusive(async () => {
      await check();
      const result = await action();
      await check();
      return result;
    });
  return {
    identity: b.identity,
    assertCurrent: check,
    prepare: (id: string) =>
      run(async () => {
        const existing = await b.journal.prepared(id, b.identity, b.current);
        if (existing) return existing;
        return db.transaction('r', db.tables, async () => {
          await checkNative();
          const { portable } = await readDatabasePortableBackup(db);
          await checkNative();
          return Dexie.waitFor(
            Dexie.ignoreTransaction(() =>
              b.journal.prepare(portable, b.identity, id, b.current, mutate),
            ),
          );
        });
      }),
    deliver: (id: string) =>
      run(() => b.journal.deliver(id, b.identity, remote, b.current, mutate)),
    readback: (id: string) =>
      run(() => b.journal.readback(id, b.identity, remote, b.current, mutate)),
    stop: b.stop,
  };
}
export type NativeOriginalCopySession = Awaited<
  ReturnType<typeof createNativeOriginalCopySession>
>;
