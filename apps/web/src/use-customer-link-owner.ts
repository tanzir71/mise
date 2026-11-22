import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  cloudConnectionStorageKey,
  cloudConnectionTarget,
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { operatorAccountHash } from '@mise/core/operators';
import type { SetupSnapshot } from '@mise/core/models';
import type { CustomerLinkKind } from '@mise/core/customer-links';
import type { CustomerLinkPage } from '@mise/core/customer-link-admin';
import { db } from './data/db';
import { getPhoneAuth } from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import {
  CommandRequestError,
  type CommandAccount,
} from './data/command-request';
import {
  createCustomerLinkSession,
  type CustomerLinkSession,
} from './data/customer-link-session';
export interface CustomerLinkOwner {
  session: CustomerLinkSession;
  config: CloudConnection;
  active: boolean;
  ticket: string;
  signal: AbortSignal;
  page: CustomerLinkPage;
}
const identity = (s: SetupSnapshot) =>
  [s.business.id, s.outlet.id, s.owner.id, s.owner.role].join(':');
export function useCustomerLinkOwner(
  setup: SetupSnapshot,
  kind: CustomerLinkKind,
  resourceId: string,
  online: boolean,
) {
  const selection = useLiveQuery(() => db.operatorState.get('active')),
    selectionToken = JSON.stringify(selection ?? null),
    context = identity(setup);
  const [config, setConfig] = useState<CloudConnection | null>(null),
    [ready, setReady] = useState<CustomerLinkOwner | null>(null),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0),
    [checking, setChecking] = useState(true);
  const holder = useRef<CustomerLinkOwner | null>(null);
  holder.current = ready;
  const ticket = JSON.stringify([
    config,
    context,
    selectionToken,
    kind,
    resourceId,
    version,
    online,
  ]);
  useEffect(() => {
    const read = () => {
      try {
        setConfig(readCloudConnection(localStorage));
      } catch {
        setConfig(null);
        setError('Review this browser’s connection in Sync setup.');
      }
    };
    read();
    const changed = (e: StorageEvent) => {
      if (
        e.key === null ||
        e.key === cloudConnectionStorageKey ||
        e.key.startsWith('mise.cloud.auth.')
      ) {
        if (holder.current) {
          holder.current.active = false;
          holder.current.session.forget();
        }
        setReady(null);
        read();
        setVersion((v) => v + 1);
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    let current = true,
      owned: CustomerLinkOwner | null = null,
      unsubscribe: (() => void) | undefined;
    const controller = new AbortController();
    setReady(null);
    setError('');
    setChecking(true);
    const cleanup = () => {
      current = false;
      controller.abort();
      unsubscribe?.();
      if (owned) {
        owned.active = false;
        owned.session.forget();
      }
    };
    if (
      !config ||
      !online ||
      !['owner', 'manager'].includes(setup.owner.role)
    ) {
      setChecking(false);
      return cleanup;
    }
    const originalConfig = config,
      originalSelection = selectionToken,
      originalContext = context;
    const assertLocal = async () => {
      if (
        !current ||
        JSON.stringify(readCloudConnection(localStorage)) !==
          JSON.stringify(originalConfig)
      )
        throw new CommandRequestError('auth');
      const [fresh, selected] = await Promise.all([
        db.setup(),
        db.operatorState.get('active'),
      ]);
      if (
        !current ||
        !fresh ||
        identity(fresh) !== originalContext ||
        JSON.stringify(selected ?? null) !== originalSelection
      )
        throw new CommandRequestError('review');
      const resource =
        kind === 'order'
          ? await db.orders.get(resourceId)
          : await db.creditAccounts.get(resourceId);
      if (!current || !resource || resource.outletId !== setup.outlet.id)
        throw new CommandRequestError('review');
    };
    void (async () => {
      const scope = await resolveCloudAuthScope(
          originalConfig,
          import.meta.env.BASE_URL,
          setup.business.id,
          selection?.connection?.authKey,
        ),
        manager = await getPhoneAuth(originalConfig, scope);
      if (!current) return;
      const original = await manager.commandAuthorization();
      await assertLocal();
      const [accountHash, targetHash] = await Promise.all([
        operatorAccountHash(original.userId),
        cloudConnectionTarget(originalConfig, scope, original.userId),
      ]);
      if (
        selection?.connection &&
        (selection.connection.authKey !== manager.key ||
          selection.connection.accountHash !== accountHash ||
          selection.connection.targetHash !== targetHash)
      )
        throw new CommandRequestError('auth');
      const assertCurrent: CommandAccount['assertCurrent'] = (auth) => {
        if (
          !current ||
          (owned && !owned.active) ||
          auth.userId !== original.userId ||
          auth.generation !== original.generation ||
          JSON.stringify(readCloudConnection(localStorage)) !==
            JSON.stringify(originalConfig)
        )
          throw new CommandRequestError('auth');
        manager.assertCommandAuthorization(auth);
      };
      const account: CommandAccount = {
        scope,
        accountHash,
        targetHash,
        getAuth: async () => {
          await assertLocal();
          const auth = await manager.commandAuthorization();
          assertCurrent(auth);
          return auth;
        },
        assertCurrent,
      };
      const session = createCustomerLinkSession(
        originalConfig,
        account,
        {
          businessId: setup.business.id,
          outletId: setup.outlet.id,
          actorId: setup.owner.id,
          kind,
          resourceId,
        },
        {
          storage: localStorage,
          assertScope: async () => {
            await assertLocal();
            assertCurrent(await manager.commandAuthorization());
          },
        },
      );
      const page = await session.page(null, 50, controller.signal);
      if (!current) return;
      if (page.actorRole !== setup.owner.role)
        throw new CommandRequestError('review');
      session.saved();
      owned = {
        session,
        config: originalConfig,
        active: true,
        ticket,
        signal: controller.signal,
        page,
      };
      setReady(owned);
      unsubscribe = manager.subscribe(() => {
        const state = manager.getSnapshot();
        if (
          current &&
          (state.phase === 'signed-out' ||
            state.phase === 'closed' ||
            state.phase === 'code' ||
            (state.userId && state.userId !== original.userId))
        ) {
          if (owned) {
            owned.active = false;
            owned.session.forget();
          }
          setReady(null);
          setError(
            'Phone sign-in changed. Refresh access with the original account.',
          );
        }
      });
    })()
      .catch((e) => {
        if (current)
          setError(
            e instanceof CommandRequestError && e.kind === 'auth'
              ? 'Sign in with the original phone account in Sync setup.'
              : 'Sync this record first, then refresh access with its owner or assigned manager.',
          );
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return cleanup;
  }, [ticket]);
  return {
    ready: ready?.ticket === ticket && ready.active ? ready : null,
    checking,
    error,
    configured: config !== null,
    refresh: () => setVersion((v) => v + 1),
  };
}
