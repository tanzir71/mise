import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createUrgentInboxWorker,
  urgentInboxNoticeTag,
  urgentInboxNoticePath,
} from '../apps/web/src/urgent-inbox-worker';
import type {
  DeskNotificationView,
  DeskWindowView,
  DeskWorkerPorts,
} from '../apps/web/src/desk-notification-worker';
import { newKitchenId } from '../packages/core/kitchen';
import type { UrgentInboxNotice } from '../packages/core/urgent-inbox';
import {
  urgentNativeFixture,
  urgentOpened,
} from './urgent-inbox-native-fixture';

afterEach(() => {
  for (const db of urgentOpened) db.close();
  urgentOpened.length = 0;
  vi.restoreAllMocks();
});
async function fixture() {
  const f = await urgentNativeFixture(),
    row = await f.enable(),
    notice: UrgentInboxNotice = {
      v: 1,
      type: 'urgent-inbox',
      consentId: row.request.consentId,
      subscriptionId: row.request.subscriptionId,
      businessId: f.binding.businessId,
      outletId: f.binding.outletId,
      taskId: newKitchenId(),
      generation: 1,
    },
    notifications: DeskNotificationView[] = [],
    clients: DeskWindowView[] = [],
    show = vi.fn(async (_title: string, options: NotificationOptions) => {
      notifications.push({
        data: options.data,
        tag: options.tag!,
        close: vi.fn(),
      });
    }),
    open = vi.fn<DeskWorkerPorts['open']>(async () => null),
    ports = {
      origin: 'https://mise.test',
      base: f.base,
      native: f.db,
      cache: f.cache,
      source: async () => f.browser,
      show,
      notifications: async () => notifications,
      windows: async () => clients,
      open,
    },
    worker = createUrgentInboxWorker(ports);
  return { ...f, notice, notifications, clients, show, open, ports, worker };
}
it('shows a generic notification only for the actual native browser and confirmed explicit consent', async () => {
  const f = await fixture();
  await f.worker.push(f.notice);
  expect(f.show).toHaveBeenCalledExactlyOnceWith('Mise needs your attention', {
    body: 'An urgent item is waiting. Open Inbox to review.',
    tag: urgentInboxNoticeTag(f.base, f.notice),
    data: f.notice,
  });
  expect(JSON.stringify(f.show.mock.calls)).not.toMatch(
    /signature|endpoint|p256dh|phone|bodyJson/,
  );
});
it.each(['consentId', 'subscriptionId', 'businessId', 'outletId'] as const)(
  'rejects another %s instead of presenting an unrelated notification',
  async (field) => {
    const f = await fixture();
    await f.worker.push({ ...f.notice, [field]: newKitchenId() });
    expect(f.show).not.toHaveBeenCalled();
  },
);
it('rejects source text and caller chosen URLs in a push rather than rendering untrusted data', async () => {
  const f = await fixture();
  for (const patch of [
    { body: 'PRIVATE' },
    { url: 'https://other.test' },
    { generation: 0 },
    { type: 'kitchen' },
  ])
    await f.worker.push({ ...f.notice, ...patch });
  expect(f.show).not.toHaveBeenCalled();
});
it('suppresses and closes only its exact urgent tags immediately after offline Disable', async () => {
  const f = await fixture();
  await f.worker.push(f.notice);
  const own = f.notifications[0],
    unrelated = { data: f.notice, tag: 'other-feature', close: vi.fn() };
  f.notifications.push(unrelated);
  f.setOffline(true);
  await f.urgent.disable();
  await f.worker.recheck();
  expect(own.close).toHaveBeenCalledOnce();
  expect(unrelated.close).not.toHaveBeenCalled();
  f.show.mockClear();
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('closes a notification when Disable runs during browser presentation', async () => {
  const f = await fixture(),
    show = f.show.getMockImplementation()!;
  f.show.mockImplementation(async (title, options) => {
    await show(title, options);
    await f.urgent.disable();
  });
  await f.worker.push(f.notice);
  expect(f.notifications[0].close).toHaveBeenCalledOnce();
});
it('does not present after base Disable', async () => {
  const f = await fixture();
  await f.desk.disable();
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('does not present after retiring the active phone profile', async () => {
  const f = await fixture();
  await f.cache.retire((await f.snapshot()).desk.pointer);
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('does not present against a different actual PushManager capability', async () => {
  const f = await fixture(),
    worker = createUrgentInboxWorker({
      ...f.ports,
      source: async () => ({
        ...f.browser,
        subscription: {
          ...f.browser.subscription,
          endpoint:
            'https://fcm.googleapis.com/fcm/send/replaced-native-fixture',
        },
      }),
    });
  await worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('does not trust urgent metadata without the original confirmed registration journal', async () => {
  const f = await fixture();
  await f.cache.urgentOperations.clear();
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
});
it('fences native selection changes and leaves personal originals for recovery', async () => {
  const f = await fixture();
  await f.db.operatorState.put({ ...f.binding, revision: 2, phase: 'locked' });
  await f.worker.push(f.notice);
  expect(f.show).not.toHaveBeenCalled();
  expect(await f.cache.urgentOperations.count()).toBe(1);
});
it('opens a fixed same origin Inbox with only closed IDs for authenticated task resolution', async () => {
  const f = await fixture();
  await f.worker.push(f.notice);
  await f.worker.click(f.notifications[0]);
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    'https://mise.test' + urgentInboxNoticePath(f.base, f.notice),
  );
  const target = new URL(f.open.mock.calls[0][0] as string);
  expect(target.pathname).toBe(f.base + 'inbox');
  expect([...target.searchParams.keys()]).toEqual(['urgent']);
  expect(JSON.parse(target.searchParams.get('urgent')!)).toEqual(f.notice);
  expect(f.notifications[0].close).toHaveBeenCalledOnce();
});
it('reuses only a controlled app window and never navigates another origin or app base', async () => {
  const f = await fixture(),
    foreign = {
      url: 'https://other.test' + f.base,
      postMessage: vi.fn(),
      focus: vi.fn(),
      navigate: vi.fn(),
    },
    otherBase = {
      ...foreign,
      url: 'https://mise.test/other/app/',
      navigate: vi.fn(),
    },
    own = {
      ...foreign,
      url: 'https://mise.test' + f.base + 'stock',
      focus: vi.fn(),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
  f.clients.push(foreign, otherBase, own);
  await f.worker.push(f.notice);
  await f.worker.click(f.notifications[0]);
  expect(own.navigate).toHaveBeenCalledExactlyOnceWith(
    'https://mise.test' + urgentInboxNoticePath(f.base, f.notice),
  );
  expect(own.focus).toHaveBeenCalledOnce();
  expect(foreign.navigate).not.toHaveBeenCalled();
  expect(otherBase.navigate).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
it('does not open anything after a click on a withdrawn consent or a mismatched tag', async () => {
  const f = await fixture();
  await f.worker.push(f.notice);
  await f.urgent.disable();
  await f.worker.click(f.notifications[0]);
  expect(f.open).not.toHaveBeenCalled();
  await f.worker.click({ data: f.notice, tag: 'unrelated', close: vi.fn() });
  expect(f.open).not.toHaveBeenCalled();
});
it('keeps root and repository app paths separate and rejects a crafted route base', () => {
  const notice: UrgentInboxNotice = {
    v: 1,
    type: 'urgent-inbox',
    consentId: newKitchenId(),
    subscriptionId: newKitchenId(),
    businessId: newKitchenId(),
    outletId: newKitchenId(),
    taskId: newKitchenId(),
    generation: 2,
  };
  expect(urgentInboxNoticePath('/app/', notice)).toMatch(
    /^\/app\/inbox\?urgent=/,
  );
  expect(urgentInboxNoticePath('/mise/app/', notice)).toMatch(
    /^\/mise\/app\/inbox\?urgent=/,
  );
  for (const base of [
    '/app/?next=',
    '/app/../',
    '/app/\\',
    '//other.test/',
    '/%2e%2e/',
  ])
    expect(() => urgentInboxNoticePath(base, notice)).toThrow();
});
