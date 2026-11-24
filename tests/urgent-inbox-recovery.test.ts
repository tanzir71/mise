import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import {
  createPhoneAuth,
  type PhoneAuth,
} from '../apps/web/src/data/phone-auth';
import { createOwnerTaskAccount } from '../apps/web/src/data/owner-task-account';
import { createDeskNativeScope } from '../apps/web/src/data/desk-native';
import { createDeskSession } from '../apps/web/src/data/desk-session';
import { createUrgentInboxSession } from '../apps/web/src/data/urgent-inbox-session';
import { createUrgentInboxRemote } from '../apps/web/src/data/urgent-inbox-remote';
import {
  openUrgentRecoveryAuth,
  openUrgentRecovery,
  urgentRecoveryAuthScope,
  readUrgentRecoveryConnection,
  saveUrgentRecoveryConnection,
} from '../apps/web/src/data/urgent-inbox-recovery';
import {
  cloudAuthStorageKey,
  saveCloudConnection,
  cloudConnectionStorageKey,
} from '../packages/core/cloud-connection';
import {
  urgentNativeFixture,
  urgentOpened,
  urgentConfig as config,
} from './urgent-inbox-native-fixture';
const clients: PhoneAuth[] = [],
  base = '/mise/app/';
class Storage {
  values = new Map<string, string>();
  getItem(key: string) {
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
  const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url'),
    user = {
      id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
      phone: '1415555010' + n,
      aud: 'authenticated',
      role: 'authenticated',
      phone_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      app_metadata: { provider: 'phone' },
      user_metadata: {},
      is_anonymous: false,
    };
  return {
    access_token: [
      encode({ alg: 'HS256', typ: 'JWT' }),
      encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
      'synthetic-urgent-recovery-signature',
    ].join('.'),
    refresh_token: 'synthetic-urgent-recovery-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user,
  };
}
afterEach(async () => {
  for (const manager of clients.splice(0)) await manager.dispose();
  for (const db of urgentOpened.splice(0)) db.close();
});
async function boot() {
  const f = await urgentNativeFixture(),
    storage = new Storage(),
    scope = base + f.binding.businessId,
    key = await cloudAuthStorageKey(config, scope),
    calls: string[] = [];
  saveCloudConnection(storage, config);
  storage.setItem(key, JSON.stringify(envelope()));
  const send: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.split('/').at(-1)!;
    calls.push(path);
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
    if (path === 'verify' || path === 'token') return Response.json(envelope());
    if (path === 'logout') return Response.json({});
    return f.send(url, init);
  };
  const manager = await createPhoneAuth(config, scope, { storage, send });
  clients.push(manager);
  await manager.check();
  const bridge = await createOwnerTaskAccount(
      config,
      scope,
      manager,
      null,
      () => {},
    ),
    binding = {
      ...f.binding,
      connection: {
        ...f.binding.connection,
        authKey: key,
        accountHash: bridge.account.accountHash,
        targetHash: bridge.account.targetHash,
      },
    };
  await f.db.operatorState.put(binding);
  const options = {
      ...f.options,
      account: bridge.account,
      native: createDeskNativeScope(f.db, binding, () => {}),
      send,
    },
    desk = createDeskSession(options),
    urgent = createUrgentInboxSession(options);
  await desk.refresh();
  await desk.enable((await f.cache.read(binding))!, Promise.resolve(f.browser));
  await desk.drain();
  const original = await urgent.enable((await urgent.journal.read(binding))!),
    remote = createUrgentInboxRemote(config, bridge.account, f.scope, send);
  await remote.register(
    original.request.consentId,
    original.request.subscriptionId,
    original.id,
  );
  return {
    ...f,
    storage,
    scope,
    key,
    calls,
    send,
    manager,
    binding,
    urgent,
    original,
  };
}
it('uses the original actual SDK account for inspect and withdrawal after assignment loss without restoring native selection', async () => {
  const f = await boot();
  await f.urgent.disable();
  f.setAssigned(false);
  f.setReady(false);
  const saved = (await f.urgent.journal.read(f.urgent.binding))!.profile!;
  const before = await f.db.operatorState.get('active'),
    opened = await openUrgentRecoveryAuth(config, base, saved, {
      storage: f.storage,
      send: f.send,
    });
  clients.push(opened.manager);
  expect(opened.borrowed).toBe(true);
  const recovery = await openUrgentRecovery(
    config,
    base,
    saved,
    opened.manager,
    f.cache,
    { storage: f.storage, send: f.send, check: () => {} },
  );
  for (const method of ['target', 'register', 'enable', 'read', 'prepare'])
    expect(method in recovery).toBe(false);
  await recovery.inspect();
  await recovery.withdraw();
  expect(await f.db.operatorState.get('active')).toEqual(before);
  expect(f.closures.has(f.original.request.consentId)).toBe(true);
  expect(
    (await f.urgent.journal.read(f.urgent.binding))?.profile?.enabled,
  ).toBe(false);
  expect(f.calls).not.toContain('otp');
});
it('signs in independently when another phone owns the original namespace and preserves its actual SDK session', async () => {
  const f = await boot(),
    profile = (await f.urgent.journal.read(f.urgent.binding))!.profile!;
  await f.urgent.journal.withdrawProfile(profile, () => {});
  await f.manager.dispose();
  f.storage.setItem(f.key, JSON.stringify(envelope(2)));
  const other = await createPhoneAuth(config, f.scope, {
    storage: f.storage,
    send: f.send,
  });
  clients.push(other);
  await other.check();
  const before = f.storage.getItem(f.key),
    native = await f.db.operatorState.get('active');
  const opened = await openUrgentRecoveryAuth(config, base, profile, {
    storage: f.storage,
    send: f.send,
  });
  clients.push(opened.manager);
  expect(opened.borrowed).toBe(false);
  expect(opened.manager.key).toBe(
    await cloudAuthStorageKey(config, urgentRecoveryAuthScope(base)),
  );
  await opened.manager.sendCode('+14155550101');
  await opened.manager.verifyCode('123456');
  const recovery = await openUrgentRecovery(
    config,
    base,
    profile,
    opened.manager,
    f.cache,
    { storage: f.storage, send: f.send, check: () => {} },
  );
  await recovery.withdraw();
  expect(f.storage.getItem(f.key)).toBe(before);
  expect(other.journalIdentity().userId).toBe(envelope(2).user.id);
  expect(await f.db.operatorState.get('active')).toEqual(native);
  expect(f.closures.has(f.original.request.consentId)).toBe(true);
});
it('keeps a recovery connection private and separate from the installation currently selected in the app', () => {
  const storage = new Storage();
  saveCloudConnection(storage, config);
  const before = storage.getItem(cloudConnectionStorageKey);
  expect(readUrgentRecoveryConnection(storage)).toEqual(config);
  const other = { ...config, apiUrl: 'https://other.test' };
  saveUrgentRecoveryConnection(storage, other);
  expect(readUrgentRecoveryConnection(storage)).toEqual(other);
  expect(storage.getItem(cloudConnectionStorageKey)).toBe(before);
});
