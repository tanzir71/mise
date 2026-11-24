import { beforeAll, beforeEach, afterAll, afterEach, it, expect } from 'vitest';
import { paymentSourcesFixture } from './payment-sources-fixture';
import { deviceUid } from './device-pairing-fixture';
import {
  createPhoneAuth,
  type PhoneAuth,
} from '../apps/web/src/data/phone-auth';
import { createOwnerTaskAccount } from '../apps/web/src/data/owner-task-account';
import { createPaymentSourceSession } from '../apps/web/src/data/payment-source-session';
import {
  listPaymentSourceLocators,
  parsePaymentSourceLocator,
} from '../apps/web/src/data/payment-source-journal';
import {
  openPaymentSourceRecoveryAuth,
  openPaymentSourceRecovery,
  paymentSourceRecoveryAuthScope,
  readPaymentSourceRecoveryConnection,
  savePaymentSourceRecoveryConnection,
} from '../apps/web/src/data/payment-source-recovery';
import {
  cloudAuthStorageKey,
  cloudConnectionStorageKey,
} from '../packages/core/cloud-connection';
let f: Awaited<ReturnType<typeof paymentSourcesFixture>>;
beforeAll(async () => {
  f = await paymentSourcesFixture();
}, 30000);
beforeEach(async () => {
  await f.seed();
});
afterAll(async () => {
  await f?.db.close();
});
const clients: PhoneAuth[] = [],
  sessions: { stop: () => void }[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const c of clients.splice(0)) await c.dispose();
});
const config = {
    apiUrl: 'https://cloud.test',
    publishableKey: 'sb_publishable_test_only',
  },
  base = '/mise/app/';
class Storage {
  values = new Map<string, string>();
  reads: string[] = [];
  get length() {
    return this.values.size;
  }
  key(n: number) {
    return [...this.values.keys()][n] ?? null;
  }
  getItem(key: string) {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function envelope(n = 1) {
  const b = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url'),
    user = {
      id: deviceUid(n),
      aud: 'authenticated',
      role: 'authenticated',
      phone: '1415555010' + n,
      phone_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      app_metadata: { provider: 'phone' },
      user_metadata: {},
      is_anonymous: false,
    },
    access = [
      b({ alg: 'HS256', typ: 'JWT' }),
      b({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
      'synthetic-recovery-signature',
    ].join('.');
  return {
    access_token: access,
    refresh_token: 'synthetic-recovery-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user,
  };
}
function wire() {
  let offline = false;
  const calls: { path: string; operation?: string }[] = [];
  const send: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.split('/').at(-1)!;
    calls.push({ path });
    if (offline) return Response.json({}, { status: 503 });
    if (path === 'user') {
      const jwt = new Headers(init?.headers).get('Authorization')!.slice(7),
        n = Number(
          JSON.parse(
            Buffer.from(jwt.split('.')[1], 'base64url').toString(),
          ).sub.slice(-1),
        );
      return Response.json(envelope(n).user);
    }
    if (path === 'settings')
      return Response.json({
        external: { phone: true },
        phone_autoconfirm: false,
      });
    if (path === 'otp') return Response.json({ message_id: 'synthetic' });
    if (path === 'verify') return Response.json(envelope());
    if (path === 'token') return Response.json(envelope());
    if (path === 'logout') return Response.json({});
    if (path === 'act_payment_source') {
      const body = JSON.parse(String(init?.body));
      calls.at(-1)!.operation = body.p_operation;
      try {
        return Response.json(
          await f.callRaw(JSON.parse(body.p_intent_json), body.p_operation),
        );
      } catch {
        return Response.json({}, { status: 403 });
      }
    }
    throw Error('Unexpected recovery request ' + path);
  };
  return {
    send,
    calls,
    set offline(v: boolean) {
      offline = v;
    },
  };
}
const locks = {
  request: async (
    _name: string,
    _options: unknown,
    run: (lock: Lock) => Promise<unknown>,
  ) => run({ name: 'original', mode: 'exclusive' }),
} as Pick<LockManager, 'request'>;
async function boot(discovery = false) {
  const storage = new Storage(),
    w = wire(),
    scope = discovery ? base + 'join' : base + f.scope().businessId;
  storage.setItem(
    await cloudAuthStorageKey(config, scope),
    JSON.stringify(envelope()),
  );
  const manager = await createPhoneAuth(config, scope, {
    storage,
    send: w.send,
  });
  clients.push(manager);
  await manager.check();
  const bridge = await createOwnerTaskAccount(
      config,
      scope,
      manager,
      null,
      () => {},
    ),
    s = createPaymentSourceSession(config, bridge.account, f.scope(), {
      storage,
      send: w.send,
      locks,
      assertScope: async () => {},
      assertDraftAccount: bridge.assertDraftAccount,
    });
  sessions.push(s);
  return { storage, w, manager, s };
}
const draft = {
  amount: 10000,
  currency: 'BDT',
  method: 'cash' as const,
  methodName: 'Cash',
  reference: 'Original reference',
  source: 'Complete literal source বাংলা\u0000 ' + String.fromCharCode(0xd800),
  receivedAt: Date.now() - 1000,
};
it('opens either original namespace offline, journals closure, and later closes the same ID after outlet membership is removed', async () => {
  for (const discovery of [false, true]) {
    const b = await boot(discovery),
      intent = await b.s.prepareCapture(draft);
    b.s.stop();
    await b.manager.dispose();
    await f.db.query('update public.members set active=false where id=$1', [
      f.scope().memberId,
    ]);
    b.w.offline = true;
    const opened = await openPaymentSourceRecoveryAuth(config, base, b.s.key, {
      storage: b.storage,
      send: b.w.send,
    });
    clients.push(opened.manager);
    expect(opened.borrowed).toBe(true);
    await opened.manager.check();
    const recovery = await openPaymentSourceRecovery(
      config,
      base,
      b.s.key,
      opened.manager,
      { storage: b.storage, send: b.w.send, locks, assertLocal: () => {} },
    );
    expect(recovery).not.toBeNull();
    sessions.push(recovery!);
    expect(recovery!.saved().actions[0].intent).toEqual(intent);
    for (const forbidden of [
      'read',
      'call',
      'prepare',
      'prepareCapture',
      'candidates',
      'match',
    ])
      expect(forbidden in recovery!).toBe(false);
    await expect(recovery!.close(intent.id)).rejects.toMatchObject({
      kind: 'retry',
    });
    expect(recovery!.saved().actions[0].closeRequested).toBe(true);
    b.w.offline = false;
    expect((await recovery!.close(intent.id)).state).toBe('closed');
    expect(
      b.w.calls
        .filter((c) => c.path === 'act_payment_source')
        .map((c) => c.operation),
    ).toEqual(['close']);
    expect(b.w.calls.some((c) => c.path === 'otp')).toBe(false);
    await f.seed();
  }
});
it('uses isolated actual SDK OTP recovery without altering another signed-in native account or its selection', async () => {
  const b = await boot(),
    intent = await b.s.prepareCapture(draft),
    mainKey = b.manager.key;
  b.s.stop();
  await b.manager.dispose();
  b.storage.setItem(mainKey, JSON.stringify(envelope(2)));
  const nativeBefore = b.storage.getItem(mainKey);
  b.storage.setItem('native-selection', 'second-user-and-outlet');
  const opened = await openPaymentSourceRecoveryAuth(config, base, b.s.key, {
    storage: b.storage,
    send: b.w.send,
  });
  clients.push(opened.manager);
  expect(opened.borrowed).toBe(false);
  expect(opened.manager.key).toBe(
    await cloudAuthStorageKey(config, paymentSourceRecoveryAuthScope(base)),
  );
  await opened.manager.check();
  await opened.manager.sendCode('+14155550101');
  await opened.manager.verifyCode('123456');
  const recovery = await openPaymentSourceRecovery(
    config,
    base,
    b.s.key,
    opened.manager,
    { storage: b.storage, send: b.w.send, locks, assertLocal: () => {} },
  );
  sessions.push(recovery!);
  expect((await recovery!.close(intent.id)).state).toBe('closed');
  await opened.manager.dispose();
  expect(b.storage.getItem(mainKey)).toBe(nativeBefore);
  expect(b.storage.getItem('native-selection')).toBe('second-user-and-outlet');
  expect(b.w.calls.some((c) => c.path === 'logout')).toBe(false);
});
it('wrong account, project, key, deployment base or unrelated SDK namespace cannot read an original source', async () => {
  const b = await boot();
  await b.s.prepareCapture(draft);
  const otherScope = base + 'unrelated',
    other = await createPhoneAuth(config, otherScope, {
      storage: b.storage,
      send: b.w.send,
    });
  clients.push(other);
  b.storage.setItem(other.key, JSON.stringify(envelope()));
  for (const [connection, at, manager] of [
    [{ ...config, apiUrl: 'https://other.test' }, base, b.manager],
    [{ ...config, publishableKey: 'sb_publishable_other' }, base, b.manager],
    [config, '/app/', b.manager],
    [config, base, other],
  ] as const) {
    b.storage.reads = [];
    await expect(
      openPaymentSourceRecovery(connection, at, b.s.key, manager, {
        storage: b.storage,
        locks,
        send: b.w.send,
        assertLocal: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(b.storage.reads).not.toContain(b.s.key);
  }
  b.storage.setItem(b.manager.key, JSON.stringify(envelope(2)));
  b.storage.reads = [];
  await expect(
    openPaymentSourceRecovery(config, base, b.s.key, b.manager, {
      storage: b.storage,
      locks,
      assertLocal: () => {},
    }),
  ).rejects.toBeDefined();
  expect(b.storage.reads).not.toContain(b.s.key);
});
it('a changed recovery connection or forgotten identity revokes archive/file authority without discarding originals', async () => {
  const b = await boot();
  await b.s.call((await b.s.prepareCapture(draft)).id, 'submit');
  let current = true;
  const r = await openPaymentSourceRecovery(config, base, b.s.key, b.manager, {
    storage: b.storage,
    send: b.w.send,
    locks,
    assertLocal: () => {
      if (!current) throw Error('connection changed');
    },
  });
  sessions.push(r!);
  const copy = await r!.copy(),
    before = b.storage.getItem(b.s.key);
  current = false;
  expect(() => r!.assertFile(copy)).toThrow('changed');
  await expect(r!.close(r!.key)).rejects.toBeDefined();
  expect(b.storage.getItem(b.s.key)).toBe(before);
  current = true;
  await b.manager.close();
  expect(() => r!.saved()).toThrow('closed');
  expect(b.storage.getItem(b.s.key)).toBe(before);
});
it('enumerates only stable metadata keys, retains malformed groups and blocks concurrent/duplicate enumeration', async () => {
  const b = await boot();
  await b.s.prepareCapture(draft);
  b.storage.setItem('mise.payment-sources.v1:broken', 'do not discard');
  b.storage.reads = [];
  const listed = listPaymentSourceLocators(b.storage);
  expect(listed).toEqual({
    groups: [parsePaymentSourceLocator(b.s.key)],
    unreadable: 1,
  });
  expect(b.storage.reads).toEqual([]);
  let n = 0;
  expect(() =>
    listPaymentSourceLocators({
      length: 1,
      key: () => (++n === 1 ? b.s.key : 'changed'),
    }),
  ).toThrow();
  expect(() =>
    listPaymentSourceLocators({ length: 2, key: () => b.s.key }),
  ).toThrow();
  expect(b.storage.values.get('mise.payment-sources.v1:broken')).toBe(
    'do not discard',
  );
});
it('separate recovery configuration is private device state and preserves the selected operator connection', () => {
  const storage = new Storage();
  storage.setItem(cloudConnectionStorageKey, JSON.stringify(config));
  expect(readPaymentSourceRecoveryConnection(storage)).toEqual(config);
  const other = { ...config, apiUrl: 'https://original.test' };
  savePaymentSourceRecoveryConnection(storage, other);
  expect(readPaymentSourceRecoveryConnection(storage)).toEqual(other);
  expect(storage.getItem(cloudConnectionStorageKey)).toBe(
    JSON.stringify(config),
  );
});
