import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import {
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import {
  deviceVerification,
  type DeviceDirectory,
  type StaffDeviceAccess,
} from '@mise/core/device-access';
import { decodeScreenSetupHash } from '@mise/core/device-screen-link';
import type { ScreenJournalRecord } from '@mise/core/device-screen-state';
import {
  openScreenJournal,
  ScreenStorageError,
  type ScreenJournal,
} from './data/device-screen-journal';
import { createDeviceScreenSession } from './data/device-screen-session';
import { DeviceScreenRequestError } from './data/device-screen-remote';
import { watchScreenProfile } from './data/screen-profile';
import { ConnectionForm } from './CloudAuthForms';
import { installApp, useAppInstall } from './app-install';
import './device-access.css';
const KitchenScreen=lazy(()=>import('./KitchenScreen').then(module=>({default:module.KitchenScreen})));

type Session = ReturnType<typeof createDeviceScreenSession>;
interface Runtime {
  journal: ScreenJournal;
  screen: Session;
  active: boolean;
}
const digits = (value: string) =>
  value
    .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[^0-9]/g, '');
function setupLink(hash: string) {
  try {
    return { link: decodeScreenSetupHash(hash), error: '' };
  } catch {
    return {
      link: null,
      error: 'Use the complete screen setup link from the owner.',
    };
  }
}
const problem = (error: unknown) =>
  error instanceof ScreenStorageError ||
  error instanceof DeviceScreenRequestError ||
  error instanceof Error
    ? error.message
    : 'This screen could not finish the step. Keep its saved setup and try again.';

export function SharedScreen({ setupHash = '', kitchenEnabled = false }: { setupHash?: string; kitchenEnabled?: boolean }) {
  const [incoming] = useState(() => setupLink(setupHash)),
    [connection, setConnection] = useState<CloudConnection | null>(
      incoming.link?.connection ?? null,
    ),
    [pairingId, setPairingId] = useState(incoming.link?.pairingId ?? null),
    [first, setFirst] = useState(incoming.link?.code.slice(0, 3) ?? ''),
    [last, setLast] = useState(incoming.link?.code.slice(3) ?? '');
  const [saved, setSaved] = useState<ScreenJournalRecord | null>(null),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(incoming.error),
    [notice, setNotice] = useState(''),
    [blocked, setBlocked] = useState(false),
    [directory, setDirectory] = useState<DeviceDirectory | null>(null),
    [members, setMembers] = useState<DeviceDirectory['members']>([]),
    [memberId, setMemberId] = useState(''),
    [pin, setPin] = useState(''),
    [access, setAccess] = useState<StaffDeviceAccess | null>(null),
    [online, setOnline] = useState(navigator.onLine),
    [now, setNow] = useState(Date.now()),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [remove, setRemove] = useState(false);
  const runtime = useRef<Runtime | null>(null),
    observer = useRef<Session | null>(null),
    poll = useRef<() => Promise<void>>(async () => {}),
    busy = useRef(false),
    snapshot = useRef<ScreenJournalRecord | null>(null),
    lastInput = useRef<HTMLInputElement>(null),
    install = useAppInstall(),
    [accessRevision, setAccessRevision] = useState(0);
  snapshot.current = saved;
  function accept(value: ScreenJournalRecord) {
    snapshot.current = value;
    setSaved(value);
    setAccess(null);
    setDirectory(null);
    setMembers([]);
    setMemberId('');
    setPin('');
    setRemove(false);
  }
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const current = runtime.current;
      if (!current || !current.active || busy.current) return;
      try {
        const next = await current.screen.load();
        if (!mounted || !current.active) return;
        setBlocked(false);
        if (snapshot.current?.revision !== next.revision) accept(next);
      } catch (error) {
        if (!mounted || !current.active) return;
        setAccess(null);
        setError(problem(error));
        if (error instanceof ScreenStorageError && error.kind === 'owner') {
          setBlocked(true);
          try {
            const next = await current.screen.loadForCleanup();
            if (mounted && current.active) accept(next);
          } catch {
            /* Preserve the storage error and original records. */
          }
        }
      }
    };
    void openScreenJournal(import.meta.env.BASE_URL)
      .then(async (journal) => {
        if (!mounted) {
          journal.close();
          return;
        }
        const current: Runtime = {
          journal,
          screen: createDeviceScreenSession(journal),
          active: true,
        };
        runtime.current = current;
        await refresh();
        if (mounted) setLoading(false);
      })
      .catch((error) => {
        if (mounted) {
          setError(problem(error));
          setLoading(false);
        }
      });
    const stop = watchScreenProfile(import.meta.env.BASE_URL, () => {
        setAccess(null);
        setAccessRevision((value) => value + 1);
        void refresh();
      }),
      changed = () => {
        setOnline(navigator.onLine);
        setAccess(null);
        setAccessRevision((value) => value + 1);
        void refresh();
      },
      storage = () => {
        setAccess(null);
        setAccessRevision((value) => value + 1);
        void refresh();
      };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    window.addEventListener('storage', storage);
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => {
      mounted = false;
      stop();
      clearInterval(timer);
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
      window.removeEventListener('storage', storage);
      observer.current?.dispose();
      observer.current = null;
      const current = runtime.current;
      if (current) {
        current.active = false;
        current.screen.dispose();
        current.journal.close();
        runtime.current = null;
      }
    };
  }, []);
  async function run(
    action: (current: Runtime, source: ScreenJournalRecord) => Promise<void>,
  ) {
    const current = runtime.current,
      source = snapshot.current;
    if (!current || !current.active || !source || busy.current) return;
    busy.current = true;
    observer.current?.dispose();
    observer.current = null;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await action(current, source);
    } catch (error) {
      if (current.active) {
        setAccess(null);
        setError(problem(error));
        if (
          error instanceof DeviceScreenRequestError &&
          error.kind === 'backoff'
        )
          setRetryAt(error.retryAt);
        try {
          accept(await current.screen.loadForCleanup());
        } catch {
          /* Keep original storage for manual recovery. */
        }
      }
    } finally {
      busy.current = false;
      if (current.active) {
        setWorking(false);
        setAccessRevision((value) => value + 1);
      }
    }
  }
  async function pair() {
    await run(async (current, source) => {
      const result = await current.screen.pair(source);
      if (!current.active) return;
      if (result.saved.revision !== source.revision) accept(result.saved);
      setNotice(
        result.outcome === 'approved'
          ? 'Screen paired. Choose your name and enter your PIN.'
          : result.outcome === 'waiting'
            ? 'Ask the owner to compare the verification below and approve this screen.'
            : result.outcome === 'expired'
              ? 'This pairing code expired. Ask the owner for a new one.'
              : 'This pairing was cancelled. Ask the owner for a new code.',
      );
    });
  }
  poll.current = pair;
  const phase = saved?.state.phase;
  useEffect(() => {
    if (phase !== 'pairing' || !online || blocked) return;
    const timer = setInterval(() => {
      if (!busy.current) void poll.current();
    }, 2500);
    void poll.current();
    return () => clearInterval(timer);
  }, [phase, online, blocked]);
  useEffect(() => {
    if (!saved || phase !== 'signed-in' || !online || blocked || kitchenEnabled) {
      setAccess(null);
      return;
    }
    const owner = runtime.current;
    if (!owner) return;
    const reader = createDeviceScreenSession(owner.journal);
    observer.current = reader;
    let active = true,
      inflight = false;
    const read = async () => {
      const current = runtime.current,
        source = snapshot.current;
      if (!current || !current.active || !source || busy.current) return;
      if (inflight || observer.current !== reader) return;
      inflight = true;
      try {
        const value = await reader.access(source);
        if (
          active &&
          current.active &&
          observer.current === reader &&
          snapshot.current?.revision === source.revision
        ) {
          setAccess(value);
          setError('');
        }
      } catch (error) {
        if (active && current.active && observer.current === reader) {
          setAccess(null);
          setError(problem(error));
        }
      } finally {
        inflight = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 10000);
    return () => {
      active = false;
      reader.dispose();
      if (observer.current === reader) observer.current = null;
      clearInterval(timer);
    };
  }, [saved?.revision, phase, online, blocked, accessRevision, kitchenEnabled]);
  useEffect(() => {
    if (phase !== 'enrolled' || blocked || !online) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      if (!active) return;
      if (busy.current) {
        timer = setTimeout(read, 100);
        return;
      }
      void run(async (current, source) => {
        const page = await current.screen.directory(source);
        if (active && current.active) {
          setDirectory(page);
          setMembers(page.members);
          setMemberId('');
        }
      });
    };
    timer = setTimeout(read, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [saved?.revision, phase, blocked, online]);
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!connection) {
      setError('Scan the owner’s setup QR, or enter the connection below.');
      return;
    }
    await run(async (current, source) => {
      accept(
        await current.screen.prepare(
          source,
          connection,
          first + last,
          pairingId,
        ),
      );
    });
  }
  async function signIn(event: FormEvent) {
    event.preventDefault();
    const originalPin = digits(pin);
    setPin('');
    await run(async (current, source) => {
      accept(await current.screen.signIn(source, memberId, originalPin));
      setRetryAt(null);
      setNotice('PIN accepted. Checking current staff access…');
    });
  }
  async function reset(forget = false) {
    setAccess(null);
    setPin('');
    await run(async (current, source) => {
      accept(await current.screen.reset(source, forget));
      setBlocked(false);
      setNotice(
        forget
          ? 'Screen sign-in removed from this browser.'
          : 'Signed out. Choose your name to sign in again.',
      );
    });
  }
  async function moreStaff() {
    await run(async (current, source) => {
      if (!directory?.next) return;
      const page = await current.screen.directory(source, directory.next);
      if (current.active) {
        setDirectory(page);
        setMembers((previous) => [...previous, ...page.members]);
      }
    });
  }
  const state = saved?.state,
    enrolled =
      state && state.phase !== 'empty' && state.phase !== 'pairing'
        ? state
        : null,
    outlet = enrolled ? (JSON.parse(enrolled.outletNameJson) as string) : '',
    wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const title = access
    ? `${access.mode === 'kitchen' ? 'Kitchen' : 'Counter'} access verified`
    : enrolled
      ? 'Sign in on this screen'
      : 'Turn this device into a shared screen';
  if(kitchenEnabled&&!blocked&&saved?.state.phase==='signed-in'&&runtime.current?.active)return <Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening kitchen tickets…</p></main>}><KitchenScreen key={saved.revision} journal={runtime.current.journal} source={saved} onSignOut={()=>reset()}/></Suspense>;
  return (
    <main className="shared-screen">
      <a className="app-skip" href="#screen-main">
        Skip to screen setup
      </a>
      <div className="shared-screen-layout">
        <Card className="screen-setup-card">
          <header className="screen-brand">
            <span className="screen-mark" aria-hidden="true">
              m
            </span>
            <span>mise · shared screen</span>
            <small>Tablet, phone or laptop</small>
          </header>
          <div id="screen-main" tabIndex={-1}>
            <h1>{title}</h1>
            <p className="screen-lead">
              {enrolled ? (
                <>
                  {enrolled.credential.device.name} · {outlet}
                </>
              ) : (
                'Pair this browser once. Staff use their own four-digit PIN.'
              )}
            </p>
            {loading ? (
              <p role="status">Checking this screen’s saved setup…</p>
            ) : null}
            {error ? (
              <p className="device-error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="device-notice" role="status">
                {notice}
              </p>
            ) : null}
            {!online ? (
              <p className="device-notice" role="status">
                Offline. Connect to pair, sign in or check current access.
              </p>
            ) : null}
            {blocked ? (
              <section className="screen-step">
                <h2>Keep the owner’s shop in this profile</h2>
                <p>
                  Use a separate blank browser profile for a shared screen.
                  Existing shop records and incoming shares stay here.
                </p>
                {state?.phase === 'pairing' ? (
                  <Button
                    kind="secondary"
                    disabled={working}
                    onClick={() =>
                      void run(async (current, source) => {
                        accept(await current.screen.forgetPairing(source));
                        location.assign(import.meta.env.BASE_URL);
                      })
                    }
                  >
                    Remove pending screen setup
                  </Button>
                ) : enrolled ? (
                  <Button
                    kind="secondary"
                    disabled={working}
                    onClick={() => void reset(true)}
                  >
                    Close and remove screen sign-in
                  </Button>
                ) : (
                  <Link className="button button-secondary" to="/">
                    Return to your shop
                  </Link>
                )}
              </section>
            ) : state?.phase === 'empty' ? (
              <>
                <form onSubmit={prepare} className="screen-pair-form">
                  <section className="screen-step">
                    <span className="screen-step-number" aria-hidden="true">
                      1
                    </span>
                    <div>
                      <h2>Enter the pairing code</h2>
                      <p>
                        From Mise → More → Shared screens on the owner’s device,
                        or scan its setup QR.
                      </p>
                      <fieldset className="pairing-digits" disabled={working}>
                        <legend className="sr-only">
                          Six-digit pairing code
                        </legend>
                        <input
                          aria-label="First three pairing digits"
                          inputMode="numeric"
                          autoComplete="off"
                          pattern="[0-9]{3}"
                          required
                          value={first}
                          maxLength={9}
                          onChange={(event) => {
                            const next = digits(event.target.value);
                            setFirst(next.slice(0, 3));
                            if (next.length > 3) setLast(next.slice(3, 6));
                            if (next.length >= 3) lastInput.current?.focus();
                          }}
                        />
                        <input
                          ref={lastInput}
                          aria-label="Last three pairing digits"
                          inputMode="numeric"
                          autoComplete="off"
                          pattern="[0-9]{3}"
                          required
                          value={last}
                          maxLength={3}
                          onChange={(event) =>
                            setLast(digits(event.target.value).slice(0, 3))
                          }
                        />
                      </fieldset>
                    </div>
                  </section>
                  <section className="screen-step">
                    <span className="screen-step-number" aria-hidden="true">
                      2
                    </span>
                    <div>
                      <h2>Compare with the owner</h2>
                      <p>
                        The next step shows a verification on both screens. The
                        owner approves only when every group matches.
                      </p>
                      <Button
                        type="submit"
                        disabled={working || !online || !connection}
                      >
                        {working ? 'Saving screen setup…' : 'Request pairing'}
                      </Button>
                    </div>
                  </section>
                </form>
                {connection ? (
                  <p className="device-muted">
                    Connection supplied for this screen.{' '}
                    <button
                      className="text-button"
                      onClick={() => setConnection(null)}
                    >
                      Change
                    </button>
                  </p>
                ) : (
                  <details className="screen-manual-connection" open>
                    <summary>Enter connection by hand</summary>
                    <ConnectionForm
                      config={null}
                      saving={working}
                      onSave={async (input) => {
                        try {
                          setConnection(parseCloudConnection(input));
                          setError('');
                        } catch (error) {
                          setError(problem(error));
                        }
                      }}
                    />
                  </details>
                )}
              </>
            ) : state?.phase === 'pairing' ? (
              <section className="screen-step">
                <span className="screen-step-number" aria-hidden="true">
                  1
                </span>
                <div>
                  <h2>Compare this verification</h2>
                  <p>
                    Ask the owner to open the matching pairing request. Every
                    group below must match before approval.
                  </p>
                  <output
                    className="screen-verification"
                    aria-label="Screen verification"
                  >
                    {deviceVerification(state.source.tokenHash)}
                  </output>
                  <p className="device-muted">
                    Pairing code {state.source.code.slice(0, 3)}{' '}
                    {state.source.code.slice(3)}
                    {state.receipt
                      ? ` · ${Math.max(0, Math.ceil((state.receipt.expiresAt - now) / 60000))} min remaining`
                      : ''}
                  </p>
                  <div className="device-actions">
                    <Button
                      disabled={working || !online}
                      onClick={() => void pair()}
                    >
                      Check approval
                    </Button>
                    <Button
                      kind="secondary"
                      disabled={working}
                      onClick={() =>
                        void run(async (current, source) => {
                          accept(await current.screen.forgetPairing(source));
                          setConnection(null);
                          setPairingId(null);
                          setFirst('');
                          setLast('');
                          setNotice('Enter a new setup link or pairing code.');
                        })
                      }
                    >
                      Use a new code
                    </Button>
                  </div>
                </div>
              </section>
            ) : state?.phase === 'enrolled' ? (
              <form className="screen-step screen-pin-form" onSubmit={signIn}>
                <span className="screen-step-number" aria-hidden="true">
                  2
                </span>
                <div>
                  <h2>Your name and PIN</h2>
                  <p>
                    Use the PIN the owner set for you. Staff see only this
                    outlet and screen’s permitted work.
                  </p>
                  <fieldset disabled={working || !online || wait > 0}>
                    <label>
                      Your name
                      <select
                        required
                        value={memberId}
                        onChange={(event) => {
                          setMemberId(event.target.value);
                          setPin('');
                        }}
                      >
                        <option value="">Choose your name</option>
                        {members.map((member) => (
                          <option key={member.id} value={member.id}>
                            {JSON.parse(member.nameJson) as string}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Four-digit PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={pin}
                        required
                        minLength={4}
                        maxLength={4}
                        pattern="[0-9০-৯]{4}"
                        onChange={(event) => setPin(event.target.value)}
                      />
                    </label>
                    <Button
                      type="submit"
                      disabled={!memberId || pin.length !== 4}
                    >
                      Sign in
                    </Button>
                  </fieldset>
                  {wait > 0 ? (
                    <p role="status">
                      Wait {wait} seconds before another PIN try.
                    </p>
                  ) : null}
                  {directory?.next ? (
                    <Button
                      type="button"
                      kind="secondary"
                      disabled={working || !online}
                      onClick={() => void moreStaff()}
                    >
                      More staff
                    </Button>
                  ) : null}
                  {directory && !members.length ? (
                    <p>
                      No eligible staff PINs are available. Ask the owner to
                      check your PIN and outlet assignment.
                    </p>
                  ) : null}
                </div>
              </form>
            ) : state?.phase === 'signing-in' ||
              state?.phase === 'resetting' ? (
              <section className="screen-step">
                <span className="screen-step-number" aria-hidden="true">
                  2
                </span>
                <div>
                  <h2>
                    {state.phase === 'signing-in'
                      ? 'Recover the previous sign-in'
                      : 'Finish the previous sign-out'}
                  </h2>
                  <p>
                    The last request is unconfirmed. Close that screen’s
                    sign-ins before entering a PIN again.
                  </p>
                  <Button
                    disabled={working || !online}
                    onClick={() =>
                      void reset(state.phase === 'resetting' && state.forget)
                    }
                  >
                    {working ? 'Confirming sign-out…' : 'Retry sign-out'}
                  </Button>
                </div>
              </section>
            ) : state?.phase === 'signed-in' ? (
              <section className="screen-step">
                <span className="screen-step-number" aria-hidden="true">
                  3
                </span>
                <div>
                  <h2>
                    {access ? 'Staff access checked' : 'Checking staff access'}
                  </h2>
                  <p>
                    {access
                      ? 'This screen is paired and your PIN session is current.'
                      : 'Connect to check this screen’s current staff access.'}
                  </p>
                  <Button
                    kind="secondary"
                    disabled={working}
                    onClick={() => void reset()}
                  >
                    Sign out
                  </Button>
                </div>
              </section>
            ) : !loading ? (
              <Button onClick={() => location.reload()}>
                Retry screen setup
              </Button>
            ) : null}
            {enrolled && !blocked ? (
              <section className="screen-remove">
                <button
                  className="text-button"
                  disabled={working}
                  onClick={() => setRemove((value) => !value)}
                >
                  Remove this screen from this browser
                </button>
                {remove ? (
                  <>
                    <p>
                      This closes staff sign-ins and removes this browser’s
                      pairing. Pair again with the owner to use it later.
                    </p>
                    <div className="device-actions">
                      <Button
                        kind="secondary"
                        disabled={working}
                        onClick={() => setRemove(false)}
                      >
                        Keep screen
                      </Button>
                      <Button
                        disabled={working}
                        onClick={() => void reset(true)}
                      >
                        Remove screen
                      </Button>
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}
          </div>
        </Card>
        <aside className="screen-readiness">
          <Card>
            <header>
              <h2>This screen’s access</h2>
              <p>Checked as you complete setup</p>
            </header>
            <ul>
              <li>
                <MiseIcon name="link" size={20} />
                <div>
                  <strong>Paired by the owner</strong>
                  <p>
                    A code selects the request. The owner compares and approves
                    it.
                  </p>
                </div>
                <span className={enrolled ? 'device-positive' : 'device-muted'}>
                  {enrolled ? 'Paired' : 'Waiting'}
                </span>
              </li>
              <li>
                <MiseIcon name="checkCircle" size={20} />
                <div>
                  <strong>Your staff PIN</strong>
                  <p>
                    Sign in as yourself. No owner phone sign-in is needed here.
                  </p>
                </div>
                <span className={access ? 'device-positive' : 'device-muted'}>
                  {access ? 'Verified' : 'Waiting'}
                </span>
              </li>
              <li>
                <MiseIcon name="store" size={20} />
                <div>
                  <strong>One outlet</strong>
                  <p>
                    {enrolled
                      ? outlet
                      : 'The owner chooses the outlet and screen mode.'}
                  </p>
                </div>
                <span className="device-muted">
                  {enrolled
                    ? enrolled.credential.device.mode === 'kitchen'
                      ? 'Kitchen'
                      : 'Counter'
                    : 'Not paired'}
                </span>
              </li>
            </ul>
            <section>
              <h2>Optional: install</h2>
              <p>
                {install.installed
                  ? 'Installed in this browser.'
                  : 'Add Mise to your home screen for a full-screen icon. The browser link works too.'}
              </p>
              {install.canPrompt && !install.installed ? (
                <Button
                  kind="secondary"
                  disabled={install.busy}
                  onClick={() => void installApp()}
                >
                  Install on this device
                </Button>
              ) : null}
              {install.message ? <p role="status">{install.message}</p> : null}
            </section>
            <footer>
              <MiseIcon name="checkCircle" size={18} />
              <p>
                The owner can revoke a paired screen at any time. PIN digits are
                never saved on it.
              </p>
            </footer>
          </Card>
        </aside>
      </div>
    </main>
  );
}
