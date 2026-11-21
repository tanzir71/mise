import {
  deviceLabel,
  isDeviceId,
  parseDevicePairing,
  type DevicePairing,
  type DevicePairingApproval,
  type DeviceMode,
} from '@mise/core/device-access';
import type { CloudConnection } from '@mise/core/cloud-connection';
import { createDeviceAdminRemote } from './device-admin-remote';
import {
  assertCommandReceipt,
  CommandRequestError,
  type CommandAccount,
} from './command-request';

export type DeviceAdminAction =
  | {
      kind: 'start';
      id: string;
      eventId: string;
      name: string;
      mode: DeviceMode;
    }
  | {
      kind: 'approve';
      pairing: DevicePairing;
      claim: DevicePairingApproval;
      eventId: string;
    }
  | { kind: 'cancel' | 'revoke'; id: string; eventId: string };
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function parseAction(
  value: unknown,
  scope: { businessId: string; outletId: string },
): DeviceAdminAction {
  if (!object(value) || !isDeviceId(value.eventId))
    throw new CommandRequestError('review');
  if (
    value.kind === 'start' &&
    exact(value, 'kind,id,eventId,name,mode') &&
    isDeviceId(value.id) &&
    value.id !== value.eventId &&
    (value.mode === 'kitchen' || value.mode === 'counter')
  )
    return {
      kind: 'start',
      id: value.id,
      eventId: value.eventId,
      name: deviceLabel(value.name),
      mode: value.mode,
    };
  if (
    (value.kind === 'cancel' || value.kind === 'revoke') &&
    exact(value, 'kind,id,eventId') &&
    isDeviceId(value.id) &&
    value.id !== value.eventId
  )
    return { kind: value.kind, id: value.id, eventId: value.eventId };
  if (value.kind === 'approve' && exact(value, 'kind,pairing,claim,eventId')) {
    const pairing = parseDevicePairing(value.pairing),
      claim = value.claim;
    if (
      pairing.businessId !== scope.businessId ||
      pairing.outletId !== scope.outletId ||
      !object(claim) ||
      !exact(claim, 'id,verification,createdAt,approvedAt') ||
      !isDeviceId(claim.id) ||
      claim.id === pairing.id ||
      [claim.id, pairing.id].includes(value.eventId) ||
      typeof claim.verification !== 'string' ||
      !/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/.test(claim.verification) ||
      typeof claim.createdAt !== 'number' ||
      !Number.isSafeInteger(claim.createdAt) ||
      claim.createdAt < pairing.createdAt ||
      claim.createdAt >= pairing.expiresAt ||
      (claim.approvedAt !== null &&
        (typeof claim.approvedAt !== 'number' ||
          !Number.isSafeInteger(claim.approvedAt) ||
          claim.approvedAt < claim.createdAt ||
          claim.approvedAt >= pairing.expiresAt))
    )
      throw new CommandRequestError('review');
    return {
      kind: 'approve',
      pairing,
      claim: {
        id: claim.id,
        verification: claim.verification,
        createdAt: claim.createdAt,
        approvedAt: claim.approvedAt as number | null,
      },
      eventId: value.eventId,
    };
  }
  throw new CommandRequestError('review');
}
/** A small token-free retry record, separate from shop backup and phone Auth.
 * Web Locks serialize its read/write/send sequence across owner tabs. No PIN is
 * journaled, and no successful UI update relies on a local owner role alone. */
export function createDeviceAdminSession(
  config: CloudConnection,
  account: CommandAccount,
  input: { businessId: string; outletId: string; actorId: string },
  deps: {
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    assertScope: () => Promise<void>;
    locks?: Pick<LockManager, 'request'>;
    send?: typeof fetch;
  },
) {
  const scope = {
    businessId: input.businessId,
    outletId: input.outletId,
    actorId: input.actorId,
  };
  if (!Object.values(scope).every(isDeviceId))
    throw new CommandRequestError('review');
  const key = [
      'mise.device.admin.v1',
      account.targetHash,
      scope.businessId,
      scope.outletId,
      scope.actorId,
    ].join(':'),
    remote = createDeviceAdminRemote(config, account, scope, deps.send),
    storage = deps.storage;
  function pending(): DeviceAdminAction | null {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      throw new CommandRequestError('review');
    }
    if (!raw) return null;
    if (raw.length > 65536) throw new CommandRequestError('review');
    try {
      return parseAction(JSON.parse(raw), scope);
    } catch {
      throw new CommandRequestError('review');
    }
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const locks = deps.locks ?? globalThis.navigator?.locks;
    if (!locks) throw new CommandRequestError('review');
    return locks.request(
      key,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new CommandRequestError('retry');
        await deps.assertScope();
        return run();
      },
    );
  }
  async function checked<T extends object>(value: T) {
    assertCommandReceipt(value);
    await deps.assertScope();
    assertCommandReceipt(value);
    return value;
  }
  async function perform(
    input: DeviceAdminAction | null,
    signal?: AbortSignal,
  ) {
    const original = input === null ? null : parseAction(input, scope);
    return exclusive(async () => {
      const saved = pending(),
        source = original === null ? saved : original;
      if (
        !source ||
        (saved && JSON.stringify(saved) !== JSON.stringify(source))
      )
        throw new CommandRequestError('review');
      const serialized = JSON.stringify(source);
      try {
        if (!saved) {
          storage.setItem(key, serialized);
          if (JSON.stringify(pending()) !== serialized) throw Error();
        }
      } catch {
        throw new CommandRequestError('review');
      }
      // Original IDs are durable before asynchronous phone verification or HTTP.
      let result;
      if (source.kind === 'start') result = await remote.start(source, signal);
      else if (source.kind === 'approve')
        result = await remote.approve(
          source.pairing,
          source.claim,
          source.eventId,
          signal,
        );
      else if (source.kind === 'cancel')
        result = await remote.cancel(source.id, source.eventId, signal);
      else result = await remote.revoke(source.id, source.eventId, signal);
      await checked(result);
      if (JSON.stringify(pending()) !== serialized)
        throw new CommandRequestError('review');
      try {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw Error();
      } catch {
        throw new CommandRequestError('review');
      }
      return { kind: source.kind, result };
    });
  }
  return {
    pending,
    perform: (source: DeviceAdminAction, signal?: AbortSignal) =>
      perform(source, signal),
    retry: (signal?: AbortSignal) => perform(null, signal),
    async discard() {
      return exclusive(async () => {
        const original = pending();
        if (!original) return;
        if (JSON.stringify(pending()) !== JSON.stringify(original))
          throw new CommandRequestError('review');
        storage.removeItem(key);
        if (storage.getItem(key) !== null)
          throw new CommandRequestError('review');
      });
    },
    async page(...args: Parameters<typeof remote.page>) {
      return checked(await remote.page(...args));
    },
    async inspect(...args: Parameters<typeof remote.inspect>) {
      return checked(await remote.inspect(...args));
    },
    async pin(...args: Parameters<typeof remote.pin>) {
      return checked(await remote.pin(...args));
    },
  };
}
export type DeviceAdminSession = ReturnType<typeof createDeviceAdminSession>;
