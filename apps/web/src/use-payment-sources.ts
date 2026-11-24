import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { readCloudConnection } from '@mise/core/cloud-connection';
import type { SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import { getPhoneAuth } from './data/phone-auth';
import { CommandRequestError } from './data/command-request';
import { createOwnerTaskAccount } from './data/owner-task-account';
import {
  createPaymentSourceSession,
  type PaymentSourceSession,
} from './data/payment-source-session';
const identity = (s: SetupSnapshot) =>
  [s.business.id, s.outlet.id, s.owner.id, s.owner.role].join(':');
export interface PaymentSources {
  session: PaymentSourceSession;
  signal: AbortSignal;
  active: () => boolean;
  ticket: string;
}
export function usePaymentSources(setup: SetupSnapshot) {
  const selection = useLiveQuery(() => db.operatorState.get('active')),
    selectionToken = JSON.stringify(selection ?? null),
    localScope = identity(setup),
    [version, setVersion] = useState(0),
    [ready, setReady] = useState<PaymentSources | null>(null),
    [error, setError] = useState(''),
    [checking, setChecking] = useState(false),
    ticket = JSON.stringify([localScope, selectionToken, version]);
  useEffect(() => {
    const changed = () => setVersion((v) => v + 1);
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    let active = true,
      session: PaymentSourceSession | undefined,
      unsubscribe: (() => void) | undefined;
    const controller = new AbortController();
    setReady(null);
    setError('');
    setChecking(true);
    const stop = () => {
      active = false;
      controller.abort();
      session?.stop();
      unsubscribe?.();
    };
    if (!['owner', 'manager'].includes(setup.owner.role)) {
      setChecking(false);
      setError('Ask the owner or assigned manager to open Inbox.');
      return stop;
    }
    void (async () => {
      const config = readCloudConnection(localStorage);
      if (!config) throw new CommandRequestError('auth');
      const check = () => {
        if (
          !active ||
          JSON.stringify(readCloudConnection(localStorage)) !==
            JSON.stringify(config)
        )
          throw new CommandRequestError('auth');
      };
      const assertLocal = async () => {
        check();
        const [fresh, selected] = await Promise.all([
          db.setup(),
          db.operatorState.get('active'),
        ]);
        check();
        if (
          !fresh ||
          identity(fresh) !== localScope ||
          JSON.stringify(selected ?? null) !== selectionToken
        )
          throw new CommandRequestError('review');
      };
      await assertLocal();
      const authScope = await resolveCloudAuthScope(
          config,
          import.meta.env.BASE_URL,
          setup.business.id,
          selection?.connection?.authKey,
        ),
        manager = await getPhoneAuth(config, authScope);
      await assertLocal();
      const { account, assertDraftAccount } = await createOwnerTaskAccount(
        config,
        authScope,
        manager,
        selection?.connection ?? null,
        check,
      );
      await assertLocal();
      session = createPaymentSourceSession(
        config,
        account,
        {
          v: 1,
          businessId: setup.business.id,
          outletId: setup.outlet.id,
          memberId: setup.owner.id,
          role: setup.owner.role as 'owner' | 'manager',
        },
        { storage: localStorage, assertScope: assertLocal, assertDraftAccount },
      );
      session.saved();
      if (!active) return;
      setReady({
        session,
        signal: controller.signal,
        active: () => active,
        ticket,
      });
      unsubscribe = manager.subscribe(() => {
        try {
          assertDraftAccount();
        } catch {
          if (active) {
            stop();
            setReady(null);
            setChecking(false);
            setError(
              'The phone account changed. Open saved requests with the original account.',
            );
          }
        }
      });
    })()
      .catch(() => {
        if (active)
          setError(
            'Configure this installation in Sync setup and use its original owner or assigned manager account. Saved requests are kept on this device.',
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return stop;
  }, [ticket]);
  return {
    ready: ready?.ticket === ticket && ready.active() ? ready : null,
    error,
    checking,
    refresh: () => setVersion((v) => v + 1),
  };
}
