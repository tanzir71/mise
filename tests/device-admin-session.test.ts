import { expect, it, vi } from 'vitest';
import {
  createDeviceAdminSession,
  type DeviceAdminAction,
} from '../apps/web/src/data/device-admin-session';
import { testCommandAccount } from './command-account-fixture';
import { pairingLifetime } from '../packages/core/device-access';
const id = (n: number) => String(n).padStart(26, '0'),
  config = {
    apiUrl: 'https://screen.test',
    publishableKey: 'sb_publishable_test_only',
  },
  scope = { businessId: id(1), outletId: id(2), actorId: id(3) },
  pairing = {
    v: 1,
    id: id(10),
    businessId: id(1),
    outletId: id(2),
    name: 'Kitchen',
    mode: 'kitchen',
    code: '123456',
    createdAt: 1000,
    expiresAt: 1000 + pairingLifetime,
    closedAt: null,
    deviceId: null,
  };
function boot() {
  const rows = new Map<string, string>(),
    storage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        rows.set(key, value);
      },
      removeItem: (key: string) => {
        rows.delete(key);
      },
    },
    assertScope = vi.fn(async () => {}),
    send = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(pairing)),
    ),
    account = testCommandAccount(
      config,
      async () => 'owner.original.signature',
    );
  let held = false;
  const locks = {
    request: async (
      _name: string,
      _options: unknown,
      callback: (lock: unknown) => Promise<unknown>,
    ) => {
      if (held) return callback(null);
      held = true;
      try {
        return await callback({ name: 'fixture', mode: 'exclusive' });
      } finally {
        held = false;
      }
    },
  } as unknown as Pick<LockManager, 'request'>;
  const session = createDeviceAdminSession(config, account, scope, {
    storage,
    assertScope,
    locks,
    send,
  });
  return { rows, storage, assertScope, send, session };
}
const source = (): DeviceAdminAction => ({
  kind: 'start',
  id: id(10),
  eventId: id(11),
  name: 'Kitchen',
  mode: 'kitchen',
});
it('persists original owner action IDs before Auth/HTTP and only removes them after a guarded reply', async () => {
  const f = boot();
  f.send.mockImplementation(async () => {
    expect(f.session.pending()).toEqual(source());
    return new Response(JSON.stringify(pairing));
  });
  expect((await f.session.perform(source())).kind).toBe('start');
  expect(f.rows.size).toBe(0);
  expect(f.assertScope).toHaveBeenCalledTimes(2);
});
it('a lost successful response retains an exact retry across a new session instance', async () => {
  const f = boot();
  f.send.mockImplementationOnce(async () => {
    throw Error('Lost reply');
  });
  await expect(f.session.perform(source())).rejects.toMatchObject({
    kind: 'retry',
  });
  expect(f.session.pending()).toEqual(source());
  await f.session.retry();
  expect(f.rows.size).toBe(0);
  expect(f.send.mock.calls.map(([, options]) => options?.body)).toEqual([
    f.send.mock.calls[0][1]?.body,
    f.send.mock.calls[0][1]?.body,
  ]);
});
it('a full/unwritable private journal blocks HTTP rather than losing the retry source', async () => {
  const f = boot();
  vi.spyOn(f.storage, 'setItem').mockImplementation(() => {
    throw Error('PRIVATE quota');
  });
  await expect(f.session.perform(source())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.rows.size).toBe(0);
});
it('async scope verification cannot mutate an already chosen action', async () => {
  const f = boot(),
    value = source();
  f.assertScope.mockImplementation(async () => {
    if (value.kind === 'start') value.name = 'Changed';
  });
  await f.session.perform(value);
  expect(JSON.parse(f.send.mock.calls[0][1]?.body as string).p_name).toBe(
    'Kitchen',
  );
});
it('changed outlet/account context after a real reply cannot clear the original retry', async () => {
  const f = boot();
  f.assertScope
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      throw Error('Context changed');
    });
  await expect(f.session.perform(source())).rejects.toThrow('Context changed');
  expect(f.session.pending()).toEqual(source());
});
it('a different pending action or hidden PIN field cannot replace the original retry', async () => {
  const f = boot();
  f.send.mockImplementation(async () => {
    throw Error('Lost');
  });
  await expect(f.session.perform(source())).rejects.toThrow();
  await expect(
    f.session.perform({ ...source(), id: id(12) } as DeviceAdminAction),
  ).rejects.toMatchObject({ kind: 'review' });
  await expect(
    f.session.perform({
      ...source(),
      pin: '0042',
    } as unknown as DeviceAdminAction),
  ).rejects.toMatchObject({ kind: 'review' });
  expect(f.session.pending()).toEqual(source());
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('staff PIN changes never enter the owner retry journal, including an unconfirmed response', async () => {
  const f = boot();
  f.send.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ memberId: id(20), revision: id(21), changedAt: 1000 }),
      ),
  );
  await f.session.pin(id(20), 'set', '0042');
  expect(f.rows.size).toBe(0);
  expect(JSON.parse(f.send.mock.calls[0][1]?.body as string).pin).toBe('0042');
  f.send.mockImplementation(async () => {
    throw Error('Lost PIN response');
  });
  await expect(f.session.pin(id(20), 'set', '0042')).rejects.toThrow();
  expect(f.rows.size).toBe(0);
});
