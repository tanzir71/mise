import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { deskProfileScope, type DeskSavedSetup } from './data/desk-cache';
import { createDeskRemote } from './data/desk-remote';
import { createDeskOwnerAccount } from './data/desk-owner-account';
import {
  createPhoneAuth,
  type PhoneAuth,
  type PhoneAuthState,
} from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import { deskCache } from './DeskNotificationsProvider';
import { PhoneSignIn } from './CloudAuthForms';
import './desk-notifications.css';
interface AuthView {
  id: string;
  scope: string;
  config: CloudConnection;
  manager: PhoneAuth;
  state: PhoneAuthState;
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'This removal is unconfirmed. Keep its saved original request and retry.';
export function DeskNotificationCleanup() {
  const saved = useLiveQuery(async () => {
      try {
        return { setups: await deskCache.savedSetups(), error: '' };
      } catch {
        return {
          setups: [],
          error:
            'The saved notification setups could not be read. Keep your shop records and reload to try again.',
        };
      }
    }, []),
    [chosen, setChosen] = useState(''),
    [auth, setAuth] = useState<AuthView | null>(null),
    [attempt, setAttempt] = useState(0),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(() => navigator.onLine),
    live = useRef(false),
    working = useRef(false);
  const selected = saved?.setups.find((value) => value.profileId === chosen),
    bindingToken = selected ? JSON.stringify(selected.binding) : '';
  useEffect(() => {
    live.current = true;
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      live.current = false;
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  useEffect(() => {
    let current = true,
      manager: PhoneAuth | undefined,
      unsubscribe: (() => void) | undefined;
    setAuth(null);
    setError('');
    if (!selected) return;
    let config: CloudConnection | null;
    try {
      config = readCloudConnection(localStorage);
    } catch (problem) {
      setError(message(problem));
      return;
    }
    if (!config) {
      setError(
        'Open Sync setup to restore the original connection before confirming removal. Disable here can still be saved offline.',
      );
      return;
    }
    const original = config;
    void resolveCloudAuthScope(
      original,
      import.meta.env.BASE_URL,
      selected.binding.businessId,
      selected.binding.connection.authKey,
    )
      .then(async (scope) => {
        if (!current) return;
        const client = await createPhoneAuth(original, scope, {
          storage: localStorage,
        });
        manager = client;
        if (!current) {
          await client.dispose();
          return;
        }
        const publish = () => {
          if (current)
            setAuth({
              id: selected.profileId,
              scope,
              config: original,
              manager: client,
              state: client.getSnapshot(),
            });
        };
        unsubscribe = client.subscribe(publish);
        publish();
        void client.check();
      })
      .catch((problem) => {
        if (current) setError(message(problem));
      });
    return () => {
      current = false;
      unsubscribe?.();
      void manager?.dispose();
    };
  }, [chosen, bindingToken, attempt]);
  async function run(work: () => Promise<void>, success: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
      if (live.current) setStatus(success);
    } catch (problem) {
      if (live.current) setError(message(problem));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function mute(source: DeskSavedSetup) {
    const profile = await deskCache.profileById(source.profileId);
    if (
      !profile ||
      profile.choiceRevision !== source.choiceRevision ||
      JSON.stringify(profile.binding) !== JSON.stringify(source.binding)
    )
      throw Error(
        'This setup changed. Review the current saved setup before disabling it.',
      );
    await deskCache.withdrawProfile(profile);
    navigator.serviceWorker?.controller?.postMessage({
      type: 'MISE_DESK_RECHECK',
    });
  }
  async function confirm(source: DeskSavedSetup) {
    const original = auth;
    if (!original || original.id !== source.profileId)
      throw Error('Sign in with the original phone for this setup.');
    const account = await createDeskOwnerAccount(
      original.config,
      original.scope,
      original.manager,
      source.binding,
      localStorage,
      () => live.current,
    );
    const rows = await deskCache.pendingWithdrawals(
      account.accountHash,
      account.targetHash,
    );
    for (const row of rows) {
      if (row.profileId !== source.profileId || row.request.kind !== 'revoke')
        continue;
      const remote = createDeskRemote(
          original.config,
          account,
          deskProfileScope(row.binding),
        ),
        proof = await remote.revoke(row.request.subscriptionId, row.id);
      await deskCache.confirmOperation(row, proof);
    }
  }
  return (
    <main className="desk-cleanup">
      <header className="app-page-heading">
        <div>
          <h1>Earlier notifications</h1>
          <p>
            Disable a saved setup on this browser, then confirm its removal with
            the original phone.
          </p>
        </div>
      </header>
      <p>Saved shop records and the currently selected outlet stay intact.</p>
      {!saved ? (
        <p aria-busy="true">Reading saved notification setups…</p>
      ) : saved.error ? (
        <p role="alert">{saved.error}</p>
      ) : !saved.setups.length ? (
        <Card className="desk-setting-card">
          <h2>No earlier setups</h2>
          <p>This browser has no saved desk notification setups.</p>
        </Card>
      ) : (
        <>
          <label className="desk-field">
            Saved setup
            <select
              disabled={busy}
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
                setStatus('');
              }}
            >
              <option value="">Choose a setup</option>
              {saved.setups.map((row, index) => (
                <option key={row.profileId} value={row.profileId}>
                  Setup {index + 1} ·{' '}
                  {row.pendingWithdrawals
                    ? `${row.pendingWithdrawals} removal${row.pendingWithdrawals === 1 ? '' : 's'} saved`
                    : row.openSetups
                      ? 'not removed'
                      : 'disabled'}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <Card className="desk-setting-card">
              <h2>Disable this setup</h2>
              <p>
                This works offline and keeps the original removal requests for
                retry.
              </p>
              <Button
                kind="secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => mute(selected),
                    'Disabled here. Original removals are saved for the original account.',
                  )
                }
              >
                Disable saved setup here
              </Button>
              {selected.pendingWithdrawals ? (
                <p>
                  {selected.pendingWithdrawals} original removal
                  {selected.pendingWithdrawals === 1 ? ' is' : 's are'} awaiting
                  confirmation.
                </p>
              ) : (
                <p>
                  {selected.openSetups
                    ? 'Confirm removal after disabling this setup.'
                    : 'No removal is awaiting confirmation.'}
                </p>
              )}
              {auth?.id === selected.profileId ? (
                <>
                  <PhoneSignIn
                    manager={auth.manager}
                    state={auth.state}
                    market="BD"
                    online={online}
                    saving={busy}
                    onSignOut={async () => {
                      try {
                        await auth.manager.close();
                      } finally {
                        setAttempt((value) => value + 1);
                      }
                    }}
                  />
                  <Button
                    disabled={
                      busy ||
                      !online ||
                      auth.state.phase !== 'signed-in' ||
                      !selected.pendingWithdrawals
                    }
                    onClick={() =>
                      void run(
                        () => confirm(selected),
                        'Original removals confirmed.',
                      )
                    }
                  >
                    Confirm original removals
                  </Button>
                </>
              ) : (
                <p>Opening the original phone sign-in…</p>
              )}
            </Card>
          ) : null}
        </>
      )}
      {status ? <p role="status">{status}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="desk-setting-links">
        <Link to="/settings/notifications">Notification settings</Link>
        <Link to="/">Back to Mise</Link>
      </div>
    </main>
  );
}
