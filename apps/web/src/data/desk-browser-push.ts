import {
  parseDeskApplicationKey,
  parseDeskPushSubscription,
} from '@mise/core/desk-push';
import type { DeskBrowserSource } from './desk-session';

export interface DeskPushSubscriptionView {
  endpoint: string;
  expirationTime: number | null;
  options: { applicationServerKey: ArrayBuffer | null };
  getKey: (name: PushEncryptionKeyName) => ArrayBuffer | null;
  unsubscribe: () => Promise<boolean>;
}
export interface DeskPushRegistration {
  scope: string;
  pushManager: {
    getSubscription: () => Promise<DeskPushSubscriptionView | null>;
    subscribe: (
      options: PushSubscriptionOptionsInit,
    ) => Promise<DeskPushSubscriptionView>;
  };
}
export interface DeskPushEnvironment {
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  locked: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}
export class DeskPushProblem extends Error {
  constructor(readonly kind: 'unsupported' | 'denied' | 'changed') {
    super(
      kind === 'unsupported'
        ? 'Notifications are unavailable in this browser. You can still use Inbox.'
        : kind === 'denied'
          ? 'Notifications are blocked for Mise. You can still use Inbox and change permission in your browser settings.'
          : 'This notification setup changed. Keep the saved action, disable that setup and enable a new one.',
    );
  }
}
export function browserPushEnvironment(): DeskPushEnvironment | null {
  if (
    !globalThis.isSecureContext ||
    typeof Notification === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.locks?.request ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in globalThis)
  )
    return null;
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async locked<T>(name: string, work: () => Promise<T>): Promise<T> {
      return await navigator.locks.request(name, () => work());
    },
  };
}
function encode(buffer: ArrayBuffer | null): string {
  if (!buffer) throw new DeskPushProblem('changed');
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(
      parseDeskApplicationKey(key).replaceAll('-', '+').replaceAll('_', '/'),
    ),
    (c) => c.charCodeAt(0),
  );
}
export function deskPushSource(
  subscription: DeskPushSubscriptionView,
): DeskBrowserSource {
  return {
    applicationKey: parseDeskApplicationKey(
      encode(subscription.options.applicationServerKey),
    ),
    subscription: parseDeskPushSubscription({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: {
        p256dh: encode(subscription.getKey('p256dh')),
        auth: encode(subscription.getKey('auth')),
      },
    }),
  };
}
/** Permission starts directly in the explicit click. Browser subscription
 * replacement and its durable journal commit share an origin-wide Web Lock. */
export function createDeskBrowserPush(
  registration: DeskPushRegistration,
  origin: string,
  base: string,
  environment: DeskPushEnvironment | null = browserPushEnvironment(),
) {
  const url = new URL(base, origin),
    expected = new URL(origin);
  if (
    !environment ||
    expected.origin !== origin ||
    url.origin !== origin ||
    url.pathname !== base ||
    url.search ||
    url.hash ||
    !base.startsWith('/') ||
    !base.endsWith('/') ||
    registration.scope !== url.href
  )
    throw new DeskPushProblem('unsupported');
  const lock = 'mise.desk.push:' + base,
    platform = environment;
  const checkScope = () => {
    if (registration.scope !== url.href) throw new DeskPushProblem('changed');
  };
  return {
    permission: () => platform.permission(),
    async read() {
      checkScope();
      if (platform.permission() !== 'granted') return null;
      return platform.locked(lock, async () => {
        checkScope();
        const current = await registration.pushManager.getSubscription();
        checkScope();
        return current ? deskPushSource(current) : null;
      });
    },
    enable<T>(
      value: string,
      authorize: () => Promise<void>,
      save: (source: DeskBrowserSource) => Promise<T>,
    ): Promise<T> {
      const key = parseDeskApplicationKey(value);
      checkScope();
      if (platform.permission() === 'denied')
        return Promise.reject(new DeskPushProblem('denied'));
      // No awaited registration lookup, Auth request or native read precedes this
      // permission request; its user activation comes from the Enable button.
      const permission =
        platform.permission() === 'granted'
          ? Promise.resolve('granted' as const)
          : platform.requestPermission();
      return permission.then(async (result) => {
        if (result !== 'granted') throw new DeskPushProblem('denied');
        await authorize();
        return platform.locked(lock, async () => {
          checkScope();
          await authorize();
          const old = await registration.pushManager.getSubscription();
          await authorize();
          // Each explicit replacement gets a fresh browser capability. An earlier
          // account's endpoint is never reassigned to the newly selected account.
          if (old) {
            if (!(await old.unsubscribe()))
              throw new DeskPushProblem('changed');
            await authorize();
          }
          const created = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key),
          });
          checkScope();
          await authorize();
          const source = deskPushSource(created);
          if (source.applicationKey !== key)
            throw new DeskPushProblem('changed');
          return save(source);
        });
      });
    },
  };
}
export type DeskBrowserPush = ReturnType<typeof createDeskBrowserPush>;
