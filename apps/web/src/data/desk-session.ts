import { newKitchenId } from '@mise/core/kitchen';
import {
  parseDeskAlarmSettings,
  type DeskAlarmSettings,
} from '@mise/core/desk-tasks';
import {
  deskProfileScope,
  type DeskBinding,
  type DeskCache,
  type DeskSnapshot,
} from './desk-cache';
import {
  deskRegistrationFingerprint,
  deskRegistrationPayload,
  type DeskOperation,
} from './desk-operation';
import type { DeskNativeScope } from './desk-native';
import { CommandRequestError, type CommandAccount } from './command-request';
import { createDeskRemote, type DeskRemote } from './desk-remote';
import {
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';

export interface DeskBrowserSource {
  applicationKey: string;
  subscription: unknown;
}
export type DeskEnableSource = (
  save: (source: DeskBrowserSource) => Promise<DeskOperation>,
  authorize: () => Promise<void>,
) => Promise<DeskOperation>;
export interface DeskSessionOptions {
  cache: DeskCache;
  native: DeskNativeScope;
  account: CommandAccount;
  config: CloudConnection;
  check: () => void;
  subscription: () => Promise<DeskBrowserSource | null>;
  send?: typeof fetch;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function createDeskSession(options: DeskSessionOptions) {
  const { cache, native, account } = options,
    binding = native.binding,
    config = parseCloudConnection(options.config);
  let refreshing: Promise<DeskSnapshot> | null = null,
    draining: Promise<void> | null = null,
    again = false;
  function check() {
    const result: unknown = options.check();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw new CommandRequestError('auth');
    }
  }
  function remoteFor(source: DeskBinding): DeskRemote {
    check();
    if (
      source.connection.accountHash !== account.accountHash ||
      source.connection.targetHash !== account.targetHash
    )
      throw new CommandRequestError('auth');
    return createDeskRemote(
      config,
      account,
      deskProfileScope(source),
      options.send,
    );
  }
  const remote = remoteFor(binding);
  async function current() {
    check();
    const saved = await cache.read(binding);
    if (!saved) throw new CommandRequestError('review');
    return saved;
  }
  async function enableSource(expected: DeskSnapshot) {
    await native.assert();
    const saved = await current();
    if (
      !equal(saved.pointer, expected.pointer) ||
      !equal(saved.profile.binding, expected.profile.binding) ||
      saved.profile.choiceRevision !== expected.profile.choiceRevision
    )
      throw new CommandRequestError('review');
  }
  async function refresh(): Promise<DeskSnapshot> {
    await native.assert();
    const list = await remote.tasks();
    await native.assert();
    return native.commit(async (guard) => {
      check();
      const saved = await cache.read(binding);
      return saved
        ? cache.replaceTasks(saved, list, guard)
        : cache.activate(await cache.pointer(), binding, list, guard);
    });
  }
  async function withdraw() {
    const rows = await cache.pendingWithdrawals(
      account.accountHash,
      account.targetHash,
    );
    for (const row of rows) {
      check();
      if (row.request.kind !== 'revoke')
        throw new CommandRequestError('review');
      const proof = await remoteFor(row.binding).revoke(
        row.request.subscriptionId,
        row.id,
      );
      check();
      await cache.confirmOperation(row, proof, check);
    }
  }
  async function deliver() {
    // A failed withdrawal stops this pass before any new registration is sent.
    await withdraw();
    const rows = await cache.pendingOperations(binding);
    let unconfirmed: unknown;
    for (const row of rows) {
      check();
      if (row.request.kind === 'revoke') continue;
      if (!equal(row.binding, binding)) continue;
      await native.assert();
      const saved = await current();
      if (row.request.kind === 'register') {
        if (row.selectionRevision !== saved.pointer.revision) continue;
        const source = await options.subscription();
        check();
        if (!source) throw new CommandRequestError('review');
        const payload = await deskRegistrationPayload(row, source);
        await native.assert();
        // A fresh context check rejects removed/changed assignment before sending.
        await remote.configuration();
        await native.assert();
        const stillPending = (await cache.pendingOperations(binding)).some(
          (value) => value.id === row.id,
        );
        if (!stillPending) continue;
        const proof = await remote.register(payload);
        await native.assert();
        await native.commit((guard) =>
          cache.confirmOperation(row, proof, guard),
        );
      } else {
        // A stale outlet-warning revision needs its own review. Retain that exact
        // action while allowing an independent browser registration to proceed.
        // Authentication or native-selection changes still stop the entire pass.
        try {
          const proof = await remote.setSettings({
            ...row.request,
            eventId: row.id,
          });
          await native.assert();
          await native.commit((guard) =>
            cache.confirmOperation(row, proof, guard),
          );
        } catch (problem) {
          check();
          await native.assert();
          unconfirmed ??= problem;
        }
      }
    }
    if (unconfirmed) throw unconfirmed;
  }
  return {
    binding,
    refresh() {
      if (!refreshing)
        refreshing = refresh().finally(() => {
          refreshing = null;
        });
      return refreshing;
    },
    async configuration() {
      await native.assert();
      const result = await remote.configuration();
      await native.assert();
      return result;
    },
    drain() {
      if (draining) {
        again = true;
        return draining;
      }
      draining = (async () => {
        do {
          again = false;
          await deliver();
        } while (again);
      })().finally(() => {
        draining = null;
      });
      return draining;
    },
    async cleanup() {
      await withdraw();
    },
    /** The caller starts the browser permission promise synchronously in its
     * explicit click handler and passes the captured private profile snapshot. */
    async enable(
      expected: DeskSnapshot,
      source: Promise<DeskBrowserSource> | DeskEnableSource,
    ): Promise<DeskOperation> {
      const eventId = newKitchenId(),
        subscriptionId = newKitchenId(),
        original = structuredClone(expected);
      const save = async (value: DeskBrowserSource) => {
        await enableSource(original);
        const fingerprint = await deskRegistrationFingerprint(value);
        await enableSource(original);
        return native.commit((guard) =>
          cache.queueRegistration(
            original,
            {
              eventId,
              request: { kind: 'register', subscriptionId, ...fingerprint },
            },
            guard,
          ),
        );
      };
      // A browser port can keep its origin-wide lock through subscription creation
      // AND the journal commit, so an older tab cannot replace a newer choice.
      if (typeof source === 'function')
        return source(save, () => enableSource(original));
      // Attach a rejection handler before a native scope check can fail.
      const pending = source.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await native.assert();
      const result = await pending;
      if ('error' in result) throw result.error;
      return save(result.value);
    },
    async disable() {
      const saved = await current();
      return native.commit((guard) => cache.disable(saved, guard));
    },
    async settings(value: DeskAlarmSettings) {
      const input = {
        ...parseDeskAlarmSettings(value),
        eventId: newKitchenId(),
      };
      await native.assert();
      const saved = await current();
      return native.commit((guard) =>
        cache.queueOperation(
          saved,
          {
            eventId: input.eventId,
            request: {
              kind: 'settings',
              enabled: input.enabled,
              minutes: input.minutes,
              revision: input.revision,
            },
          },
          guard,
        ),
      );
    },
  };
}
export type DeskSession = ReturnType<typeof createDeskSession>;
