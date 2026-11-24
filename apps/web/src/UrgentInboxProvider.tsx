import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DeskBinding, DeskCache } from './data/desk-cache';
import {
  createUrgentInboxCache,
  urgentInboxProfileMatches,
} from './data/urgent-inbox-cache';
import type { UrgentInboxSession } from './data/urgent-inbox-session';
import { CommandRequestError } from './data/command-request';
import {
  UrgentInboxContext,
  type UrgentInboxView,
} from './urgent-inbox-context';

export function recheckUrgentNotifications() {
  navigator.serviceWorker?.controller?.postMessage({
    type: 'MISE_DESK_RECHECK',
  });
}
const problemText = (value: unknown) =>
  value instanceof Error
    ? value.message
    : 'This alert choice is unconfirmed. Keep its original request and retry.';
export function UrgentInboxProvider({
  cache,
  binding,
  session,
  online,
  permission,
  disableLocal,
  children,
}: {
  cache: DeskCache;
  binding: DeskBinding | null;
  session: UrgentInboxSession | null;
  online: boolean;
  permission: NotificationPermission | 'unsupported';
  disableLocal: () => Promise<void>;
  children: ReactNode;
}) {
  const token = JSON.stringify(binding),
    journal = useMemo(() => createUrgentInboxCache(cache), [cache]),
    latest = useRef({ token, session, online, disableLocal }),
    [failure, setFailure] = useState<{ token: string; text: string } | null>(
      null,
    );
  latest.current = { token, session, online, disableLocal };
  const saved = useLiveQuery(async () => {
    try {
      const snapshot = binding ? await journal.read(binding) : null,
        rows = binding ? await journal.history(binding) : [],
        closed = new Set(
          rows
            .filter((row) => row.request.kind === 'withdraw')
            .map((row) => row.request.consentId),
        ),
        pending = rows.filter(
          (row) =>
            !row.receipt &&
            (row.request.kind === 'withdraw' ||
              !closed.has(row.request.consentId)),
        );
      return {
        token,
        snapshot,
        pending: pending.length,
        registerPending: pending.some(
          (row) =>
            row.request.kind === 'register' &&
            JSON.stringify(row.binding) === token,
        ),
        error: '',
      };
    } catch {
      return {
        token,
        snapshot: null,
        pending: 0,
        registerPending: false,
        error:
          'The saved alert choice could not be read. Keep this browser’s original requests and reload.',
      };
    }
  }, [journal, token]);
  const snapshot = saved?.token === token ? saved.snapshot : null,
    effective =
      !!snapshot?.profile?.enabled &&
      snapshot.desk.profile.enabled &&
      permission === 'granted' &&
      urgentInboxProfileMatches(snapshot.profile, snapshot.desk),
    error =
      (saved?.token === token && saved.error) ||
      (failure?.token === token && failure.text) ||
      '';
  function fail(value: unknown, original: UrgentInboxSession) {
    if (latest.current.session === original)
      setFailure({ token: latest.current.token, text: problemText(value) });
  }
  useEffect(() => {
    if (!session) return;
    let active = true,
      running = false;
    const drain = async () => {
      if (
        !active ||
        running ||
        !navigator.onLine ||
        document.visibilityState === 'hidden'
      )
        return;
      running = true;
      try {
        await session.drain();
        if (active) setFailure(null);
      } catch (value) {
        if (active) fail(value, session);
      } finally {
        running = false;
        if (active) recheckUrgentNotifications();
      }
    };
    void drain();
    const timer = setInterval(() => void drain(), 10000),
      wake = () => void drain();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [session]);
  function ready() {
    const current = latest.current;
    if (current.token !== token || !session || current.session !== session)
      throw new CommandRequestError('auth');
    return session;
  }
  async function enable() {
    const original = ready();
    if (!snapshot) throw new CommandRequestError('review');
    const row = await original.enable(snapshot);
    recheckUrgentNotifications();
    await original.drain();
    if (
      !(await journal.history(original.binding)).find(
        (value) => value.id === row.id,
      )?.receipt
    )
      throw new CommandRequestError('retry');
    const confirmed = await journal.read(original.binding);
    if (
      latest.current.session !== original ||
      !confirmed?.profile?.enabled ||
      confirmed.profile.choiceRevision !== row.id ||
      !urgentInboxProfileMatches(confirmed.profile, confirmed.desk)
    )
      throw new CommandRequestError('review');
    recheckUrgentNotifications();
  }
  async function disable() {
    if (latest.current.token !== token) throw new CommandRequestError('review');
    await disableLocal();
    recheckUrgentNotifications();
    setFailure(null);
    const original = latest.current.session;
    if (original && latest.current.online)
      void original
        .cleanup()
        .then(recheckUrgentNotifications)
        .catch((value) => fail(value, original));
  }
  async function retry() {
    const original = ready();
    await original.cleanup();
    for (const row of await journal.pendingRegistrations(original.binding))
      await original.inspect(row);
    await original.drain();
    if (latest.current.session === original) setFailure(null);
    recheckUrgentNotifications();
  }
  const view: UrgentInboxView = {
    scopeKey: token,
    snapshot,
    session,
    online,
    effective,
    canEnable:
      !!session &&
      online &&
      permission === 'granted' &&
      !!snapshot?.desk.profile.enabled &&
      !effective &&
      !saved?.registerPending,
    pending: saved?.token === token ? saved.pending : 0,
    registerPending: (saved?.token === token && saved.registerPending) || false,
    error,
    enable,
    disable,
    retry,
  };
  return (
    <UrgentInboxContext.Provider value={view}>
      {children}
    </UrgentInboxContext.Provider>
  );
}
