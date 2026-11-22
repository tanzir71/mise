import 'fake-indexeddb/auto';
import { randomUUID, createECDH, randomBytes } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  DeskCache,
  deskProfileScope,
  type DeskBinding,
} from '../apps/web/src/data/desk-cache';
import { createDeskNativeScope } from '../apps/web/src/data/desk-native';
import { createDeskSession } from '../apps/web/src/data/desk-session';
import { cloudAuthStorageKey } from '../packages/core/cloud-connection';
import { testCommandAccount } from './command-account-fixture';
import { deskId as id, deskPage } from './desk-task-fixture';
const opened: Dexie[] = [],
  config = {
    apiUrl: 'https://cloud.test',
    publishableKey: 'sb_publishable_test_only',
  };
function browserSource() {
  const point = createECDH('prime256v1');
  point.generateKeys();
  return {
    applicationKey: generateVAPIDKeys().publicKey,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/session-fixture-only',
      expirationTime: null,
      keys: {
        p256dh: point.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    },
  };
}
async function boot() {
  const db = new MiseDatabase('desk-native-' + randomUUID()),
    cache = new DeskCache('/fixture-' + randomUUID() + '/app/');
  opened.push(db, cache);
  await db.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Native desk shop',
    phone: '01712345482',
  });
  const setup = (await db.setup())!,
    sale = await db.recordSale({ expression: '12', method: 'cash' }),
    branch = { ...setup.outlet, id: id(99), name: 'Second outlet' };
  await db.outlets.add(branch);
  let alive = true;
  const check = () => {
      if (!alive) throw Error('Desk scope ended');
    },
    account = {
      ...testCommandAccount(config, async () => 'original.phone.signature'),
      assertCurrent: check,
    };
  const binding: DeskBinding = {
    id: 'active',
    version: 1,
    revision: 1,
    phase: 'active',
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
    role: 'owner',
    connection: {
      accountHash: account.accountHash,
      targetHash: account.targetHash,
      authKey: await cloudAuthStorageKey(config, account.scope),
      epoch: '00000000-0000-4000-8000-000000000009',
      scopeVersion: '00000000-0000-4000-8000-000000000010',
    },
  };
  await db.operatorState.put(binding);
  const source = browserSource(),
    server = {
      scope: deskProfileScope(binding),
      items: [1],
      version: 12,
      at: 3000,
      revokeStatus: 200,
    },
    calls: { kind: string; body: Record<string, unknown> }[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (Dexie.currentTransaction?.active && Dexie.currentTransaction.db === db)
      throw Error('HTTP held a native shop transaction');
    const body = JSON.parse(String(init?.body)),
      rpc = new URL(String(url)).pathname.split('/').at(-1)!,
      kind = body.action ?? rpc;
    calls.push({ kind, body });
    if (rpc === 'read_kitchen_alarm_task_page')
      return Response.json({
        ...deskPage(server.items),
        access: server.scope,
        version: server.version,
        at: server.at,
      });
    if (rpc === 'set_kitchen_alarm_settings')
      return Response.json({
        enabled: body.p_enabled,
        minutes: body.p_minutes,
        revision: body.p_expected_revision + 1,
        expectedRevision: body.p_expected_revision,
        updatedAt: 4000,
      });
    if (kind === 'configuration')
      return Response.json({
        v: 1,
        context: server.scope,
        applicationKey: source.applicationKey,
      });
    if (kind === 'register')
      return Response.json({
        v: 1,
        id: body.id,
        businessId: server.scope.businessId,
        outletId: server.scope.outletId,
        memberId: server.scope.memberId,
        createdAt: 1000,
        expiresAt: null,
        revokedAt: null,
      });
    if (kind === 'revoke')
      return server.revokeStatus === 200
        ? Response.json(null)
        : new Response('{}', { status: server.revokeStatus });
    throw Error('Unexpected desk fixture request');
  });
  const native = createDeskNativeScope(db, binding, check),
    session = createDeskSession({
      cache,
      native,
      account,
      config,
      check,
      subscription: async () => source,
      send,
    });
  await session.refresh();
  const current = async () => {
    const saved = await cache.read(binding);
    if (!saved) throw Error('Missing current desk');
    return saved;
  };
  return {
    db,
    cache,
    setup,
    sale,
    branch,
    binding,
    native,
    session,
    account,
    check,
    source,
    server,
    calls,
    send,
    current,
    stop: () => {
      alive = false;
    },
  };
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.delete();
  vi.restoreAllMocks();
});
it('uses the real selected shop/member and keeps every HTTP request outside native shop transactions', async () => {
  const f = await boot();
  await f.native.assert();
  const op = await f.session.enable(
    await f.current(),
    Promise.resolve(f.source),
  );
  expect(f.calls.filter((row) => row.kind === 'register')).toEqual([]);
  await f.session.drain();
  expect((await f.current()).profile).toMatchObject({
    enabled: true,
    subscription: {
      id: op.request.kind === 'register' ? op.request.subscriptionId : '',
    },
  });
  expect(await f.db.sales.get(f.sale.id)).toEqual(f.sale);
  await f.db.operatorState.put({ ...f.binding, revision: 2, phase: 'locked' });
  await expect(f.native.assert()).rejects.toThrow();
});
it('retains the earlier complete Inbox when native selection changes while a fresh read is held', async () => {
  const f = await boot(),
    before = await f.current(),
    send = f.send.getMockImplementation()!;
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.send.mockImplementation(async (url, init) => {
    reached();
    await gate;
    return send(url, init);
  });
  f.server.items = [];
  f.server.version = 13;
  f.server.at = 4000;
  const pending = f.session.refresh().then(
    () => false,
    () => true,
  );
  await started;
  await f.db.operatorState.put({ ...f.binding, revision: 2, phase: 'locked' });
  release();
  expect(await pending).toBe(true);
  expect(await f.current()).toEqual(before);
  expect(await f.db.sales.get(f.sale.id)).toEqual(f.sale);
});
it('serializes a real operator switch after a brief cross-database cache write without holding a network request', async () => {
  const f = await boot();
  let changed: Promise<unknown> | null = null;
  f.cache.profiles.hook('updating', () => {
    changed = f.db.operatorState.put({
      ...f.binding,
      revision: 2,
      phase: 'locked',
    });
  });
  // Queue the actual current write; the shop read lock must retain its source
  // through the cache writer and release before the queued operator change.
  const saved = await f.current();
  await f.native.commit((guard) => f.cache.disable(saved, guard));
  expect(changed).not.toBeNull();
  await changed;
  expect((await f.db.operatorState.get('active'))?.phase).toBe('locked');
  await expect(f.native.assert()).rejects.toThrow();
});
it('atomically closes prior setups before registering a new one, keeping original withdrawal identities through retries', async () => {
  const f = await boot(),
    first = await f.session.enable(
      await f.current(),
      Promise.resolve(f.source),
    );
  await f.session.drain();
  const second = await f.session.enable(
    await f.current(),
    Promise.resolve(f.source),
  );
  expect((await f.current()).profile.enabled).toBe(false);
  const pending = await f.cache.pendingOperations(f.binding);
  expect(pending.map((row) => row.request.kind)).toEqual([
    'revoke',
    'register',
  ]);
  f.server.revokeStatus = 503;
  await expect(f.session.drain()).rejects.toThrow();
  expect(f.calls.filter((row) => row.kind === 'register')).toHaveLength(1);
  f.server.revokeStatus = 200;
  await f.session.drain();
  const revokes = f.calls.filter((row) => row.kind === 'revoke');
  expect(revokes).toHaveLength(2);
  expect(revokes[0].body).toEqual(revokes[1].body);
  expect((await f.current()).profile.subscription?.id).toBe(
    second.request.kind === 'register' ? second.request.subscriptionId : '',
  );
  expect(first.id).not.toBe(second.id);
  expect(await f.db.sales.get(f.sale.id)).toEqual(f.sale);
});
it('rolls an entire replacement back if saving its new registration fails after adding withdrawals', async () => {
  const f = await boot();
  await f.session.enable(await f.current(), Promise.resolve(f.source));
  await f.session.drain();
  const before = await f.current(),
    history = await f.cache.operationHistory(f.binding);
  f.cache.operations.hook('creating', (_key, value) => {
    if ((value as { request: { kind: string } }).request.kind === 'register')
      throw new DOMException('Storage full', 'QuotaExceededError');
  });
  await expect(
    f.session.enable(before, Promise.resolve(f.source)),
  ).rejects.toThrow('Storage full');
  expect(await f.current()).toEqual(before);
  expect(await f.cache.operationHistory(f.binding)).toEqual(history);
});
it('does not let a permission promise started before a newer Disable replace that later durable choice', async () => {
  const f = await boot(),
    snapshot = await f.current();
  let release!: (v: typeof f.source) => void;
  const source = new Promise<typeof f.source>((resolve) => {
      release = resolve;
    }),
    pending = f.session.enable(snapshot, source).then(
      () => false,
      () => true,
    );
  await f.session.disable();
  release(f.source);
  expect(await pending).toBe(true);
  expect(f.calls.filter((row) => row.kind === 'register')).toEqual([]);
  expect((await f.current()).profile.enabled).toBe(false);
});
it('keeps an explicit Enable valid through task refreshes while permission is pending without rewinding the newer Inbox', async () => {
  const f = await boot(),
    snapshot = await f.current();
  let release!: (v: typeof f.source) => void;
  const source = new Promise<typeof f.source>((resolve) => {
      release = resolve;
    }),
    pending = f.session.enable(snapshot, source);
  f.server.items = [1, 2];
  f.server.version = 13;
  f.server.at = 4000;
  await f.session.refresh();
  expect((await f.current()).profile.revision).not.toBe(
    snapshot.profile.revision,
  );
  expect((await f.current()).profile.choiceRevision).toBe(
    snapshot.profile.choiceRevision,
  );
  release(f.source);
  await pending;
  await f.session.drain();
  expect((await f.current()).profile).toMatchObject({
    enabled: true,
    tasks: { version: 13, tasks: [{ orderId: id(201) }, { orderId: id(202) }] },
  });
});
it('refreshes new tasks while registration HTTP is held and drains a Disable queued during that earlier request', async () => {
  const f = await boot();
  await f.session.enable(await f.current(), Promise.resolve(f.source));
  const send = f.send.getMockImplementation()!;
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.send.mockImplementation(async (url, init) => {
    if (JSON.parse(String(init?.body)).action === 'register') {
      reached();
      await gate;
    }
    return send(url, init);
  });
  const pending = f.session.drain();
  await started;
  f.server.items = [1, 2];
  f.server.version = 13;
  f.server.at = 4000;
  expect((await f.session.refresh()).profile.tasks.tasks).toHaveLength(2);
  await f.session.disable();
  const later = f.session.drain();
  release();
  await Promise.all([pending, later]);
  expect((await f.current()).profile).toMatchObject({
    enabled: false,
    tasks: { tasks: [{ orderId: id(201) }, { orderId: id(202) }] },
  });
  expect(f.calls.filter((row) => row.kind === 'revoke')).toHaveLength(1);
  expect(await f.cache.pendingOperations(f.binding)).toEqual([]);
});
it('keeps the exact warning values captured before asynchronous native checks', async () => {
  const f = await boot(),
    value = { enabled: true, minutes: 4, revision: 0 },
    assert = f.native.assert;
  f.native.assert = async () => {
    value.minutes = 9;
    await assert();
  };
  const operation = await f.session.settings(value);
  await f.session.drain();
  expect(operation.request).toEqual({
    kind: 'settings',
    enabled: true,
    minutes: 4,
    revision: 0,
  });
  expect(
    f.calls.find((row) => row.kind === 'set_kitchen_alarm_settings')?.body,
  ).toMatchObject({ p_minutes: 4, p_event_id: operation.id });
  expect((await f.current()).profile.tasks.settings).toEqual({
    enabled: true,
    minutes: 2,
    revision: 0,
  });
});
it('retains a rejected original warning change while delivering a later independent browser registration', async () => {
  const f = await boot(),
    settings = await f.session.settings({
      enabled: true,
      minutes: 4,
      revision: 0,
    }),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) =>
    String(url).endsWith('/set_kitchen_alarm_settings')
      ? new Response('{}', { status: 409 })
      : send(url, init),
  );
  const registration = await f.session.enable(
    await f.current(),
    Promise.resolve(f.source),
  );
  await expect(f.session.drain()).rejects.toThrow();
  expect((await f.current()).profile.enabled).toBe(true);
  expect(await f.cache.pendingOperations(f.binding)).toEqual([settings]);
  expect(
    (await f.cache.operationHistory(f.binding)).find(
      (row) => row.id === registration.id,
    )?.receipt?.action,
  ).toBe('register');
  expect(f.calls.filter((row) => row.kind === 'register')).toHaveLength(1);
  expect(await f.db.sales.get(f.sale.id)).toEqual(f.sale);
});
it('allows actual-account cleanup for an inactive earlier outlet without activating it or changing the newer selected outlet', async () => {
  const f = await boot();
  await f.session.enable(await f.current(), Promise.resolve(f.source));
  await f.session.drain();
  const next: DeskBinding = {
    ...f.binding,
    revision: 2,
    outletId: f.branch.id,
  };
  await f.db.operatorState.put(next);
  f.server.scope = deskProfileScope(next);
  const session = createDeskSession({
    cache: f.cache,
    native: createDeskNativeScope(f.db, next, f.check),
    account: f.account,
    config,
    check: f.check,
    subscription: async () => f.source,
    send: f.send,
  });
  const selected = await session.refresh(),
    old = await f.cache.profileById(
      (await f.cache.savedSetups()).find(
        (row) => row.binding.outletId === f.binding.outletId,
      )!.profileId,
    );
  expect(old).not.toBeNull();
  await f.cache.withdrawProfile(old!);
  await session.cleanup();
  expect(await f.cache.read(next)).toEqual(selected);
  expect(await f.cache.read(f.binding)).toBeNull();
  expect(
    (await f.cache.savedSetups()).find(
      (row) => row.binding.outletId === f.binding.outletId,
    ),
  ).toMatchObject({ enabled: false, openSetups: 0, pendingWithdrawals: 0 });
  expect(await f.db.sales.get(f.sale.id)).toEqual(f.sale);
});
