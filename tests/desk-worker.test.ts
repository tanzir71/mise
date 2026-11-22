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
import { bindDeskReceipt } from '../apps/web/src/data/desk-proof';
import { deskRegistrationFingerprint } from '../apps/web/src/data/desk-operation';
import {
  createDeskNotificationWorker,
  closeResolvedDeskNotifications,
  deskNoticeTag,
  type DeskNotificationView,
  type DeskWindowView,
} from '../apps/web/src/desk-notification-worker';
import {
  completeDeskTaskList,
  parseDeskTaskPage,
} from '../packages/core/desk-tasks';
import type { KitchenPushNotice } from '../packages/core/desk-push';
import { deskPage, deskId as id } from './desk-task-fixture';
const opened: Dexie[] = [];
async function boot(base = '/mise/app/') {
  const native = new MiseDatabase('desk-worker-' + randomUUID()),
    cache = new DeskCache('/worker-' + randomUUID() + '/app/');
  opened.push(native, cache);
  await native.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Private desk shop',
    phone: '01712345482',
  });
  const setup = (await native.setup())!,
    sale = await native.recordSale({ expression: '12', method: 'cash' });
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
      accountHash: 'a'.repeat(64),
      targetHash: 'b'.repeat(64),
      authKey: 'mise.cloud.auth.' + 'c'.repeat(64),
      epoch: '00000000-0000-4000-8000-000000000009',
      scopeVersion: '00000000-0000-4000-8000-000000000010',
    },
  };
  await native.operatorState.put(binding);
  const receipt = <T extends object>(value: T) =>
    bindDeskReceipt(value, () => {}, {
      accountHash: binding.connection.accountHash,
      targetHash: binding.connection.targetHash,
      scope: deskProfileScope(binding),
    });
  const list = (numbers: number[], version = 12) =>
    receipt(
      completeDeskTaskList(
        parseDeskTaskPage(
          {
            ...deskPage(numbers),
            access: deskProfileScope(binding),
            version,
            at: 3000 + version,
          },
          deskProfileScope(binding),
        ),
      ),
    );
  const original = await cache.activate(
      await cache.pointer(),
      binding,
      list([1, 2]),
    ),
    point = createECDH('prime256v1');
  point.generateKeys();
  const source = {
    applicationKey: generateVAPIDKeys().publicKey,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/worker-fixture',
      expirationTime: null,
      keys: {
        p256dh: point.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    },
  };
  const operation = await cache.queueRegistration(original, {
    eventId: id(6),
    request: {
      kind: 'register',
      subscriptionId: id(5),
      ...(await deskRegistrationFingerprint(source)),
    },
  });
  await cache.confirmOperation(
    operation,
    receipt({
      action: 'register',
      eventId: operation.id,
      id: id(5),
      subscription: {
        v: 1,
        id: id(5),
        businessId: binding.businessId,
        outletId: binding.outletId,
        memberId: binding.actorId,
        createdAt: 1000,
        expiresAt: null,
        revokedAt: null,
      },
    }),
    () => {},
  );
  const notice: KitchenPushNotice = {
      v: 1,
      type: 'kitchen-alarm',
      subscriptionId: id(5),
      businessId: binding.businessId,
      outletId: binding.outletId,
      taskId: id(101),
      generation: 1,
    },
    notifications: DeskNotificationView[] = [],
    clients: DeskWindowView[] = [];
  const show = vi.fn(async (_title: string, options: NotificationOptions) => {
      const notification = {
        tag: options.tag!,
        data: options.data,
        close: vi.fn(),
      };
      notifications.push(notification);
    }),
    read = vi.fn(async () => source),
    open = vi.fn<(url:string)=>Promise<null>>(async () => null);
  const worker = createDeskNotificationWorker({
    origin: 'https://desk.test',
    base,
    native,
    cache,
    source: read,
    show,
    notifications: async () => notifications,
    windows: async () => clients,
    open,
    now: () => 5000,
  });
  const current = async () => {
    const saved = await cache.read(binding);
    if (!saved) throw Error('Missing desk');
    return saved;
  };
  return {
    native,
    cache,
    binding,
    sale,
    receipt,
    list,
    source,
    notice,
    notifications,
    clients,
    show,
    read,
    open,
    worker,
    current,
    base,
  };
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.delete();
});
it.each(['/app/', '/mise/app/'])(
  'presents generic data and opens only the own-base Inbox at %s',
  async (base) => {
    const f = await boot(base);
    await f.worker.push(f.notice);
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(f.show.mock.calls[0]).toEqual([
      'Mise needs your attention',
      {
        body: 'An order is waiting for the kitchen. Open Inbox to review.',
        tag: deskNoticeTag(base, f.notice),
        data: f.notice,
      },
    ]);
    expect(JSON.stringify(f.show.mock.calls)).not.toMatch(
      /Private desk|017123|access_token|p256dh|endpoint/,
    );
    await f.worker.click(f.notifications[0]);
    expect(f.open).toHaveBeenCalledWith('https://desk.test' + base + 'inbox');
    expect(await f.native.sales.get(f.sale.id)).toEqual(f.sale);
  },
);
it('rejects caller URLs, another subscription/outlet, invalid notices and a changed native selection', async () => {
  const f = await boot();
  for (const value of [
    null,
    {},
    { ...f.notice, url: 'https://other.test/' },
    { ...f.notice, subscriptionId: id(99) },
    { ...f.notice, outletId: id(99) },
  ])
    await f.worker.push(value);
  await f.native.operatorState.put({
    ...f.binding,
    revision: 2,
    phase: 'locked',
  });
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('requires the actual original PushManager capability and confirmed choice, never cached subscription metadata alone', async () => {
  const f = await boot(),
    replacement = {
      ...f.source,
      subscription: {
        ...f.source.subscription,
        endpoint: f.source.subscription.endpoint + '-replacement',
      },
    };
  f.read.mockResolvedValueOnce(replacement);
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
  const snapshot = await f.current();
  await f.cache.queueRegistration(snapshot, {
    eventId: id(8),
    request: {
      kind: 'register',
      subscriptionId: id(7),
      ...(await deskRegistrationFingerprint(f.source)),
    },
  });
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('mutes offline before cleanup HTTP and refuses an old click while leaving unrelated browser notices intact', async () => {
  const f = await boot();
  await f.worker.push(f.notice);
  const own = f.notifications[0],
    unrelated = { tag: 'another-feature', data: f.notice, close: vi.fn() };
  f.notifications.push(unrelated);
  await f.cache.disable(await f.current());
  await f.worker.recheck();
  expect(own.close).toHaveBeenCalledTimes(1);
  expect(unrelated.close).not.toHaveBeenCalled();
  await f.worker.click(own);
  await f.worker.push(f.notice);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.show).toHaveBeenCalledTimes(1);
  expect((await f.current()).profile.tasks.tasks).toHaveLength(2);
});
it('closes a notice if Disable wins while browser presentation is pending', async () => {
  const f = await boot(),
    show = f.show.getMockImplementation()!;
  f.show.mockImplementation(async (title, options) => {
    await f.cache.disable(await f.current());
    await show(title, options);
  });
  await f.worker.push(f.notice);
  expect(f.notifications[0].close).toHaveBeenCalledTimes(1);
  expect(f.open).not.toHaveBeenCalled();
});
it('focuses the canonical own Inbox without using another installation or arbitrary notification data', async () => {
  const f = await boot(),
    foreign = {
      url: 'https://desk.test/other/app/inbox',
      focus: vi.fn(async () => null),
      navigate: vi.fn(async () => null),
      postMessage: vi.fn(),
    },
    own = {
      ...foreign,
      url: 'https://desk.test/mise/app/orders/123',
      focus: vi.fn(async () => null),
      navigate: vi.fn(async () => null),
      postMessage: vi.fn(),
    };
  f.clients.push(foreign, own);
  await f.worker.push(f.notice);
  expect(own.postMessage).toHaveBeenCalledWith({ type: 'MISE_DESK_REFRESH' });
  expect(foreign.postMessage).not.toHaveBeenCalled();
  await f.worker.click(f.notifications[0]);
  expect(own.navigate).toHaveBeenCalledWith('https://desk.test/mise/app/inbox');
  expect(own.focus).toHaveBeenCalledTimes(1);
  expect(foreign.focus).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
it('closes only a previously known resolved generation after a successful complete task replacement', async () => {
  const f = await boot();
  await f.worker.push(f.notice);
  const before = await f.current(),
    laterNotice = { ...f.notice, generation: 2 },
    later = {
      tag: deskNoticeTag(f.base, laterNotice),
      data: laterNotice,
      close: vi.fn(),
    },
    unknownNotice = { ...f.notice, taskId: id(999) },
    unknown = {
      tag: deskNoticeTag(f.base, unknownNotice),
      data: unknownNotice,
      close: vi.fn(),
    };
  f.notifications.push(later, unknown);
  const after = await f.cache.replaceTasks(before, f.list([2], 13));
  await closeResolvedDeskNotifications(
    f.base,
    before,
    after,
    async () => f.notifications,
  );
  expect(f.notifications[0].close).toHaveBeenCalledTimes(1);
  expect(later.close).not.toHaveBeenCalled();
  expect(unknown.close).not.toHaveBeenCalled();
  expect(await f.native.sales.get(f.sale.id)).toEqual(f.sale);
});
it('does not clear a still-current task, an older list or a different selected desk', async () => {
  const f = await boot();
  await f.worker.push(f.notice);
  const before = await f.current(),
    next = await f.cache.replaceTasks(before, f.list([1, 2], 13));
  await closeResolvedDeskNotifications(
    f.base,
    before,
    next,
    async () => f.notifications,
  );
  await closeResolvedDeskNotifications(
    f.base,
    next,
    before,
    async () => f.notifications,
  );
  await closeResolvedDeskNotifications(
    f.base,
    { ...before, pointer: { ...before.pointer, revision: id(90) } },
    next,
    async () => f.notifications,
  );
  expect(f.notifications[0].close).not.toHaveBeenCalled();
});
