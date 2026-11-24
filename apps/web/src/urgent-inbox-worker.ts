import {
  parseUrgentInboxNotice,
  type UrgentInboxNotice,
} from '@mise/core/urgent-inbox';
import { createDeskNativeScope } from './data/desk-native';
import { parseDeskBinding } from './data/desk-cache';
import { deskRegistrationFingerprint } from './data/desk-operation';
import {
  createUrgentInboxCache,
  urgentInboxBaseRegistration,
  urgentInboxProfileMatches,
} from './data/urgent-inbox-cache';
import { urgentEqual } from './data/urgent-inbox-operation';
import type {
  DeskWorkerPorts,
  DeskNotificationView,
} from './desk-notification-worker';

export function urgentInboxNoticeTag(
  base: string,
  input: UrgentInboxNotice,
): string {
  const notice = parseUrgentInboxNotice(input);
  return (
    'mise.urgent.inbox:' +
    base +
    ':' +
    notice.consentId +
    ':' +
    notice.taskId +
    ':' +
    notice.generation
  );
}
/** Closed routing metadata only. The app must authenticate and fetch the actual
 * task before showing it. A notification cannot choose a URL or execute work. */
export function urgentInboxNoticePath(
  base: string,
  input: UrgentInboxNotice,
): string {
  const notice = parseUrgentInboxNotice(input);
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
    throw Error('Use the installed app path.');
  return base + 'inbox?urgent=' + encodeURIComponent(JSON.stringify(notice));
}
export function createUrgentInboxWorker(ports: DeskWorkerPorts) {
  const root = new URL(ports.base, ports.origin),
    journal = createUrgentInboxCache(ports.cache);
  if (
    !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(ports.base) ||
    root.origin !== ports.origin ||
    root.pathname !== ports.base ||
    root.search ||
    root.hash ||
    !root.pathname.endsWith('/')
  )
    throw Error('Use the installed app scope.');
  const owned = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.origin === root.origin && url.pathname.startsWith(root.pathname)
      );
    } catch {
      return false;
    }
  };
  async function authorize(notice: UrgentInboxNotice) {
    try {
      const binding = parseDeskBinding(
        await ports.native.operatorState.get('active'),
      );
      if (
        binding.businessId !== notice.businessId ||
        binding.outletId !== notice.outletId
      )
        return false;
      const source = await ports.source();
      if (!source) return false;
      const fingerprint = await deskRegistrationFingerprint(source),
        native = createDeskNativeScope(ports.native, binding, () => {}),
        cache = ports.cache;
      return await native.commit(() =>
        cache.transaction(
          'r',
          [
            cache.active,
            cache.profiles,
            cache.operations,
            cache.urgentProfiles,
            cache.urgentOperations,
          ],
          async () => {
            const saved = await journal.read(binding),
              profile = saved?.profile;
            if (
              !saved ||
              !profile?.enabled ||
              !profile.consent ||
              profile.consent.revokedAt !== null ||
              !urgentInboxProfileMatches(profile, saved.desk) ||
              profile.consent.id !== notice.consentId ||
              profile.subscriptionId !== notice.subscriptionId
            )
              return false;
            const base = await urgentInboxBaseRegistration(
              cache,
              saved.desk,
              (ports.now ?? Date.now)(),
            );
            if (
              base.request.subscriptionId !== notice.subscriptionId ||
              base.request.subscriptionHash !== fingerprint.subscriptionHash ||
              base.request.applicationKeyHash !== fingerprint.applicationKeyHash
            )
              return false;
            const all = await journal.history(binding),
              original = all.find((row) => row.id === profile.choiceRevision);
            return (
              !!original &&
              urgentEqual(original.binding, binding) &&
              original.selectionRevision === saved.desk.pointer.revision &&
              original.baseChoiceRevision ===
                saved.desk.profile.choiceRevision &&
              original.request.kind === 'register' &&
              original.request.consentId === notice.consentId &&
              original.request.subscriptionId === notice.subscriptionId &&
              original.receipt?.action === 'register' &&
              urgentEqual(
                original.receipt.registration.consent,
                profile.consent,
              ) &&
              !all.some(
                (row) =>
                  row.request.kind === 'withdraw' &&
                  row.request.consentId === notice.consentId,
              )
            );
          },
        ),
      );
    } catch {
      return false;
    }
  }
  async function recheck() {
    for (const notification of await ports.notifications()) {
      try {
        const notice = parseUrgentInboxNotice(notification.data);
        if (
          notification.tag === urgentInboxNoticeTag(ports.base, notice) &&
          !(await authorize(notice))
        )
          notification.close();
      } catch {
        /* Another handler owns unrelated notifications. */
      }
    }
  }
  return {
    async push(input: unknown) {
      let notice: UrgentInboxNotice;
      try {
        notice = parseUrgentInboxNotice(input);
      } catch {
        return;
      }
      if (!(await authorize(notice))) return;
      await ports.show('Mise needs your attention', {
        body: 'An urgent item is waiting. Open Inbox to review.',
        tag: urgentInboxNoticeTag(ports.base, notice),
        data: notice,
      });
      if (!(await authorize(notice))) {
        await recheck();
        return;
      }
      for (const client of await ports.windows())
        if (owned(client.url))
          client.postMessage({ type: 'MISE_DESK_REFRESH' });
    },
    async click(notification: DeskNotificationView) {
      let notice: UrgentInboxNotice;
      try {
        notice = parseUrgentInboxNotice(notification.data);
      } catch {
        return;
      }
      if (notification.tag !== urgentInboxNoticeTag(ports.base, notice)) return;
      notification.close();
      if (!(await authorize(notice))) return;
      const target = new URL(urgentInboxNoticePath(ports.base, notice), root)
          .href,
        clients = await ports.windows(),
        exact = clients.find((client) => client.url === target),
        client =
          exact ?? clients.find((value) => owned(value.url) && value.navigate);
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
