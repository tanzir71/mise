import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import type { CloudConnection } from '@mise/core/cloud-connection';
import { deskCache } from './DeskNotificationsProvider';
import {
  createUrgentInboxCache,
  type UrgentInboxProfile,
} from './data/urgent-inbox-cache';
import {
  readUrgentRecoveryConnection,
  saveUrgentRecoveryConnection,
  openUrgentRecoveryAuth,
  openUrgentRecovery,
} from './data/urgent-inbox-recovery';
import type { PhoneAuth, PhoneAuthState } from './data/phone-auth';
import { ConnectionForm, PhoneSignIn } from './CloudAuthForms';
import { recheckUrgentNotifications } from './UrgentInboxProvider';
const journal = createUrgentInboxCache(deskCache);
const problemText = (value: unknown) =>
  value instanceof Error
    ? value.message
    : 'Keep the original alert choice and retry its check.';
export function UrgentInboxCleanup() {
  const saved = useLiveQuery(async () => {
      try {
        return { setups: await journal.savedSetups(), error: '' };
      } catch {
        return {
          setups: [],
          error:
            'The saved alert setups could not be read. Keep this browser’s original records and reload.',
        };
      }
    }, []),
    [chosen, setChosen] = useState(''),
    [config, setConfig] = useState<CloudConnection | null>(() => {
      try {
        return readUrgentRecoveryConnection(localStorage);
      } catch {
        return null;
      }
    }),
    [editing, setEditing] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [separate, setSeparate] = useState(false),
    [attempt, setAttempt] = useState(0),
    [auth, setAuth] = useState<{
      id: string;
      manager: PhoneAuth;
      state: PhoneAuthState;
      borrowed: boolean;
    } | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    live = useRef(false),
    running = useRef(false),
    latest = useRef({ chosen, config });
  latest.current = { chosen, config };
  const selected = saved?.setups.find((row) => row.profile.id === chosen),
    binding = JSON.stringify(selected?.profile.binding ?? null);
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
    let active = true,
      manager: PhoneAuth | undefined,
      unsubscribe: (() => void) | undefined;
    setAuth(null);
    setError('');
    if (!selected || !config) return;
    void openUrgentRecoveryAuth(
      config,
      import.meta.env.BASE_URL,
      selected.profile,
      { storage: localStorage, separate },
    )
      .then((value) => {
        manager = value.manager;
        if (!active) {
          void manager.dispose();
          return;
        }
        const publish = () => {
          if (active)
            setAuth({
              id: chosen,
              manager: value.manager,
              state: value.manager.getSnapshot(),
              borrowed: value.borrowed,
            });
        };
        unsubscribe = manager.subscribe(publish);
        publish();
        void manager.check();
      })
      .catch((value) => {
        if (active) setError(problemText(value));
      });
    return () => {
      active = false;
      unsubscribe?.();
      void manager?.dispose();
    };
  }, [chosen, binding, config, separate, attempt]);
  async function work(kind: string, run: () => Promise<void>, success: string) {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    setError('');
    setMessage('');
    const source = chosen;
    try {
      await run();
      if (live.current && latest.current.chosen === source) setMessage(success);
    } catch (value) {
      if (live.current && latest.current.chosen === source)
        setError(problemText(value));
    } finally {
      running.current = false;
      if (live.current) setBusy('');
    }
  }
  function check() {
    if (
      !live.current ||
      latest.current.chosen !== chosen ||
      latest.current.config !== config
    )
      throw Error(
        'This recovery selection changed. Keep its original requests.',
      );
  }
  async function mute(profile: UrgentInboxProfile) {
    await journal.withdrawProfile(profile, check);
    recheckUrgentNotifications();
  }
  async function recover(kind: 'inspect' | 'withdraw') {
    check();
    if (!selected || !config || !auth || auth.id !== chosen)
      throw Error('Use the original phone account for this setup.');
    const recovery = await openUrgentRecovery(
      config,
      import.meta.env.BASE_URL,
      selected.profile,
      auth.manager,
      deskCache,
      { storage: localStorage, check },
    );
    await recovery[kind]();
    check();
    recheckUrgentNotifications();
  }
  async function copy(profile: UrgentInboxProfile) {
    check();
    const raw = JSON.stringify(
      { v: 1, profile, operations: await journal.history(profile.binding) },
      null,
      2,
    );
    check();
    const url = URL.createObjectURL(
        new Blob([raw], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    try {
      link.href = url;
      link.download = 'mise-alert-originals.json';
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
  return (
    <main className="desk-cleanup">
      <header className="app-page-heading">
        <div>
          <h1>Earlier urgent alerts</h1>
          <p>
            Turn off a saved setup here, then confirm its original removals with
            its own phone account.
          </p>
        </div>
      </header>
      <p>This keeps the current outlet, member and shop records unchanged.</p>
      {!saved ? (
        <p aria-busy="true">Reading saved alert setups…</p>
      ) : saved.error ? (
        <p role="alert">{saved.error}</p>
      ) : !saved.setups.length ? (
        <Card className="desk-setting-card">
          <h2>No earlier urgent alert setups</h2>
          <p>This browser has no saved general alert choices.</p>
        </Card>
      ) : (
        <>
          <label className="desk-field">
            Saved alert setup
            <select
              value={chosen}
              disabled={!!busy}
              onChange={(event) => {
                setChosen(event.target.value);
                setSeparate(false);
                setMessage('');
              }}
            >
              <option value="">Choose a setup</option>
              {saved.setups.map((row, index) => (
                <option key={row.profile.id} value={row.profile.id}>
                  Setup {index + 1} ·{' '}
                  {row.pendingWithdrawals
                    ? `${row.pendingWithdrawals} removals saved`
                    : row.openSetups
                      ? 'not removed'
                      : 'off'}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <Card className="desk-setting-card">
              <h2>This saved setup</h2>
              <p>
                {selected.pendingWithdrawals
                  ? `${selected.pendingWithdrawals} original removals await confirmation.`
                  : selected.openSetups
                    ? 'Turn off here before confirming removal.'
                    : 'No removal awaits confirmation.'}
              </p>
              <Button
                kind="secondary"
                disabled={!!busy}
                onClick={() =>
                  void work(
                    'off',
                    () => mute(selected.profile),
                    'Off here. Original removals are retained for confirmation.',
                  )
                }
              >
                Turn off saved urgent alerts
              </Button>
              <Button
                kind="secondary"
                disabled={!!busy}
                onClick={() =>
                  void work(
                    'copy',
                    () => copy(selected.profile),
                    'A private copy was offered for download. No original was removed.',
                  )
                }
              >
                Save private original copy
              </Button>
              {auth?.id === chosen ? (
                <>
                  {auth.borrowed ? (
                    <>
                      <p>
                        Using the matching original phone account already saved
                        on this device.
                      </p>
                      <Button
                        kind="ghost"
                        disabled={!!busy}
                        onClick={() => setSeparate(true)}
                      >
                        Use a separate recovery sign-in
                      </Button>
                    </>
                  ) : (
                    <PhoneSignIn
                      manager={auth.manager}
                      state={auth.state}
                      market="BD"
                      online={online}
                      saving={!!busy}
                      onSignOut={async () => {
                        await auth.manager.close();
                        setAttempt((value) => value + 1);
                      }}
                    />
                  )}
                  <div className="desk-actions">
                    <Button
                      kind="secondary"
                      disabled={
                        !!busy ||
                        !online ||
                        !['signed-in', 'offline'].includes(auth.state.phase)
                      }
                      onClick={() =>
                        void work(
                          'inspect',
                          () => recover('inspect'),
                          'Original registration results checked. This did not enable alerts.',
                        )
                      }
                    >
                      Check original registration results
                    </Button>
                    <Button
                      disabled={
                        !!busy ||
                        !online ||
                        !selected.pendingWithdrawals ||
                        !['signed-in', 'offline'].includes(auth.state.phase)
                      }
                      onClick={() =>
                        void work(
                          'withdraw',
                          () => recover('withdraw'),
                          'Original alert removals confirmed.',
                        )
                      }
                    >
                      Confirm original alert removals
                    </Button>
                  </div>
                </>
              ) : (
                <p>
                  Open the original installation connection and phone account to
                  confirm removal. Turn off and the private copy work offline.
                </p>
              )}
            </Card>
          ) : null}
        </>
      )}
      {editing ? (
        <Card className="desk-setting-card">
          <h2>Original installation connection</h2>
          <ConnectionForm
            config={config}
            saving={!!busy}
            onSave={async (value) => {
              const next = saveUrgentRecoveryConnection(localStorage, value);
              setConfig(next);
              setEditing(false);
              setAttempt((value) => value + 1);
            }}
            onCancel={() => setEditing(false)}
          />
        </Card>
      ) : (
        <Button
          kind="secondary"
          disabled={!!busy}
          onClick={() => setEditing(true)}
        >
          Choose recovery connection
        </Button>
      )}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="desk-setting-links">
        <Link to="/settings/notifications">Notification settings</Link>
        <Link to="/inbox">Open Inbox</Link>
        <Link to="/">Today on this device</Link>
      </div>
    </main>
  );
}
