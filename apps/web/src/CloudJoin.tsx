import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {SavedShareNotice} from './SavedShareNotice';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { defaultMarket } from '@mise/core/packs';
import {
  cloudConnectionStorageKey,
  readCloudConnection,
  saveCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { JoinSessionError, parseJoinSession } from '@mise/core/join-session';
import type { OperatorContext, OperatorPosition } from '@mise/core/operators';
import { ConnectionForm, PhoneSignIn } from './CloudAuthForms';
import { db } from './data/db';
import {
  getPhoneAuth,
  forgetPhoneAuth,
  type PhoneAuth,
  type PhoneAuthState,
} from './data/phone-auth';
import { discoveryAuthScope } from './data/cloud-auth-scope';
import {
  discoverJoinOutlets,
  prepareCloudJoin,
  resumeCloudJoin,
  pauseCloudJoin,
  cancelCloudJoin,
  joinProblem,
  type JoinOptions,
} from './data/cloud-join';
import { backupFile, downloadFile } from './data/export-files';
import './cloud-setup.css';

const emptyAuth: PhoneAuthState = {
  phase: 'checking',
  phone: null,
  userId: null,
  message: '',
  busy: false,
  resendAt: 0,
  persistent: true,
};
export function CloudJoin({
  onBack,
  onJoined,
}: {
  onBack: () => void;
  onJoined: () => void;
}) {
  const [config, setConfig] = useState<CloudConnection | null>(null),
    [loaded, setLoaded] = useState(false),
    [version, setVersion] = useState(0),
    [editing, setEditing] = useState(false);
  const [manager, setManager] = useState<PhoneAuth | null>(null),
    [auth, setAuth] = useState(emptyAuth),
    [online, setOnline] = useState(navigator.onLine);
  const [choices, setChoices] = useState<OperatorContext[]>([]),
    [next, setNext] = useState<OperatorPosition | null>(null),
    [selected, setSelected] = useState(''),
    [searched, setSearched] = useState(false);
  const [working, setWorking] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const task = useRef<AbortController | null>(null),
    mounted = useRef(false),
    base = import.meta.env.BASE_URL;
  const snapshot = useLiveQuery(async () => {
    const raw = await db.joinSessions.get('active'),
      session = raw ? parseJoinSession(raw) : null;
    const [binding, read, images, outlet] = await Promise.all([
      db.cloudState.get('binding'),
      session ? db.syncReads.get(session.readId) : undefined,
      session
        ? db.syncImages.where('readId').equals(session.readId).count()
        : 0,
      session ? db.outlets.get(session.target.outletId) : undefined,
    ]);
    return { session, binding, read, images, outlet };
  });
  const session = snapshot?.session,
    active =
      session && session.phase !== 'cancelled' && session.phase !== 'ready',
    busy = working !== null || auth.busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      task.current?.abort();
    };
  }, []);
  useEffect(() => {
    const read = () => {
      try {
        setConfig(readCloudConnection(localStorage));
      } catch {
        setError('Review this device’s saved connection.');
      }
      setLoaded(true);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === cloudConnectionStorageKey) {
        task.current?.abort();
        read();
      }
    };
    const network = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) task.current?.abort();
    };
    read();
    window.addEventListener('storage', storage);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
    };
  }, []);
  useEffect(() => {
    let current = true,
      unsubscribe: (() => void) | undefined;
    setManager(null);
    setAuth(emptyAuth);
    setChoices([]);
    setSelected('');
    setSearched(false);
    setNext(null);
    if (config)
      void getPhoneAuth(config, discoveryAuthScope(base))
        .then((value) => {
          if (!current) return;
          setManager(value);
          const update = () => {
            if (current) {
              const state = value.getSnapshot();
              setAuth(state);
              if (['signed-out', 'offline', 'closed'].includes(state.phase))
                task.current?.abort();
            }
          };
          unsubscribe = value.subscribe(update);
          update();
        })
        .catch(() => {
          if (current)
            setError(
              'Phone sign-in could not open. Review the connection and try again.',
            );
        });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [config, base, version]);
  useEffect(() => {
    if (session?.phase === 'paused' || session?.phase === 'cancelled')
      task.current?.abort();
  }, [session?.phase]);
  useEffect(() => {
    if (session?.phase === 'ready') onJoined();
  }, [session?.phase, onJoined]);
  const options = (): JoinOptions => {
    if (!config || !manager) throw new JoinSessionError('auth');
    return {
      config,
      base,
      auth: manager,
      connectionCurrent: () => {
        try {
          return (
            JSON.stringify(readCloudConnection(localStorage)) ===
            JSON.stringify(config)
          );
        } catch {
          return false;
        }
      },
    };
  };
  async function run(
    name: string,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setWorking(name);
    setError('');
    setNotice('');
    try {
      await action(controller.signal);
    } catch (error) {
      if (mounted.current) {
        setError(
          error instanceof JoinSessionError
            ? error.message
            : new JoinSessionError(joinProblem(error)).message,
        );
      }
    } finally {
      if (task.current === controller) task.current = null;
      if (mounted.current) setWorking(null);
    }
  }
  const save = (value: CloudConnection) =>
    run('save', async () => {
      const saved = saveCloudConnection(localStorage, value);
      await forgetPhoneAuth();
      setConfig(saved);
      setEditing(false);
      setVersion((v) => v + 1);
    });
  const signOut = () =>
    run('sign-out', async () => {
      if (active) await pauseCloudJoin(db, session.readId, 'auth');
      await forgetPhoneAuth();
      setChoices([]);
      setSelected('');
      setSearched(false);
      setNext(null);
      setVersion((v) => v + 1);
    });
  const find = (more = false) =>
    run('find', async (signal) => {
      const page = await discoverJoinOutlets(
        options(),
        more ? next : null,
        signal,
      );
      if (signal.aborted) return;
      setChoices((previous) =>
        more ? [...previous, ...page.contexts] : page.contexts,
      );
      setNext(page.next);
      setSelected('');
      setSearched(true);
    });
  const join = () =>
    run('join', async (signal) => {
      if (!active) {
        const choice = choices.find(
          (c) => c.businessId + '/' + c.outletId === selected,
        );
        if (!choice) throw new JoinSessionError();
        await prepareCloudJoin(db, options(), choice, signal);
      }
      await resumeCloudJoin(db, options(), signal);
      if (!signal.aborted && mounted.current) onJoined();
    });
  async function stop() {
    task.current?.abort();
    try {
      if (session) await pauseCloudJoin(db, session.readId);
      setNotice('Download stopped. Your saved pages and images are kept.');
    } catch {
      setError(
        'The download stopped, but this browser could not save the pause. Keep your records and reload to resume.',
      );
    }
  }
  const leave = () =>
    run('leave', async () => {
      if (session && active) await cancelCloudJoin(db, session.readId);
      onBack();
    });
  const chooseAgain = () =>
    run('choose', async (signal) => {
      if (session && active) await cancelCloudJoin(db, session.readId);
      const page = await discoverJoinOutlets(options(), null, signal);
      setChoices(page.contexts);
      setNext(page.next);
      setSearched(true);
      setSelected('');
    });
  const backup = () =>
    run('backup', async () => {
      downloadFile(backupFile((await db.readPortableBackup()).portable));
      setNotice('Backup downloaded. Keep it somewhere safe.');
    });
  const selectedChoice = choices.find(
      (c) => c.businessId + '/' + c.outletId === selected,
    ),
    canRead = online && auth.phase === 'signed-in' && !busy;
  return (
    <main
      className="onboarding cloud-setup cloud-join"
      id="main"
      aria-busy={!loaded || !snapshot}
    >
      <a className="app-wordmark" href={base}>
        <img src={`${base}mise-mark.svg`} width="24" height="24" alt="" />
        mise
      </a>
      <header>
        <h1>Join an existing outlet</h1>
        <p>
          Use your verified phone to bring this outlet’s records onto this
          device.
        </p>
      </header>
      <SavedShareNotice purpose="join"/>
      {!online ? (
        <p className="cloud-preview-note" role="status">
          You’re offline. Connect to resume the saved download.
        </p>
      ) : null}
      <div className="cloud-setup-cards">
        <Card className="onboarding-card app-panel">
          <h2>Connection</h2>
          {!config || editing ? (
            <ConnectionForm
              key={JSON.stringify(config)}
              config={config}
              saving={busy}
              onSave={save}
              onCancel={config ? () => setEditing(false) : undefined}
            />
          ) : (
            <>
              <p>Connection saved on this device.</p>
              <p>The server’s private keys never belong here.</p>
              <footer>
                <Button
                  kind="secondary"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Edit connection
                </Button>
              </footer>
            </>
          )}
        </Card>
        <Card className="onboarding-card app-panel">
          <h2>Verify your phone</h2>
          {manager ? (
            <PhoneSignIn
              manager={manager}
              state={auth}
              market={defaultMarket(
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              )}
              online={online}
              onSignOut={signOut}
              saving={busy}
            />
          ) : (
            <p>
              {config
                ? 'Opening phone sign-in…'
                : 'Save the connection, then verify your phone.'}
            </p>
          )}
        </Card>
        <Card className="onboarding-card app-panel cloud-review">
          <h2>
            {active
              ? 'Bring your records onto this device'
              : 'Choose your outlet'}
          </h2>
          {active ? (
            <>
              <p>
                {snapshot?.outlet?.name ??
                  choices.find(
                    (choice) =>
                      choice.businessId === session.target.businessId &&
                      choice.outletId === session.target.outletId,
                  )?.outletName ??
                  'Your previously selected outlet'}{' '}
                · {session.target.role === 'owner' ? 'Owner' : 'Manager'}
              </p>
              <p>
                The original selection and download are saved. You can stop and
                resume without starting over.
              </p>
              <dl className="cloud-review-counts">
                <div>
                  <dt>Records saved</dt>
                  <dd>{snapshot?.read?.records ?? 0}</dd>
                </div>
                <div>
                  <dt>Images saved</dt>
                  <dd>{snapshot?.images ?? 0}</dd>
                </div>
                <div>
                  <dt>Download</dt>
                  <dd aria-live="polite" aria-atomic="true">
                    {working === 'join'
                      ? 'In progress'
                      : session.phase === 'paused'
                        ? 'Stopped'
                        : 'Ready to resume'}
                  </dd>
                </div>
              </dl>
              {session.problem ? (
                <p role="status">
                  {new JoinSessionError(session.problem).message}
                </p>
              ) : null}
              {snapshot?.binding ? (
                <p>
                  Your shop is downloaded. Finish this connection to open it.
                  Your records are kept if sign-in needs another check.
                </p>
              ) : null}
              <footer>
                {working === 'join' ? (
                  <Button kind="secondary" onClick={() => void stop()}>
                    Stop download
                  </Button>
                ) : (
                  <Button disabled={!canRead} onClick={() => void join()}>
                    Resume join
                  </Button>
                )}
                {!snapshot?.binding ? (
                  <Button
                    kind="ghost"
                    disabled={!canRead}
                    onClick={() => void chooseAgain()}
                  >
                    Check outlets again
                  </Button>
                ) : null}
                <Button
                  kind="ghost"
                  disabled={busy}
                  onClick={() => void backup()}
                >
                  Download a backup
                </Button>
              </footer>
            </>
          ) : (
            <>
              <p>
                Only outlets allowed for this phone appear here. Choose where
                you’ll work.
              </p>
              {choices.length ? (
                <fieldset className="business-choices">
                  <legend>Available outlets</legend>
                  {choices.map((choice) => {
                    const value = choice.businessId + '/' + choice.outletId;
                    return (
                      <label
                        className={`choice-card ${selected === value ? 'selected' : ''}`}
                        key={value}
                      >
                        <input
                          type="radio"
                          name="join-outlet"
                          value={value}
                          checked={selected === value}
                          disabled={busy}
                          onChange={() => setSelected(value)}
                        />
                        <span>
                          <strong>
                            {choice.outletName ?? 'Unnamed outlet'}
                          </strong>
                          <small>
                            {choice.businessName ?? 'Business'} ·{' '}
                            {choice.actorName ?? 'Member'} ·{' '}
                            {choice.role === 'owner' ? 'Owner' : 'Manager'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              ) : searched ? (
                <p>
                  No outlets are available for this phone. Ask the owner to
                  check your access, then check again.
                </p>
              ) : null}
              <footer>
                <Button
                  kind="secondary"
                  disabled={!canRead}
                  onClick={() => void find(false)}
                >
                  Find my outlets
                </Button>
                {next ? (
                  <Button
                    kind="secondary"
                    disabled={!canRead}
                    onClick={() => void find(true)}
                  >
                    More outlets
                  </Button>
                ) : null}
                {selectedChoice ? (
                  <Button disabled={!canRead} onClick={() => void join()}>
                    Join selected outlet
                  </Button>
                ) : null}
              </footer>
            </>
          )}
        </Card>
      </div>
      {error &&
      (!active ||
        !session.problem ||
        error !== new JoinSessionError(session.problem).message) ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="cloud-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!snapshot?.binding ? (
        <div className="onboarding-actions">
          <Button kind="ghost" disabled={busy} onClick={() => void leave()}>
            Back to local setup
          </Button>
        </div>
      ) : null}
    </main>
  );
}
