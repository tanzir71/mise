import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import type { CloudConnection } from '@mise/core/cloud-connection';
import { ownerTaskText } from '@mise/core/owner-tasks';
const choiceLabels = {
  allow: 'Allow',
  no: 'No',
  'reply-myself': 'Reply myself',
  sent: 'I sent it',
  fixed: 'It’s fixed',
  reopen: 'Reopen',
  undo: 'Undo last choice',
};
import { ConnectionForm, PhoneSignIn } from './CloudAuthForms';
import {
  listOwnerTaskLocators,
  ownerTaskJournalMaximum,
  type OwnerTaskLocator,
  type SavedOwnerTask,
} from './data/owner-task-journal';
import {
  openOwnerTaskRecoveryAuth,
  openOwnerTaskRecovery,
  readOwnerTaskRecoveryConnection,
  saveOwnerTaskRecoveryConnection,
  type OwnerTaskRecovery as Recovery,
} from './data/owner-task-recovery';
import type { PhoneAuth, PhoneAuthState } from './data/phone-auth';
import type { OwnerTaskFile } from './data/owner-task-archive';
import {
  listPaymentSourceLocators,
  type SavedPaymentSource,
} from './data/payment-source-journal';
import {
  openPaymentSourceRecoveryAuth,
  openPaymentSourceRecovery,
  readPaymentSourceRecoveryConnection,
  savePaymentSourceRecoveryConnection,
  type PaymentSourceRecovery,
} from './data/payment-source-recovery';
import { PaymentRequestSource } from './PaymentRequestSource';
import './owner-tasks.css';
type RecoveryKind = 'task' | 'payment';
type AnyRecovery = Recovery | PaymentSourceRecovery;
const recoveryTools = (kind: RecoveryKind) =>
  kind === 'task'
    ? {
        list: listOwnerTaskLocators,
        readConnection: readOwnerTaskRecoveryConnection,
        saveConnection: saveOwnerTaskRecoveryConnection,
        openAuth: openOwnerTaskRecoveryAuth,
        open: openOwnerTaskRecovery,
      }
    : {
        list: listPaymentSourceLocators,
        readConnection: readPaymentSourceRecoveryConnection,
        saveConnection: savePaymentSourceRecoveryConnection,
        openAuth: openPaymentSourceRecoveryAuth,
        open: openPaymentSourceRecovery,
      };
import './owner-task-recovery.css';

const base = import.meta.env.BASE_URL;
const kept =
  'Keep this browser’s original requests. Check the original phone account and shop connection, then try again.';
function savedAccount(manager: PhoneAuth): string {
  try {
    return manager.journalIdentity().userId;
  } catch {
    return 'unavailable';
  }
}
interface Selection {
  groups: OwnerTaskLocator[];
  unreadable: number;
  config: CloudConnection | null;
  error: string;
}
function selection(kind: RecoveryKind): Selection {
  try {
    return {
      ...recoveryTools(kind).list(localStorage),
      config: recoveryTools(kind).readConnection(localStorage),
      error: '',
    };
  } catch {
    return {
      groups: [],
      unreadable: 0,
      config: null,
      error:
        'Saved request groups or the recovery connection could not be read. Their original data is retained.',
    };
  }
}
export function OwnerTaskRecovery({
  kind = 'task',
}: { kind?: RecoveryKind } = {}) {
  const [view, setView] = useState(() => selection(kind)),
    [chosen, setChosen] = useState(''),
    [attempt, setAttempt] = useState(0),
    [connection, setConnection] = useState(false),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const refresh = () => {
    setChosen('');
    setView(selection(kind));
    setAttempt((v) => v + 1);
    setError('');
  };
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key.startsWith(
          kind === 'task' ? 'mise.owner-tasks.' : 'mise.payment-sources.',
        ) ||
        event.key === 'mise.cloud.connection.v1'
      )
        refresh();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const group = view.groups.find((row) => row.key === chosen),
    config = view.config;
  async function save(value: CloudConnection) {
    setSaving(true);
    setError('');
    try {
      recoveryTools(kind).saveConnection(localStorage, value);
      refresh();
      setConnection(false);
    } catch {
      setError(
        'The original shop connection could not be saved. Your requests remain on this device.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="owner-tasks owner-task-recovery">
      <header className="owner-task-heading">
        <div>
          <p className="eyebrow">MISE · THIS BROWSER</p>
          <h1>
            {kind === 'task' ? 'Saved task requests' : 'Saved payment requests'}
          </h1>
          <p>
            Review originals from any outlet, including one you can no longer
            open.
          </p>
        </div>
        <div>
          <Link to="/inbox" className="button button-secondary">
            Back to Inbox
          </Link>
          <Link
            to={
              kind === 'task'
                ? '/settings/payments/recovery'
                : '/settings/tasks/recovery'
            }
          >
            {kind === 'task' ? 'Saved payment requests' : 'Saved task requests'}
          </Link>
          <Button kind="secondary" onClick={refresh}>
            Refresh saved groups
          </Button>
        </div>
      </header>
      <Card className="owner-task-original">
        <h2>Original shop connection</h2>
        <p>
          Use the connection supplied by that shop’s installer. Recovery
          settings and sign-in are separate from the selected operator.
        </p>
        {connection || !config ? (
          <ConnectionForm
            config={config}
            saving={saving}
            onSave={save}
            onCancel={config ? () => setConnection(false) : undefined}
          />
        ) : (
          <Button
            kind="secondary"
            onClick={() => {
              setChosen('');
              setConnection(true);
            }}
          >
            Change recovery connection
          </Button>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </Card>
      {view.error ? (
        <p role="alert" className="owner-task-error">
          {view.error}
        </p>
      ) : null}
      {view.unreadable ? (
        <p role="alert">
          {view.unreadable} saved group{view.unreadable === 1 ? '' : 's'} could
          not be read. Keep this browser’s data; no originals were removed.
        </p>
      ) : null}
      <div className="owner-task-field">
        <label htmlFor="owner-task-saved-group">
          Saved group on this device
        </label>
        <select
          id="owner-task-saved-group"
          value={chosen}
          disabled={!config || connection}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">Choose a saved group</option>
          {view.groups.map((row, n) => (
            <option key={row.key} value={row.key}>
              Saved group {n + 1}
            </option>
          ))}
        </select>
      </div>
      {!view.error && !view.groups.length ? (
        <p>
          {kind === 'task'
            ? 'No task requests are saved in this browser.'
            : 'No payment requests are saved in this browser.'}
        </p>
      ) : null}
      {group && config && !connection ? (
        <RecoveryGroup
          key={chosen + attempt}
          locator={group}
          config={config}
          kind={kind}
        />
      ) : (
        <p>
          Choose a group, then use its original phone account to open the saved
          source. This does not switch your operator.
        </p>
      )}
    </main>
  );
}
function RecoveryGroup({
  locator,
  config,
  kind,
}: {
  locator: OwnerTaskLocator;
  config: CloudConnection;
  kind: RecoveryKind;
}) {
  const [auth, setAuth] = useState<{
      manager: PhoneAuth;
      borrowed: boolean;
      state: PhoneAuthState;
      ticket: number;
    } | null>(null),
    [separate, setSeparate] = useState(false),
    [attempt, setAttempt] = useState(0),
    [error, setError] = useState(''),
    [online, setOnline] = useState(navigator.onLine);
  const generation = useRef(0);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    let alive = true,
      manager: PhoneAuth | undefined,
      unsubscribe: (() => void) | undefined;
    const ticket = ++generation.current;
    setAuth(null);
    setError('');
    void recoveryTools(kind)
      .openAuth(config, base, locator.key, {
        storage: localStorage,
        separate,
      })
      .then((opened) => {
        manager = opened.manager;
        if (!alive) {
          void manager.dispose().catch(() => {});
          return;
        }
        const update = () => {
          if (alive)
            setAuth({ ...opened, ticket, state: opened.manager.getSnapshot() });
        };
        unsubscribe = manager.subscribe(update);
        update();
        void manager.check();
      })
      .catch(() => {
        if (alive) setError(kept);
      });
    return () => {
      alive = false;
      unsubscribe?.();
      void manager?.dispose().catch(() => {});
    };
  }, [locator.key, config, separate, attempt]);
  async function forget() {
    if (!auth || auth.borrowed) return;
    setError('');
    try {
      await auth.manager.close();
      setAttempt((v) => v + 1);
    } catch {
      setError(
        'The recovery sign-in could not be removed. Try sign-out again. Saved requests are retained.',
      );
    }
  }
  return (
    <section aria-label="Original account recovery">
      <Card className="owner-task-original">
        <h2>Original phone account</h2>
        {auth?.borrowed ? (
          <>
            <p>
              Using the saved original sign-in. Its requests remain available
              offline; checking a result requires a connection.
            </p>
            <Button kind="secondary" onClick={() => setSeparate(true)}>
              Use a separate recovery sign-in
            </Button>
          </>
        ) : auth ? (
          <>
            <p>Include your country code, such as +880 for Bangladesh.</p>
            <PhoneSignIn
              manager={auth.manager}
              state={auth.state}
              market="OTHER"
              online={online}
              saving={false}
              onSignOut={forget}
            />
          </>
        ) : (
          <p role="status">Opening the original sign-in…</p>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </Card>
      {auth ? (
        <RecoveryHistory
          key={auth.ticket + auth.manager.key + savedAccount(auth.manager)}
          manager={auth.manager}
          locator={locator}
          config={config}
          kind={kind}
        />
      ) : null}
    </section>
  );
}
function RecoveryHistory({
  manager,
  locator,
  config,
  kind,
}: {
  manager: PhoneAuth;
  locator: OwnerTaskLocator;
  config: CloudConnection;
  kind: RecoveryKind;
}) {
  const [session, setSession] = useState<AnyRecovery | null>(null),
    [rows, setRows] = useState<(SavedOwnerTask | SavedPaymentSource)[] | null>(
      null,
    ),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [plan, setPlan] = useState<OwnerTaskFile | null>(null),
    [verified, setVerified] = useState(false);
  const running = useRef(false),
    active = useRef(false);
  useEffect(() => {
    let alive = true,
      opened: AnyRecovery | null = null,
      unsubscribe: (() => void) | undefined;
    active.current = true;
    setSession(null);
    setRows(null);
    setPlan(null);
    setVerified(false);
    setError('');
    const check = () => {
      if (
        !alive ||
        JSON.stringify(recoveryTools(kind).readConnection(localStorage)) !==
          JSON.stringify(config)
      )
        throw Error('changed recovery connection');
    };
    const fail = () => {
      if (alive) {
        opened?.stop();
        setSession(null);
        setRows(null);
        setPlan(null);
        setVerified(false);
        setError(kept);
      }
    };
    void recoveryTools(kind)
      .open(config, base, locator.key, manager, {
        storage: localStorage,
        assertLocal: check,
      })
      .then((value) => {
        opened = value;
        if (!alive) {
          value?.stop();
          return;
        }
        if (!value) {
          setRows([]);
          return;
        }
        unsubscribe = value.subscribe(() => {
          try {
            setRows(value.saved().actions);
          } catch {
            fail();
          }
        });
        setRows(value.saved().actions);
        setSession(value);
      })
      .catch(fail);
    const timer = setInterval(() => {
      if (opened) void opened.assertCurrent().catch(fail);
    }, 1000);
    return () => {
      alive = false;
      active.current = false;
      clearInterval(timer);
      unsubscribe?.();
      opened?.stop();
    };
  }, [manager, locator.key, config]);
  async function work(run: (s: AnyRecovery) => Promise<void>) {
    if (running.current || !session) return;
    running.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await run(session);
    } catch {
      if (active.current) setError('This step is unconfirmed. ' + kept);
    } finally {
      running.current = false;
      if (active.current) {
        try {
          setRows(session.saved().actions);
        } catch {
          setRows(null);
          setSession(null);
          setPlan(null);
          setVerified(false);
        }
        setBusy(false);
      }
    }
  }
  async function download(s: AnyRecovery, file: OwnerTaskFile) {
    await s.assertCurrent();
    s.assertFile(file);
    const url = URL.createObjectURL(
      new Blob([file.contents], { type: 'application/json' }),
    );
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const last = rows?.at(-1),
    pending = !!last && (!last.receipt || last.receipt.state === 'pending'),
    completed = (rows?.length ?? 0) - (pending ? 1 : 0);
  return (
    <div className="owner-task-history">
      {error ? (
        <p role="alert" className="owner-task-error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {rows ? (
        <>
          <p>
            {rows.length} saved original{rows.length === 1 ? '' : 's'} ·{' '}
            {pending ? '1 unconfirmed' : 'All completed'}
          </p>
          {session && rows.length ? (
            <div className="owner-task-actions">
              <Button
                kind="secondary"
                disabled={busy}
                onClick={() =>
                  void work(async (s) => {
                    await download(s, await s.copy());
                    if (active.current)
                      setMessage(
                        'Copy prepared. Check that your browser saved the file; every original remains here.',
                      );
                  })
                }
              >
                Save full private copy
              </Button>
              <Button
                kind="secondary"
                disabled={busy || !completed}
                onClick={() =>
                  void work(async (s) => {
                    const file = await s.prepareArchive();
                    await download(s, file);
                    if (active.current) {
                      setPlan(file);
                      setVerified(false);
                      setMessage(
                        'Archive prepared. Select the saved file below to verify it before removing completed copies.',
                      );
                    }
                  })
                }
              >
                Save completed archive
              </Button>
            </div>
          ) : null}
          {plan ? (
            <Card className="owner-task-original">
              <h2>Verify your saved archive</h2>
              <p>
                The archive contains complete private sources and recorded
                choices. Keep it somewhere private. Pending requests stay on
                this device.
              </p>
              <p>
                {plan.count} completed original{plan.count === 1 ? '' : 's'} ·{' '}
                {plan.filename}
              </p>
              <label className="owner-task-field">
                Select the saved archive file
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    setVerified(false);
                    if (!file) return;
                    void work(async (s) => {
                      if (file.size > ownerTaskJournalMaximum + 4096)
                        throw Error('large file');
                      await s.verifyArchiveFile(
                        plan,
                        new Uint8Array(await file.arrayBuffer()),
                      );
                      if (active.current) {
                        setVerified(true);
                        setMessage(
                          'The saved file matches every completed original.',
                        );
                      }
                    });
                  }}
                />
              </label>
              <div className="owner-task-actions">
                <Button
                  disabled={busy || !verified}
                  onClick={() =>
                    void work(async (s) => {
                      const result = await s.finishArchive(plan, true);
                      if (active.current) {
                        setPlan(null);
                        setVerified(false);
                        setMessage(
                          `${result.removed} completed copies removed from this device. ${result.retained} original request${result.retained === 1 ? '' : 's'} retained. Shop tasks and server history are unchanged.`,
                        );
                      }
                    })
                  }
                >
                  Remove verified completed copies
                </Button>
                <Button
                  kind="ghost"
                  disabled={busy}
                  onClick={() => {
                    setPlan(null);
                    setVerified(false);
                  }}
                >
                  Keep all originals here
                </Button>
              </div>
            </Card>
          ) : null}
          {pending && session ? (
            <Card className="owner-task-original">
              <h2>Unconfirmed original</h2>
              <p>
                {last.closeRequested
                  ? 'Closure saved on this device. Retry sends only that closure.'
                  : 'Check whether the original was accepted, or close it. Recovery never submits a new choice.'}
              </p>
              <div className="owner-task-actions">
                <Button
                  kind="secondary"
                  disabled={busy}
                  onClick={() =>
                    void work(async (s) => {
                      const receipt = await s.inspect(last.intent.id);
                      if (active.current)
                        setMessage(
                          receipt.state === 'pending'
                            ? 'No accepted result yet. The original is retained.'
                            : 'The original result is confirmed.',
                        );
                    })
                  }
                >
                  Check original result
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void work(async (s) => {
                      const receipt = await s.close(last.intent.id);
                      if (active.current)
                        setMessage(
                          receipt.state === 'pending'
                            ? 'Closure is still unconfirmed.'
                            : receipt.state === 'applied'
                              ? 'The original choice was already recorded. Its actual result is retained.'
                              : 'The original result is confirmed. A closed request cannot apply later.',
                        );
                    })
                  }
                >
                  {last.closeRequested
                    ? 'Retry original closure'
                    : 'Close original request'}
                </Button>
              </div>
            </Card>
          ) : null}
          <div className="owner-task-grid">
            {rows.map((row, n) => {
              if ('source' in row)
                return (
                  <PaymentRequestSource
                    key={row.intent.id}
                    row={row}
                    index={n}
                  />
                );
              const intent = row.intent,
                task = intent.type === 'create' ? intent : intent.task;
              return (
                <Card className="owner-task-card" key={intent.id}>
                  <header>
                    <span>
                      Original {n + 1} · {row.receipt?.state ?? 'unconfirmed'}
                    </span>
                  </header>
                  <h3 dir="auto">{ownerTaskText(task.titleJson, 200)}</h3>
                  <p>
                    {intent.type === 'create'
                      ? 'Add task'
                      : choiceLabels[intent.action]}
                    {row.closeRequested ? ' · Closure saved' : ''}
                  </p>
                  <details>
                    <summary>Complete saved source</summary>
                    <dl className="owner-task-saved-source">
                      <div>
                        <dt>Original details</dt>
                        <dd dir="auto">{ownerTaskText(task.bodyJson)}</dd>
                      </div>
                      {ownerTaskText(task.preparedJson) ? (
                        <div>
                          <dt>Prepared message</dt>
                          <dd dir="auto">{ownerTaskText(task.preparedJson)}</dd>
                        </div>
                      ) : null}
                      {'replyJson' in task && task.replyJson !== null ? (
                        <div>
                          <dt>Earlier recorded reply</dt>
                          <dd dir="auto">{ownerTaskText(task.replyJson)}</dd>
                        </div>
                      ) : null}
                      {intent.type === 'act' &&
                      ownerTaskText(intent.replyJson) ? (
                        <div>
                          <dt>Your recorded reply</dt>
                          <dd dir="auto">{ownerTaskText(intent.replyJson)}</dd>
                        </div>
                      ) : null}
                      {task.recipient ? (
                        <div>
                          <dt>Recipient</dt>
                          <dd>{task.recipient}</dd>
                        </div>
                      ) : null}
                      {'authorJson' in task && task.authorJson !== null ? (
                        <div>
                          <dt>Recorded by</dt>
                          <dd dir="auto">
                            {ownerTaskText(task.authorJson, 200)}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Request saved</dt>
                        <dd>{new Date(intent.at).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </details>
                </Card>
              );
            })}
          </div>
        </>
      ) : !error ? (
        <p role="status">
          Use this group’s original verified phone account to open its saved
          requests.
        </p>
      ) : null}
    </div>
  );
}
