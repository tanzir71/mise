import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import type { SetupSnapshot } from '@mise/core/models';
import {
  parseDeskBinding,
  DeskCache,
  type DeskBinding,
} from './data/desk-cache';
import { createDeskNativeScope } from './data/desk-native';
import { createDeskSession, type DeskSession } from './data/desk-session';
import { createDeskOwnerAccount } from './data/desk-owner-account';
import {
  createDeskBrowserPush,
  type DeskBrowserPush,
} from './data/desk-browser-push';
import {
  getPhoneAuth,
  type PhoneAuth,
  type PhoneAuthState,
} from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import { CommandRequestError } from './data/command-request';
import { db } from './data/db';
import {
  DeskNotificationsContext,
  type DeskNotificationsView,
} from './desk-context';
import type { DeskAlarmSettings } from '@mise/core/desk-tasks';
import { closeResolvedDeskNotifications } from './desk-notification-worker';
import {
  createUrgentInboxSession,
  type UrgentInboxSession,
} from './data/urgent-inbox-session';
import {
  createUrgentInboxCache,
  parseUrgentInboxProfile,
} from './data/urgent-inbox-cache';
import {
  urgentInboxProfileId,
  parseUrgentInboxOperation,
} from './data/urgent-inbox-operation';
import { UrgentInboxProvider } from './UrgentInboxProvider';
import { useOwnerTasksEnabled } from './owner-tasks-context';
import './desk-notifications.css';

/** One browser-owned cache; ordinary route changes never close its database or
 * retire an opted-in desk. A real native selection change retires presentation. */
export const deskCache = new DeskCache(import.meta.env.BASE_URL);
function recheckNotifications() {
  navigator.serviceWorker?.controller?.postMessage({
    type: 'MISE_DESK_RECHECK',
  });
}
async function refreshDesk(session: DeskSession) {
  const previous = await deskCache.read(session.binding),
    next = await session.refresh();
  try {
    const registration = await navigator.serviceWorker?.getRegistration(
      import.meta.env.BASE_URL,
    );
    if (
      registration?.scope ===
      new URL(import.meta.env.BASE_URL, location.origin).href
    )
      await closeResolvedDeskNotifications(
        import.meta.env.BASE_URL,
        previous,
        next,
        () => registration.getNotifications(),
      );
  } catch {
    /* Closing a browser notice cannot undo a complete task read. */
  }
  return next;
}
const text = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'This step is unconfirmed. Keep the saved action and try again.';
function connectionToken() {
  try {
    return JSON.stringify(readCloudConnection(localStorage));
  } catch {
    return '!';
  }
}
interface AuthView {
  binding: string;
  config: string;
  scope: string;
  manager: PhoneAuth;
  state: PhoneAuthState;
}
interface Runtime {
  binding: string;
  config: string;
  userId: string | null;
  session: DeskSession;
  urgent: UrgentInboxSession | null;
  key: string | null;
}
export function DeskNotificationsProvider({
  setup,
  children,
}: {
  setup: SetupSnapshot;
  children: ReactNode;
}) {
  const urgentEnabled = useOwnerTasksEnabled();
  const selected = useLiveQuery(() => db.operatorState.get('active'), []),
    [configToken, setConfigToken] = useState(connectionToken),
    [online, setOnline] = useState(() => navigator.onLine),
    [auth, setAuth] = useState<AuthView | null>(null),
    [runtime, setRuntime] = useState<Runtime | null>(null),
    [port, setPort] = useState<DeskBrowserPush | null>(null),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [deliveryError, setDeliveryError] = useState(''),
    [readFresh, setReadFresh] = useState('');
  let bindingToken = '';
  try {
    const source = parseDeskBinding(selected);
    if (
      source.businessId === setup.business.id &&
      source.outletId === setup.outlet.id &&
      source.actorId === setup.owner.id &&
      source.role === setup.owner.role
    )
      bindingToken = JSON.stringify(source);
  } catch {
    /* Unconnected/locked selections cannot activate notifications. */
  }
  const binding = useMemo<DeskBinding | null>(
      () => (bindingToken ? parseDeskBinding(JSON.parse(bindingToken)) : null),
      [bindingToken],
    ),
    config = useMemo<CloudConnection | null>(
      () =>
        configToken === '!' || configToken === 'null'
          ? null
          : JSON.parse(configToken),
      [configToken],
    );
  const latest = useRef({ binding: bindingToken, config: configToken, port });
  latest.current = { binding: bindingToken, config: configToken, port };
  const cached = useLiveQuery(async () => {
    try {
      return {
        binding: bindingToken,
        snapshot: binding ? await deskCache.read(binding) : null,
        error: '',
      };
    } catch {
      return {
        binding: bindingToken,
        snapshot: null,
        error:
          'The saved notification setup could not be read. Keep your shop records and try again.',
      };
    }
  }, [bindingToken]);
  const pending = useLiveQuery(async () => {
    const rows = binding ? await deskCache.pendingOperations(binding) : [];
    return {
      binding: bindingToken,
      count: rows.length,
      register: rows.some(
        (row) =>
          row.request.kind === 'register' &&
          JSON.stringify(row.binding) === bindingToken,
      ),
    };
  }, [bindingToken]);
  const snapshot =
      cached?.binding === bindingToken &&
      cached.snapshot &&
      JSON.stringify(cached.snapshot.profile.binding) === bindingToken
        ? cached.snapshot
        : null,
    previous = useRef<typeof snapshot>(null);
  if (snapshot) previous.current = snapshot;
  useEffect(() => {
    const changed = () => {
      setConfigToken(connectionToken());
      setOnline(navigator.onLine);
      if (!navigator.onLine) setReadFresh('');
    };
    window.addEventListener('storage', changed);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    window.addEventListener('focus', changed);
    const timer = setInterval(changed, 2000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', changed);
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
      window.removeEventListener('focus', changed);
    };
  }, []);
  useEffect(() => {
    const before = previous.current;
    if (!before || JSON.stringify(before.profile.binding) === bindingToken)
      return;
    previous.current = null;
    void deskCache
      .retire(before.pointer)
      .then(recheckNotifications)
      .catch(() => {
        /* A newer active pointer wins. */
      });
  }, [bindingToken]);
  useEffect(() => {
    let current = true;
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.ready
      .then((registration) => {
        if (!current) return;
        try {
          setPort(
            createDeskBrowserPush(
              registration,
              location.origin,
              import.meta.env.BASE_URL,
            ),
          );
        } catch {
          setPort(null);
        }
      })
      .catch(() => {
        if (current) setPort(null);
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true,
      unsubscribe: (() => void) | undefined;
    setAuth(null);
    if (!binding || !config) return;
    void resolveCloudAuthScope(
      config,
      import.meta.env.BASE_URL,
      binding.businessId,
      binding.connection.authKey,
    )
      .then((scope) =>
        current
          ? getPhoneAuth(config, scope).then((manager) => ({ manager, scope }))
          : null,
      )
      .then((value) => {
        if (!current || !value) return;
        const publish = () => {
          if (current)
            setAuth({
              binding: bindingToken,
              config: configToken,
              scope: value.scope,
              manager: value.manager,
              state: value.manager.getSnapshot(),
            });
        };
        unsubscribe = value.manager.subscribe(publish);
        publish();
        void value.manager.check();
      })
      .catch((problem) => {
        if (current) setError(text(problem));
      });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [bindingToken, configToken]);
  const phase = auth?.state.phase,
    userId = auth?.state.userId,
    manager = auth?.manager,
    scope = auth?.scope;
  useEffect(() => {
    if (!manager) return;
    const check = () => {
      void manager.check();
    };
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    return () => {
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
    };
  }, [manager]);
  useEffect(() => {
    let current = true;
    setRuntime(null);
    setReadFresh('');
    setError('');
    setReadError('');
    setDeliveryError('');
    if (
      !binding ||
      !config ||
      !auth ||
      auth.binding !== bindingToken ||
      auth.config !== configToken ||
      phase !== 'signed-in'
    )
      return;
    const check = () => {
      if (
        !current ||
        latest.current.binding !== bindingToken ||
        latest.current.config !== configToken ||
        connectionToken() !== configToken
      )
        throw new CommandRequestError('auth');
    };
    void createDeskOwnerAccount(
      config,
      auth.scope,
      auth.manager,
      binding,
      localStorage,
      () => current,
    )
      .then((account) => {
        check();
        const native = createDeskNativeScope(db, binding, check),
          session = createDeskSession({
            cache: deskCache,
            native,
            account,
            config,
            check,
            subscription: () =>
              latest.current.port?.read() ?? Promise.resolve(null),
          }),
          ready: Runtime = {
            binding: bindingToken,
            config: configToken,
            userId: auth.state.userId,
            session,
            urgent: urgentEnabled
              ? createUrgentInboxSession({
                  cache: deskCache,
                  native,
                  account,
                  config,
                  check,
                  subscription: () =>
                    latest.current.port?.read() ?? Promise.resolve(null),
                })
              : null,
            key: null,
          };
        setRuntime(ready);
        void session
          .configuration()
          .then((value) => {
            check();
            setRuntime((valueBefore) =>
              valueBefore?.session === session
                ? { ...valueBefore, key: value.applicationKey }
                : valueBefore,
            );
          })
          .catch((problem) => {
            if (current) setError(text(problem));
          });
      })
      .catch((problem) => {
        if (current) setError(text(problem));
      });
    return () => {
      current = false;
    };
  }, [bindingToken, configToken, manager, scope, phase, userId, urgentEnabled]);
  const activeRuntime =
    runtime?.binding === bindingToken &&
    runtime.config === configToken &&
    runtime.userId === userId &&
    phase === 'signed-in'
      ? runtime
      : null;
  useEffect(() => {
    if (!activeRuntime) return;
    const session = activeRuntime.session;
    let current = true,
      reading = false,
      readAgain = false,
      delivering = false,
      readTimer: ReturnType<typeof setTimeout> | undefined,
      deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!current) return;
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        if (navigator.onLine && document.visibilityState !== 'hidden') {
          await refreshDesk(session);
          if (current) {
            setReadFresh(bindingToken);
            setReadError('');
          }
        }
      } catch (problem) {
        if (current) {
          setReadFresh('');
          setReadError(text(problem));
        }
      } finally {
        reading = false;
        if (current) {
          const delay = readAgain ? 0 : 5000;
          readAgain = false;
          readTimer = setTimeout(() => void read(), delay);
        }
      }
    };
    const deliver = async () => {
      if (!current || delivering) return;
      delivering = true;
      try {
        if (navigator.onLine && document.visibilityState !== 'hidden') {
          await session.drain();
          if (current) setDeliveryError('');
        }
      } catch (problem) {
        if (current) setDeliveryError(text(problem));
      } finally {
        delivering = false;
        if (current) deliveryTimer = setTimeout(() => void deliver(), 10000);
      }
    };
    const wake = () => {
      if (readTimer) clearTimeout(readTimer);
      if (deliveryTimer) clearTimeout(deliveryTimer);
      void read();
      void deliver();
    };
    wake();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    navigator.serviceWorker?.addEventListener('message', wake);
    return () => {
      current = false;
      if (readTimer) clearTimeout(readTimer);
      if (deliveryTimer) clearTimeout(deliveryTimer);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      navigator.serviceWorker?.removeEventListener('message', wake);
    };
  }, [activeRuntime?.session, bindingToken]);
  function ready() {
    if (!binding || !activeRuntime) throw new CommandRequestError('auth');
    return activeRuntime;
  }
  async function confirmOwn(operation: { id: string }, session: DeskSession) {
    let problem: unknown;
    try {
      await session.drain();
    } catch (error) {
      problem = error;
    }
    const row = (await deskCache.operationHistory(session.binding)).find(
      (row) => row.id === operation.id,
    );
    if (!row?.receipt) throw problem ?? new CommandRequestError('retry');
    await refreshDesk(session).catch(() => {
      setReadFresh('');
    });
  }
  function enable() {
    const current = ready();
    if (!snapshot || !port || !current.key)
      throw new CommandRequestError('review');
    const original = snapshot,
      key = current.key,
      browser = port;
    return current.session
      .enable(original, (save, authorize) =>
        browser.enable(key, authorize, save),
      )
      .then((operation) => confirmOwn(operation, current.session));
  }
  async function disable() {
    if (!binding || !snapshot) throw new CommandRequestError('review');
    const original = snapshot,
      source = bindingToken,
      connection = configToken,
      native = createDeskNativeScope(db, binding, () => {
        if (
          latest.current.binding !== source ||
          latest.current.config !== connection
        )
          throw new CommandRequestError('review');
      });
    await native.commit((guard) =>
      deskCache.transaction(
        'rw',
        [
          deskCache.active,
          deskCache.profiles,
          deskCache.operations,
          deskCache.urgentProfiles,
          deskCache.urgentOperations,
        ],
        async () => {
          const id = urgentInboxProfileId(binding),
            [profile, operations] = await Promise.all([
              deskCache.urgentProfiles.get(id),
              deskCache.urgentOperations
                .where('profileId')
                .equals(id)
                .toArray(),
            ]);
          let readable = true;
          try {
            if (profile !== undefined) parseUrgentInboxProfile(profile);
            operations.map(parseUrgentInboxOperation);
          } catch {
            readable = false;
          }
          const urgent = createUrgentInboxCache(deskCache),
            saved = readable ? await urgent.read(binding) : null;
          if (saved) await urgent.disable(saved, guard);
          // Retain unreadable urgent originals. The healthy base No still
          // blocks both handlers and its revoke invalidates that capability.
          await deskCache.disable(original, guard);
        },
      ),
    );
    recheckNotifications();
    if (activeRuntime && navigator.onLine) {
      await activeRuntime.session.cleanup();
      await activeRuntime.urgent?.cleanup();
    }
  }
  async function disableUrgentLocal() {
    if (!binding) throw new CommandRequestError('review');
    const source = bindingToken,
      connection = configToken,
      native = createDeskNativeScope(db, binding, () => {
        if (
          latest.current.binding !== source ||
          latest.current.config !== connection ||
          connectionToken() !== connection
        )
          throw new CommandRequestError('review');
      }),
      journal = createUrgentInboxCache(deskCache);
    await native.commit(async (guard) => {
      const saved = await journal.read(binding);
      if (!saved) throw new CommandRequestError('review');
      await journal.disable(saved, guard);
    });
    recheckNotifications();
  }
  async function retry() {
    const current = ready();
    const configuration = current.session
      .configuration()
      .then((value) =>
        setRuntime((previous) =>
          previous?.session === current.session
            ? { ...previous, key: value.applicationKey }
            : previous,
        ),
      );
    await Promise.all([
      refreshDesk(current.session),
      current.session.drain(),
      configuration,
    ]);
  }
  async function saveSettings(value: DeskAlarmSettings) {
    const current = ready(),
      operation = await current.session.settings(value);
    await confirmOwn(operation, current.session);
  }
  const view: DeskNotificationsView = {
    snapshot,
    online,
    fresh: !!bindingToken && online && readFresh === bindingToken,
    loading: !!binding && cached?.binding !== bindingToken,
    error:
      (cached?.binding === bindingToken ? cached.error : '') ||
      error ||
      deliveryError ||
      readError,
    permission: port?.permission() ?? 'unsupported',
    canEnable:
      !!activeRuntime?.key &&
      !!port &&
      port.permission() !== 'denied' &&
      online &&
      !!snapshot,
    canSave: !!activeRuntime && online && !!snapshot,
    pending: pending?.binding === bindingToken ? pending.count : 0,
    registerPending: pending?.binding === bindingToken && pending.register,
    enable,
    disable,
    retry,
    saveSettings,
  };
  return (
    <DeskNotificationsContext.Provider value={view}>
      {urgentEnabled ? (
        <UrgentInboxProvider
          cache={deskCache}
          binding={binding}
          session={activeRuntime?.urgent ?? null}
          online={online}
          permission={view.permission}
          disableLocal={disableUrgentLocal}
        >
          {children}
        </UrgentInboxProvider>
      ) : (
        children
      )}
    </DeskNotificationsContext.Provider>
  );
}
