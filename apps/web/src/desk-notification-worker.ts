import {
  parseKitchenPushNotice,
  type KitchenPushNotice,
} from '@mise/core/desk-push';
import {
  parseDeskBinding,
  type DeskCache,
  type DeskSnapshot,
} from './data/desk-cache';
import { deskRegistrationFingerprint } from './data/desk-operation';
import { createDeskNativeScope } from './data/desk-native';
import type { LocalStore } from './data/local-store';
import type { DeskBrowserSource } from './data/desk-session';

export interface DeskNotificationView {
  tag: string;
  data: unknown;
  close: () => void;
}
export interface DeskWindowView {
  url: string;
  focus: () => Promise<unknown>;
  navigate?: (url: string) => Promise<unknown>;
  postMessage: (value: unknown) => void;
}
export interface DeskWorkerPorts {
  origin: string;
  base: string;
  native: LocalStore;
  cache: DeskCache;
  source: () => Promise<DeskBrowserSource | null>;
  show: (title: string, options: NotificationOptions) => Promise<void>;
  notifications: () => Promise<DeskNotificationView[]>;
  windows: () => Promise<readonly DeskWindowView[]>;
  open: (url: string) => Promise<unknown>;
  now?: () => number;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function deskNoticeTag(base: string, notice: KitchenPushNotice) {
  return `mise.desk.kitchen:${base}:${notice.subscriptionId}:${notice.taskId}:${notice.generation}`;
}
/** No Auth token, customer text, caller URL or network request is needed to
 * present this generic hint. Actual records are read by the signed-in Inbox. */
export function createDeskNotificationWorker(ports: DeskWorkerPorts) {
  const root = new URL(ports.base, ports.origin),
    target = new URL('inbox', root).href;
  if (
    root.origin !== ports.origin ||
    root.pathname !== ports.base ||
    root.search ||
    root.hash ||
    !ports.base.startsWith('/') ||
    !ports.base.endsWith('/')
  )
    throw Error('Invalid desk notification scope');
  const owned = (url: string) => {
    try {
      const value = new URL(url);
      return (
        value.origin === root.origin && value.pathname.startsWith(root.pathname)
      );
    } catch {
      return false;
    }
  };
  async function authorize(
    notice: KitchenPushNotice,
  ): Promise<DeskSnapshot | null> {
    try {
      const binding = parseDeskBinding(
        await ports.native.operatorState.get('active'),
      );
      if (
        binding.businessId !== notice.businessId ||
        binding.outletId !== notice.outletId
      )
        return null;
      const source = await ports.source();
      if (!source) return null;
      const fingerprint = await deskRegistrationFingerprint(source);
      const native = createDeskNativeScope(ports.native, binding, () => {});
      return await native.commit(async () => {
        const saved = await ports.cache.read(binding),
          profile = saved?.profile,
          subscription = profile?.subscription,
          now = (ports.now ?? Date.now)();
        if (
          !saved ||
          !profile?.enabled ||
          !subscription ||
          subscription.id !== notice.subscriptionId ||
          subscription.revokedAt !== null ||
          (subscription.expiresAt !== null && subscription.expiresAt <= now)
        )
          return null;
        const registration = (await ports.cache.operationHistory(binding)).find(
          (row) => row.id === profile.choiceRevision,
        );
        if (
          !registration ||
          !equal(registration.binding, binding) ||
          registration.selectionRevision !== saved.pointer.revision ||
          registration.request.kind !== 'register' ||
          registration.request.subscriptionId !== notice.subscriptionId ||
          registration.receipt?.action !== 'register' ||
          registration.request.subscriptionHash !==
            fingerprint.subscriptionHash ||
          registration.request.applicationKeyHash !==
            fingerprint.applicationKeyHash
        )
          return null;
        const task = profile.tasks.tasks.find(
          (row) => row.id === notice.taskId,
        );
        if (task && task.generation > notice.generation) return null;
        return saved;
      });
    } catch {
      return null;
    }
  }
  async function recheck() {
    for (const notification of await ports.notifications()) {
      try {
        const notice = parseKitchenPushNotice(notification.data);
        if (
          notification.tag === deskNoticeTag(ports.base, notice) &&
          !(await authorize(notice))
        )
          notification.close();
      } catch {
        /* Unrelated notifications belong to their own handler. */
      }
    }
  }
  return {
    async push(data: unknown) {
      let notice: KitchenPushNotice;
      try {
        notice = parseKitchenPushNotice(data);
      } catch {
        return;
      }
      if (!(await authorize(notice))) return;
      await ports.show('Mise needs your attention', {
        body: 'An order is waiting for the kitchen. Open Inbox to review.',
        tag: deskNoticeTag(ports.base, notice),
        data: notice,
      });
      // A newer local No or account switch can arrive during browser presentation.
      // Close its exact tag without touching another setup or newer generation.
      if (!(await authorize(notice))) {
        await recheck();
        return;
      }
      for (const client of await ports.windows())
        if (owned(client.url))
          client.postMessage({ type: 'MISE_DESK_REFRESH' });
    },
    async click(notification: DeskNotificationView) {
      notification.close();
      let notice: KitchenPushNotice;
      try {
        notice = parseKitchenPushNotice(notification.data);
      } catch {
        return;
      }
      if (
        notification.tag !== deskNoticeTag(ports.base, notice) ||
        !(await authorize(notice))
      )
        return;
      const clients = await ports.windows(),
        exact = clients.find((client) => client.url === target),
        client =
          exact ??
          clients.find((client) => owned(client.url) && client.navigate);
      if (!(await authorize(notice))) return;
      if (client) {
        if (!exact) await client.navigate?.(target);
        await client.focus();
        client.postMessage({ type: 'MISE_DESK_REFRESH' });
      } else await ports.open(target);
    },
    recheck,
  };
}
/** Both lists come from successful complete reads. Missing rows in a failed or
 * partial read never reach this function. Close only previously known tasks,
 * leaving a new push that has not been observed in a complete list intact. */
export async function closeResolvedDeskNotifications(
  base: string,
  previous: DeskSnapshot | null,
  next: DeskSnapshot,
  notifications: () => Promise<DeskNotificationView[]>,
) {
  if (
    !previous ||
    !equal(previous.pointer, next.pointer) ||
    !equal(previous.profile.binding, next.profile.binding) ||
    next.profile.tasks.version < previous.profile.tasks.version ||
    next.profile.tasks.at < previous.profile.tasks.at
  )
    return;
  const resolved = previous.profile.tasks.tasks.filter(
    (before) =>
      !next.profile.tasks.tasks.some(
        (after) =>
          after.id === before.id && after.generation === before.generation,
      ),
  );
  if (!resolved.length) return;
  for (const notification of await notifications()) {
    try {
      const notice = parseKitchenPushNotice(notification.data);
      if (
        notification.tag === deskNoticeTag(base, notice) &&
        notice.businessId === next.profile.binding.businessId &&
        notice.outletId === next.profile.binding.outletId &&
        resolved.some(
          (task) =>
            task.id === notice.taskId && task.generation === notice.generation,
        )
      )
        notification.close();
    } catch {
      /* Do not close another feature's notifications. */
    }
  }
}
