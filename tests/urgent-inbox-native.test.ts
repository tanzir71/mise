import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { IDBObjectStore as NativeObjectStore } from 'fake-indexeddb';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { DeskCache, deskProfileScope } from '../apps/web/src/data/desk-cache';
import { newKitchenId } from '../packages/core/kitchen';
import {
  createUrgentInboxCache,
  urgentInboxSetupLimit,
  urgentInboxProfileMatches,
} from '../apps/web/src/data/urgent-inbox-cache';
import { parseUrgentInboxOperation } from '../apps/web/src/data/urgent-inbox-operation';
import { bindDeskReceipt } from '../apps/web/src/data/desk-proof';
import {
  urgentNativeFixture,
  urgentOpened,
} from './urgent-inbox-native-fixture';

afterEach(() => {
  for (const db of urgentOpened) db.close();
  urgentOpened.length = 0;
  vi.restoreAllMocks();
});
async function targetFixture() {
  const f = await urgentNativeFixture(),
    row = await f.enable();
  const notice = {
    v: 1 as const,
    type: 'urgent-inbox' as const,
    consentId: row.request.consentId,
    subscriptionId: row.request.subscriptionId,
    businessId: f.binding.businessId,
    outletId: f.binding.outletId,
    taskId: newKitchenId(),
    generation: 1,
  };
  const task = {
    id: notice.taskId,
    businessId: notice.businessId,
    outletId: notice.outletId,
    kind: 'check',
    titleJson: JSON.stringify('Check this source'),
    bodyJson: JSON.stringify('Literal source\u0000\ud800'),
    status: 'open',
    dueAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    source: 'manual',
    mode: 'check',
    recipient: null,
    preparedJson: '""',
    authorJson: null,
    target: null,
    fingerprint: 'a'.repeat(64),
    lastActionId: null,
    undoable: false,
    decision: null,
    replyJson: null,
    urgent: true,
    actions: ['fixed'],
  };
  const response = {
    v: 1,
    at: 4000,
    scope: f.scope,
    notice,
    currentGeneration: 1,
    active: true,
    task,
  };
  const send = f.send.getMockImplementation()!;
  const effect = { onTarget: async () => {} };
  f.send.mockImplementation(async (url, init) => {
    if (JSON.parse(String(init?.body)).action !== 'target')
      return send(url, init);
    await effect.onTarget();
    return Response.json(response);
  });
  return { ...f, notice, response, effect };
}
it('reads the actual target with literal source and original routing without executing a task choice', async () => {
  const f = await targetFixture(),
    before = await f.db.sales.toArray(),
    result = await f.urgent.target(f.notice);
  expect(result).toEqual(f.response);
  expect(JSON.parse(result.task.bodyJson)).toBe('Literal source\u0000\ud800');
  expect(await f.db.sales.toArray()).toEqual(before);
  expect((await f.snapshot()).profile?.enabled).toBe(true);
});
it('rejects a target after local Disable runs during its HTTP response', async () => {
  const f = await targetFixture();
  f.effect.onTarget = async () => {
    await f.urgent.disable();
  };
  await expect(f.urgent.target(f.notice)).rejects.toMatchObject({
    kind: 'review',
  });
  expect((await f.snapshot()).profile?.enabled).toBe(false);
});
it('rejects a target when the actual browser capability is replaced during its HTTP response', async () => {
  const f = await targetFixture();
  f.effect.onTarget = async () => {
    f.replaceBrowser();
  };
  await expect(f.urgent.target(f.notice)).rejects.toMatchObject({
    kind: 'review',
  });
});
it('rejects a target after a native selection change during its HTTP response', async () => {
  const f = await targetFixture();
  f.effect.onTarget = async () => {
    await f.db.operatorState.put({
      ...f.binding,
      revision: 2,
      phase: 'locked',
    });
  };
  await expect(f.urgent.target(f.notice)).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await f.db.operatorState.get('active')).toMatchObject({
    phase: 'locked',
    revision: 2,
  });
});
it('does not enroll general alerts from an existing confirmed kitchen setup', async () => {
  const f = await urgentNativeFixture();
  expect((await f.cache.read(f.binding))?.profile.enabled).toBe(true);
  expect((await f.snapshot()).profile).toBeNull();
  expect(await f.cache.urgentOperations.count()).toBe(0);
  expect(f.calls).toEqual([]);
});
it('persists No before the first positive intent is journaled and fences its late configuration reply', async () => {
  const f = await urgentNativeFixture(),
    before = await f.snapshot(),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await send(url, init);
    if (JSON.parse(String(init?.body)).action === 'configuration')
      await f.urgent.disable();
    return response;
  });
  await expect(f.urgent.enable(before)).rejects.toMatchObject({
    kind: 'review',
  });
  expect((await f.snapshot()).profile).toMatchObject({
    enabled: false,
    consent: null,
  });
  expect(await f.cache.urgentOperations.count()).toBe(0);
  expect(f.registrations.size).toBe(0);
  await expect(
    f.urgent.journal.queueRegistration(
      before,
      newKitchenId(),
      newKitchenId(),
      () => {},
    ),
  ).rejects.toMatchObject({ kind: 'changed' });
  f.send.mockImplementation(send);
  await f.enable();
  expect((await f.snapshot()).profile?.enabled).toBe(true);
});
it('journals separate consent before HTTP and enables only from its original verified receipt', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot());
  expect(row.request.kind).toBe('register');
  expect((await f.snapshot()).profile).toMatchObject({
    choiceRevision: row.id,
    enabled: false,
    consent: null,
  });
  expect(f.registrations.size).toBe(0);
  await f.urgent.drain();
  expect((await f.snapshot()).profile).toMatchObject({
    enabled: true,
    consent: {
      id: row.request.consentId,
      subscriptionId: row.request.subscriptionId,
    },
  });
  const stored = JSON.stringify([
    await f.cache.urgentProfiles.toArray(),
    await f.cache.urgentOperations.toArray(),
  ]);
  expect(stored).not.toMatch(
    /original.phone.signature|endpoint|p256dh|publishableKey|apiUrl|applicationKey/,
  );
  expect(f.calls.map((row) => row.action)).toEqual([
    'configuration',
    'configuration',
    'register',
    'inspect',
  ]);
});
it('atomically mutes offline and retains an original withdrawal across a real close and reopen', async () => {
  const f = await urgentNativeFixture(),
    row = await f.enable();
  f.setOffline(true);
  await f.urgent.disable();
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  await expect(f.urgent.drain()).rejects.toThrow();
  expect(f.closures.size).toBe(0);
  f.cache.close();
  const next = new DeskCache(f.base);
  urgentOpened.push(next);
  const journal = createUrgentInboxCache(next),
    pending = await journal.pendingWithdrawals(
      f.account.accountHash,
      f.account.targetHash,
    );
  expect(pending).toHaveLength(1);
  expect(pending[0].request.consentId).toBe(row.request.consentId);
  expect((await journal.read(f.binding))?.profile?.enabled).toBe(false);
  f.setOffline(false);
  const proof = await f.remote.withdraw(
    pending[0].request.consentId,
    pending[0].id,
  );
  await journal.confirm(pending[0], proof, () => {});
  expect(
    await journal.pendingWithdrawals(
      f.account.accountHash,
      f.account.targetHash,
    ),
  ).toEqual([]);
});
it('withdraws a setup that has not arrived and never retries it after offline Disable', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot());
  await f.urgent.disable();
  await f.urgent.drain();
  expect(f.calls.filter((row) => row.action === 'register')).toEqual([]);
  expect(f.closures.get(row.request.consentId)?.consent).toBeNull();
  expect(await f.urgent.journal.pendingRegistrations(f.binding)).toEqual([]);
});
it('closes older originals before sending a new consent and blocks registration when cleanup fails', async () => {
  const f = await urgentNativeFixture(),
    old = await f.enable();
  await f.urgent.disable();
  const next = await f.urgent.enable(await f.snapshot()),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) =>
    JSON.parse(String(init?.body)).action === 'withdraw'
      ? new Response('', { status: 503 })
      : send(url, init),
  );
  await expect(f.urgent.drain()).rejects.toMatchObject({ kind: 'retry' });
  expect(f.registrations.has(next.request.consentId)).toBe(false);
  f.send.mockImplementation(send);
  f.calls.length = 0;
  await f.urgent.drain();
  expect(f.calls.map((row) => row.action)).toEqual([
    'withdraw',
    'configuration',
    'register',
    'inspect',
  ]);
  expect(f.closures.has(old.request.consentId)).toBe(true);
  expect((await f.snapshot()).profile?.consent?.id).toBe(
    next.request.consentId,
  );
});
it('recovers an immutable registration after a lost response without making a new consent', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await send(url, init);
    if (JSON.parse(String(init?.body)).action === 'register')
      throw Error('Response lost');
    return response;
  });
  await expect(f.urgent.drain()).rejects.toMatchObject({ kind: 'retry' });
  expect(f.registrations.size).toBe(1);
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  f.send.mockImplementation(send);
  expect(await f.urgent.inspect(row)).toBe(true);
  expect((await f.snapshot()).profile?.enabled).toBe(true);
  expect(f.registrations.size).toBe(1);
});
it('does not treat an absent inspection or a current metadata read as the original mutation receipt', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot());
  expect(await f.urgent.inspect(row)).toBe(false);
  expect((await f.urgent.journal.history(f.binding))[0].receipt).toBeNull();
  const metadata = await f.remote.read(row.request.consentId);
  await expect(
    f.urgent.journal.confirm(row, metadata, () => {}),
  ).rejects.toThrow();
  expect((await f.snapshot()).profile?.enabled).toBe(false);
});
it('recovers historical registration after withdrawal without reactivating local presentation', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    proof = await f.remote.register(
      row.request.consentId,
      row.request.subscriptionId,
      row.id,
    );
  await f.urgent.disable();
  await f.urgent.drain();
  expect(await f.urgent.inspect(row)).toBe(true);
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  expect((await f.urgent.journal.history(f.binding))[0].receipt).toEqual(proof);
});
it('does not let a late successful response overtake another tab Disable', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    send = f.send.getMockImplementation()!;
  let release!: () => void, entered!: () => void;
  const seen = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.send.mockImplementation(async (url, init) => {
    const response = await send(url, init);
    if (JSON.parse(String(init?.body)).action === 'register') {
      entered();
      await gate;
    }
    return response;
  });
  const pending = f.urgent.drain();
  await seen;
  const tab = new DeskCache(f.base);
  urgentOpened.push(tab);
  const journal = createUrgentInboxCache(tab);
  await journal.disable((await journal.read(f.binding))!, () => {});
  release();
  await pending;
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  expect(
    (await f.urgent.journal.history(f.binding)).find(
      (value) => value.id === row.id,
    )?.receipt?.action,
  ).toBe('register');
  expect(
    await f.urgent.journal.pendingWithdrawals(
      f.account.accountHash,
      f.account.targetHash,
    ),
  ).toHaveLength(1);
});
it('retains a late original result as history when a newer consent is chosen', async () => {
  const f = await urgentNativeFixture(),
    old = await f.urgent.enable(await f.snapshot()),
    proof = await f.remote.register(
      old.request.consentId,
      old.request.subscriptionId,
      old.id,
    ),
    next = await f.urgent.enable(await f.snapshot());
  await f.urgent.journal.confirm(old, proof, () => {});
  expect((await f.snapshot()).profile).toMatchObject({
    choiceRevision: next.id,
    enabled: false,
    consent: null,
  });
  await f.urgent.drain();
  expect((await f.snapshot()).profile?.consent?.id).toBe(
    next.request.consentId,
  );
});
it('does not accept serialized receipts or a receipt bound to another account', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    proof = await f.remote.register(
      row.request.consentId,
      row.request.subscriptionId,
      row.id,
    );
  await expect(
    f.urgent.journal.confirm(row, structuredClone(proof), () => {}),
  ).rejects.toMatchObject({ kind: 'review' });
  const other = bindDeskReceipt(structuredClone(proof), () => {}, {
    accountHash: 'e'.repeat(64),
    targetHash: f.account.targetHash,
    scope: deskProfileScope(f.binding),
  });
  await expect(
    f.urgent.journal.confirm(row, other, () => {}),
  ).rejects.toMatchObject({ kind: 'auth' });
  expect((await f.snapshot()).profile?.enabled).toBe(false);
});
it('rolls back both local mute and withdrawals when quota fails rather than sending an unsaved choice', async () => {
  const f = await urgentNativeFixture();
  await f.enable();
  const before = await f.snapshot(),
    operations = await f.cache.urgentOperations.toArray(),
    nativePut = NativeObjectStore.prototype.put;
  vi.spyOn(NativeObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'urgentProfiles')
      throw new DOMException('Native quota reached', 'QuotaExceededError');
    return key === undefined
      ? nativePut.call(this, value)
      : nativePut.call(this, value, key);
  });
  await expect(f.urgent.disable()).rejects.toThrow('Native quota reached');
  expect(await f.snapshot()).toEqual(before);
  expect(await f.cache.urgentOperations.toArray()).toEqual(operations);
  expect(f.closures.size).toBe(0);
});
it('never sends a registration when saving the original journal fails', async () => {
  const f = await urgentNativeFixture();
  f.cache.urgentOperations.hook('creating', () => {
    throw Error('Native storage failed');
  });
  await expect(f.urgent.enable(await f.snapshot())).rejects.toThrow(
    'Native storage failed',
  );
  expect(f.registrations.size).toBe(0);
  expect((await f.snapshot()).profile).toBeNull();
});
it('fences stale competing tab snapshots instead of muting a newer explicit choice', async () => {
  const f = await urgentNativeFixture();
  await f.enable();
  const stale = await f.snapshot();
  await f.urgent.disable();
  const next = await f.urgent.enable(await f.snapshot());
  await expect(f.urgent.journal.disable(stale, () => {})).rejects.toMatchObject(
    { kind: 'changed' },
  );
  expect((await f.snapshot()).profile?.choiceRevision).toBe(next.id);
});
it('keeps original cleanup available after assignment loss or missing delivery configuration', async () => {
  const f = await urgentNativeFixture(),
    row = await f.enable();
  f.setAssigned(false);
  f.setReady(false);
  await f.urgent.disable();
  await f.urgent.cleanup();
  expect(f.closures.has(row.request.consentId)).toBe(true);
  expect(await f.urgent.inspect(row)).toBe(true);
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  await expect(f.urgent.enable(await f.snapshot())).rejects.toThrow();
});
it('cannot use another phone generation for an original withdrawal', async () => {
  const f = await urgentNativeFixture();
  await f.enable();
  await f.urgent.disable();
  f.loseAccount();
  await expect(f.urgent.cleanup()).rejects.toThrow('Original phone changed');
  expect(f.closures.size).toBe(0);
  expect(
    await f.urgent.journal.pendingWithdrawals(
      f.account.accountHash,
      f.account.targetHash,
    ),
  ).toHaveLength(1);
});
it('rejects a replacement browser capability before saving or sending a positive consent', async () => {
  const f = await urgentNativeFixture();
  f.replaceBrowser();
  await expect(f.urgent.enable(await f.snapshot())).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await f.cache.urgentOperations.count()).toBe(0);
});
it('requires the actual original registered base journal rather than valid looking metadata', async () => {
  const f = await urgentNativeFixture();
  await f.cache.operations.clear();
  await expect(f.urgent.enable(await f.snapshot())).rejects.toMatchObject({
    kind: 'changed',
  });
  expect(f.calls).toEqual([]);
});
it('does not revive general consent after the base subscription is disabled or replaced', async () => {
  const f = await urgentNativeFixture();
  await f.enable();
  const previous = (await f.snapshot()).profile!;
  await f.desk.disable();
  expect((await f.cache.read(f.binding))?.profile.enabled).toBe(false);
  await expect(f.urgent.enable(await f.snapshot())).rejects.toMatchObject({
    kind: 'changed',
  });
  await f.desk.enable(
    (await f.cache.read(f.binding))!,
    Promise.resolve(f.browser),
  );
  await f.desk.drain();
  expect(urgentInboxProfileMatches(previous, (await f.snapshot()).desk)).toBe(
    false,
  );
});
it('records a late genuine receipt as history after base Disable without failing cleanup or enabling presentation', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    proof = await f.remote.register(
      row.request.consentId,
      row.request.subscriptionId,
      row.id,
    );
  await f.desk.disable();
  await f.urgent.journal.confirm(row, proof, () => {});
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  expect((await f.urgent.journal.history(f.binding))[0].receipt).toEqual(proof);
  await f.urgent.disable();
  await f.urgent.cleanup();
  expect(f.closures.has(row.request.consentId)).toBe(true);
});
it('reuses an exact original queue result without mutating a later offline Disable', async () => {
  const f = await urgentNativeFixture(),
    original = await f.snapshot(),
    row = await f.urgent.enable(original);
  await f.urgent.disable();
  const before = await f.snapshot();
  expect(
    await f.urgent.journal.queueRegistration(
      original,
      row.id,
      row.request.consentId,
      () => {},
    ),
  ).toEqual(row);
  expect(await f.snapshot()).toEqual(before);
  await expect(
    f.urgent.journal.queueRegistration(
      original,
      row.id,
      newKitchenId(),
      () => {},
    ),
  ).rejects.toThrow();
});
it('records an actual reply after a native operator switch without selecting or enabling its old outlet', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot()),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await send(url, init);
    if (JSON.parse(String(init?.body)).action === 'inspect')
      await f.db.operatorState.put({
        ...f.binding,
        revision: 2,
        phase: 'locked',
      });
    return response;
  });
  await f.urgent.drain();
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  expect((await f.urgent.journal.history(f.binding))[0]).toMatchObject({
    id: row.id,
    receipt: { action: 'register' },
  });
  expect(await f.db.operatorState.get('active')).toMatchObject({
    phase: 'locked',
    revision: 2,
  });
});
it('permits historical cleanup without selecting a saved outlet or changing shop records', async () => {
  const f = await urgentNativeFixture();
  await f.enable();
  const profile = (await f.snapshot()).profile!,
    operator = { ...f.binding, revision: 2, phase: 'locked' as const };
  await f.cache.retire((await f.snapshot()).desk.pointer);
  await f.db.operatorState.put(operator);
  const cash = await f.db.sales.toArray();
  await f.urgent.journal.withdrawProfile(profile, () => {});
  await f.urgent.cleanup();
  expect(await f.db.operatorState.get('active')).toEqual(operator);
  expect(await f.db.sales.toArray()).toEqual(cash);
  expect(f.closures.size).toBe(1);
});
it('reserves withdrawal capacity at the history limit and never evicts original actions', async () => {
  const f = await urgentNativeFixture(),
    first = await f.urgent.enable(await f.snapshot()),
    rows = Array.from({ length: urgentInboxSetupLimit - 1 }, (_, i) =>
      parseUrgentInboxOperation({
        ...first,
        id: newKitchenId(),
        sequence: i + 2,
        request: { ...first.request, consentId: newKitchenId() },
      }),
    );
  await f.cache.urgentOperations.bulkAdd(rows);
  await expect(f.urgent.enable(await f.snapshot())).rejects.toThrow(
    'setup limit',
  );
  expect(await f.cache.urgentOperations.count()).toBe(urgentInboxSetupLimit);
  await f.urgent.disable();
  expect(await f.cache.urgentOperations.count()).toBe(
    urgentInboxSetupLimit * 2,
  );
  expect((await f.snapshot()).profile?.enabled).toBe(false);
});
it('upgrades an existing schema 3 cache without modifying its kitchen choice or stored records', async () => {
  const f = await urgentNativeFixture(),
    profiles = await f.cache.profiles.toArray(),
    active = await f.cache.active.toArray(),
    operations = await f.cache.operations.toArray(),
    name = 'mise.desk.v1:/upgrade-' + randomUUID() + '/app/',
    legacy = new Dexie(name);
  urgentOpened.push(legacy);
  legacy.version(3).stores({
    profiles: '&id',
    active: '&id',
    operations: '&id,profileId,&[profileId+sequence]',
  });
  await legacy.table('profiles').bulkAdd(profiles);
  await legacy.table('active').bulkAdd(active);
  await legacy.table('operations').bulkAdd(operations);
  legacy.close();
  const current = new DeskCache(name.slice('mise.desk.v1:'.length));
  urgentOpened.push(current);
  expect(await current.profiles.toArray()).toEqual(profiles);
  expect(await current.active.toArray()).toEqual(active);
  expect(await current.operations.toArray()).toEqual(operations);
  expect(await current.urgentProfiles.count()).toBe(0);
  expect(await current.urgentOperations.count()).toBe(0);
});
it('retains the original HTTP receipt when native selection changes at the commit boundary', async () => {
  const f = await urgentNativeFixture(),
    row = await f.urgent.enable(await f.snapshot());
  const commit = f.options.native.commit.bind(f.options.native);
  vi.spyOn(f.options.native, 'commit').mockImplementation(async (work) => {
    await f.db.operatorState.put({
      ...f.binding,
      revision: 2,
      phase: 'locked',
    });
    return commit(work);
  });
  await f.urgent.drain();
  expect((await f.snapshot()).profile?.enabled).toBe(false);
  expect((await f.urgent.journal.history(f.binding))[0]).toMatchObject({
    id: row.id,
    receipt: { action: 'register' },
  });
  expect(await f.db.operatorState.get('active')).toMatchObject({
    phase: 'locked',
    revision: 2,
  });
});
