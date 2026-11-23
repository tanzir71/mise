import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import QRCode from 'qrcode';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import {
  cloudConnectionStorageKey,
  cloudConnectionTarget,
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { operatorAccountHash } from '@mise/core/operators';
import { newInboxId } from '@mise/core/inbox';
import { screenSetupUrl } from '@mise/core/device-screen-link';
import {useStaffTeamEnabled} from './staff-context';
import {
  parseDevicePairing,
  type DeviceAdminPage,
  type DeviceMode,
  type DevicePairingInspection,
  type DevicePairing,
} from '@mise/core/device-access';
import type { SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { getPhoneAuth } from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import {
  CommandRequestError,
  type CommandAccount,
} from './data/command-request';
import {
  createDeviceAdminSession,
  type DeviceAdminAction,
  type DeviceAdminSession,
} from './data/device-admin-session';
import './device-access.css';

interface Ready {
  session: DeviceAdminSession;
  config: CloudConnection;
  active: boolean;
  role: 'owner' | 'manager';
}
const identity = (setup: SetupSnapshot) =>
  [setup.business.id, setup.outlet.id, setup.owner.id, setup.owner.role].join(
    ':',
  );
const message = (error: unknown) =>
  error instanceof CommandRequestError
    ? error.kind === 'auth'
      ? 'Sign in again with the original phone account to manage screens.'
      : error.kind === 'retry'
        ? 'This device change is unconfirmed. Retry its saved action before starting another.'
        : 'The selected outlet or saved action changed. Refresh access before continuing.'
    : error instanceof Error
      ? error.message
      : 'This step could not finish. Keep the saved action and try again.';
function ScreenSetupShare({
  pairing,
  config,
}: {
  pairing: DevicePairing;
  config: CloudConnection;
}) {
  const attendanceEnabled=useStaffTeamEnabled();
  const [qr, setQr] = useState(''),
    [copied, setCopied] = useState(false),
    [fallback, setFallback] = useState(false);
  const url = screenSetupUrl(location.origin, import.meta.env.BASE_URL, {
    v: 1,
    connection: config,
    pairingId: pairing.id,
    code: pairing.code,
  },{staffTeam:attendanceEnabled,kitchenScreen:attendanceEnabled&&pairing.mode==='kitchen'});
  useEffect(() => {
    let current = true;
    setQr('');
    setCopied(false);
    setFallback(false);
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 224,
      color: { dark: '#141414', light: '#ffffff' },
    })
      .then((value) => {
        if (current) setQr(value);
      })
      .catch(() => {
        if (current) setFallback(true);
      });
    return () => {
      current = false;
    };
  }, [url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setFallback(true);
    }
  }
  return (
    <div className="device-pairing-share">
      {qr ? (
        <img
          src={qr}
          width="176"
          height="176"
          alt="Setup QR for this shared screen"
        />
      ) : null}
      <div>
        <p>
          Open a separate blank browser profile on the shared device. Scan this
          QR, then compare its verification below.
        </p>
        <Button kind="secondary" onClick={() => void copy()}>
          Copy setup link
        </Button>
        {copied ? <p role="status">Setup link copied.</p> : null}
        {fallback ? (
          <label>
            Setup link
            <textarea
              value={url}
              readOnly
              rows={3}
              onFocus={(event) => event.target.select()}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}
export function DeviceAccessSettings({
  setup,
  online,
}: {
  setup: SetupSnapshot;
  online: boolean;
}) {
  const selection = useLiveQuery(() => db.operatorState.get('active')),
    [config, setConfig] = useState<CloudConnection | null>(null),
    [ready, setReady] = useState<Ready | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    [checking, setChecking] = useState(true),
    [working, setWorking] = useState(false),
    [pages, setPages] = useState<
      Partial<Record<'devices' | 'pairings' | 'members', DeviceAdminPage>>
    >({}),
    [pending, setPending] = useState<DeviceAdminAction | null>(null),
    [inspection, setInspection] = useState<DevicePairingInspection | null>(
      null,
    ),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [compared, setCompared] = useState(''),
    [name, setName] = useState('Kitchen tablet'),
    [mode, setMode] = useState<DeviceMode>('kitchen'),
    [memberId, setMemberId] = useState(''),
    [pin, setPin] = useState(''),
    [repeat, setRepeat] = useState(''),
    [pinEligibility,setPinEligibility]=useState<{memberId:string;ready:Ready;allowed:boolean}|null>(null),
    [discarding, setDiscarding] = useState(false),
    [now, setNow] = useState(Date.now());
  const holder = useRef<Ready | null>(null),
    busy = useRef(false),
    context = identity(setup),
    selectionToken = JSON.stringify(selection ?? null);
  holder.current = ready;
  function denyAccess(value: Ready, error: unknown) {
    if (!(error instanceof CommandRequestError) || error.kind !== 'auth')
      return;
    value.active = false;
    if (holder.current === value) {
      holder.current = null;
      setReady(null);
      setPages({});
      setInspection(null);
      setCompared('');
      setPending(null);
      setPin('');
      setRepeat('');
    }
  }
  useEffect(() => {
    const read = () => {
      try {
        setConfig(readCloudConnection(localStorage));
      } catch {
        setError('Review this browser’s saved connection in Sync setup.');
        setConfig(null);
      }
    };
    read();
    const changed = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === cloudConnectionStorageKey ||
        event.key?.startsWith('mise.cloud.auth.')
      ) {
        if (holder.current) holder.current.active = false;
        setReady(null);
        setPages({});
        setInspection(null);
        setPin('');
        setRepeat('');
        read();
        setVersion((value) => value + 1);
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    let current = true,
      session: Ready | null = null,
      unsubscribe: (() => void) | undefined;
    const stop = new AbortController();
    setChecking(true);
    setReady(null);
    setPages({});
    setInspection(null);
    setCompared('');
    setPin('');
    setRepeat('');
    setPending(null);
    setError('');
    if (!config || !online) {
      setChecking(false);
      return () => {
        current = false;
      };
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
      const assertCurrent: CommandAccount['assertCurrent'] = (value) => {
        if (
          !current ||
          (session !== null && !session.active) ||
          value.userId !== original.userId ||
          value.generation !== original.generation ||
          JSON.stringify(readCloudConnection(localStorage)) !==
            JSON.stringify(originalConfig)
        )
          throw new CommandRequestError('auth');
        manager.assertCommandAuthorization(value);
      };
      const account: CommandAccount = {
        scope,
        accountHash,
        targetHash,
        getAuth: async () => {
          await assertLocal();
          const value = await manager.commandAuthorization();
          assertCurrent(value);
          return value;
        },
        assertCurrent,
      };
      const api = createDeviceAdminSession(
        originalConfig,
        account,
        {
          businessId: setup.business.id,
          outletId: setup.outlet.id,
          actorId: setup.owner.id,
        },
        {
          storage: localStorage,
          assertScope: async () => {
            await assertLocal();
            assertCurrent(await manager.commandAuthorization());
          },
        },
      );
      const devices = await api.page('devices', null, 50, stop.signal);
      if (!current) return;
      if (devices.actorRole !== setup.owner.role)
        throw new CommandRequestError('review');
      session = {
        session: api,
        config: originalConfig,
        active: true,
        role: devices.actorRole,
      };
      const [pairings, members] = await Promise.all([
        api.page('pairings', null, 50, stop.signal),
        devices.actorRole === 'owner'
          ? api.page('members', null, 50, stop.signal)
          : Promise.resolve(undefined),
      ]);
      if (!current) return;
      setPages({ devices, pairings, ...(members ? { members } : {}) });
      setPending(api.pending());
      setReady(session);
      setError('');
      unsubscribe = manager.subscribe(() => {
        const state = manager.getSnapshot();
        if (
          current &&
          (state.phase === 'signed-out' ||
            state.phase === 'closed' ||
            state.phase === 'code' ||
            (state.userId && state.userId !== original.userId))
        ) {
          if (session) session.active = false;
          setReady(null);
          setPages({});
          setInspection(null);
          setPin('');
          setRepeat('');
          setError('Phone sign-in changed. Refresh with the original account.');
        }
      });
    })()
      .catch((error) => {
        if (current) setError(message(error));
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
      stop.abort();
      unsubscribe?.();
      if (session) session.active = false;
    };
  }, [JSON.stringify(config), context, selectionToken, online, version]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ready || !selectedId || !online) return;
    let current = true,
      inflight = false;
    const stop = new AbortController();
    const inspect = async () => {
      if (inflight || busy.current || !ready.active) return;
      inflight = true;
      try {
        const value = await ready.session.inspect(selectedId, stop.signal);
        if (current && ready.active) {
          setInspection(value);
          setError('');
        }
      } catch (error) {
        if (current && ready.active) {
          setInspection(null);
          setCompared('');
          setError(message(error));
          denyAccess(ready, error);
        }
      } finally {
        inflight = false;
      }
    };
    void inspect();
    const timer = setInterval(() => void inspect(), 3000);
    return () => {
      current = false;
      clearInterval(timer);
      stop.abort();
    };
  }, [ready, selectedId, online]);
  async function action(run: (value: Ready) => Promise<void>) {
    const value = holder.current;
    if (!value || !value.active || busy.current) return;
    busy.current = true;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await run(value);
    } catch (error) {
      if (value.active) {
        setError(message(error));
        try {
          setPending(value.session.pending());
        } catch {
          setError(
            'The saved device action needs review in the original account.',
          );
        }
        denyAccess(value, error);
      }
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }
  async function perform(source: DeviceAdminAction) {
    await action(async (value) => {
      const outcome = await value.session.perform(source);
      if (!value.active) return;
      setPending(null);
      if (outcome.kind === 'start') {
        const pairing = parseDevicePairing(outcome.result);
        setSelectedId(pairing.id);
        setNotice(
          'Pairing code ready. Compare the verification shown on the new screen.',
        );
      } else
        setNotice(
          outcome.kind === 'approve'
            ? 'Screen approved. Staff can now enter their PIN.'
            : outcome.kind === 'revoke'
              ? 'Screen access revoked.'
              : 'Pairing invitation cancelled.',
        );
      setVersion((previous) => previous + 1);
    });
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    await perform({
      kind: 'start',
      id: newInboxId(),
      eventId: newInboxId(),
      name,
      mode,
    });
  }
  async function retry() {
    await action(async (value) => {
      const outcome = await value.session.retry();
      if (!value.active) return;
      if (outcome.kind === 'start')
        setSelectedId(parseDevicePairing(outcome.result).id);
      setPending(null);
      setNotice('Original device action confirmed.');
      setVersion((previous) => previous + 1);
    });
  }
  async function loadMore(kind: 'devices' | 'pairings' | 'members') {
    await action(async (value) => {
      const old = pages[kind];
      if (!old?.next) return;
      const page = await value.session.page(kind, old.next);
      if (value.active)
        setPages((previous) => ({
          ...previous,
          [kind]: { ...page, entries: [...old.entries, ...page.entries] },
        }));
    });
  }
  async function savePin(event: FormEvent) {
    event.preventDefault();
    const digits = pin.replace(/[০-৯]/g, (d) =>
        String(d.charCodeAt(0) - 0x09e6),
      ),
      confirmation = repeat.replace(/[০-৯]/g, (d) =>
        String(d.charCodeAt(0) - 0x09e6),
      );
    setPin('');
    setRepeat('');
    if (digits !== confirmation || !/^\d{4}$/.test(digits)) {
      setError('Enter the same four-digit PIN twice.');
      return;
    }
    await action(async (value) => {
      await value.session.pin(memberId, 'set', digits);
      if (value.active) {
        setNotice(
          'Staff PIN saved. Previous PIN sessions are no longer valid.',
        );
        setVersion((previous) => previous + 1);
      }
    });
  }
  const devices =
      pages.devices?.kind === 'devices' ? pages.devices.entries : [],
    pairings =
      pages.pairings?.kind === 'pairings' ? pages.pairings.entries : [],
    members = pages.members?.kind === 'members' ? pages.members.entries : [],
    selectedMember = members.find((m) => m.id === memberId),
    pairing = inspection?.pairing,
    expired = !!pairing && pairing.expiresAt <= now;
  useEffect(()=>{
    setPinEligibility(null);const captured=ready,target=selectedMember;let active=true;
    if(!captured||!online||target?.role!=='rider'||!target.active||!target.assigned)return;
    const controller=new AbortController();let reading=false;
    const read=async()=>{if(reading)return;reading=true;try{await captured.session.pinContext(target.id,controller.signal);if(active&&captured.active&&holder.current===captured)setPinEligibility({memberId:target.id,ready:captured,allowed:true});}catch{if(active)setPinEligibility({memberId:target.id,ready:captured,allowed:false});}finally{reading=false;}};
    void read();const timer=setInterval(()=>void read(),10000);return()=>{active=false;controller.abort();clearInterval(timer);};
  },[ready,selectedMember?.id,selectedMember?.role,selectedMember?.active,selectedMember?.assigned,online]);
  const pinAllowed=selectedMember&&(['staff','kitchen'].includes(selectedMember.role)||selectedMember.role==='rider'&&pinEligibility?.memberId===selectedMember.id&&pinEligibility.ready===ready&&pinEligibility.allowed);
  return (
    <div className="device-admin">
      <header className="app-page-heading">
        <h1>Settings › Shared screens</h1>
        <p>
          Pair a kitchen or counter display with {setup.outlet.name}. Keep the
          owner’s phone sign-in on this device.
        </p>
      </header>
      {error ? (
        <p role="alert" className="device-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="device-notice">
          {notice}
        </p>
      ) : null}
      {checking ? (
        <p role="status">Checking phone sign-in and outlet access…</p>
      ) : null}
      {!ready ? (
        <Card className="app-panel">
          <h2>Verify your phone account</h2>
          <p>
            Use the owner or assigned manager account for this outlet. Configure
            the connection and sign in from Sync setup.
          </p>
          <div className="device-actions">
            <Link className="button button-primary" to="/settings/sync">
              Open Sync setup
            </Link>
            <Button
              kind="secondary"
              disabled={checking || !online}
              onClick={() => setVersion((value) => value + 1)}
            >
              Refresh access
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <div className="device-admin-summary">
            <Card className="app-panel">
              <MiseIcon name="phone" size={20} />
              <h2>Paired screens</h2>
              <p>
                {
                  devices.filter(
                    (d) => d.revokedAt === null && d.expiresAt > now,
                  ).length
                }{' '}
                active in this page ·{' '}
                {ready.role === 'owner' ? 'Owner' : 'Assigned manager'}
              </p>
            </Card>
            <Card className="app-panel">
              <MiseIcon name="link" size={20} />
              <h2>Pair by comparison</h2>
              <p>
                A six-digit code selects a request. Approve only when every
                verification group matches.
              </p>
            </Card>
          </div>
          {pending ? (
            <Card className="app-panel device-pending">
              <h2>A device change is unconfirmed</h2>
              <p>
                {pending.kind === 'start'
                  ? 'Keep the original screen name and pairing request.'
                  : 'Keep the original device action and its comparison.'}{' '}
                Retry it before starting another change.
              </p>
              <div className="device-actions">
                <Button
                  disabled={working || !online}
                  onClick={() => void retry()}
                >
                  Retry saved device change
                </Button>
                <Button
                  kind="secondary"
                  disabled={working}
                  onClick={() => setDiscarding((value) => !value)}
                >
                  Review local retry
                </Button>
              </div>
              {discarding ? (
                <>
                  <p>
                    Discarding removes only this browser’s retry. It does not
                    undo an action the server already accepted. Refresh the
                    screen list afterward.
                  </p>
                  <Button
                    kind="secondary"
                    disabled={working}
                    onClick={() =>
                      void action(async (value) => {
                        await value.session.discard();
                        if (value.active) {
                          setPending(null);
                          setDiscarding(false);
                          setVersion((previous) => previous + 1);
                        }
                      })
                    }
                  >
                    Discard local retry
                  </Button>
                </>
              ) : null}
            </Card>
          ) : null}
          <div className="device-admin-layout">
            <section>
              <Card className="app-panel">
                <h2>Pair a new screen</h2>
                <form onSubmit={start}>
                  <fieldset disabled={working || !!pending || !online}>
                    <label>
                      Screen name
                      <input
                        value={name}
                        maxLength={160}
                        required
                        autoComplete="off"
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label>
                      Screen mode
                      <select
                        value={mode}
                        onChange={(event) =>
                          setMode(event.target.value as DeviceMode)
                        }
                      >
                        <option value="kitchen">Kitchen</option>
                        <option value="counter">Counter</option>
                      </select>
                    </label>
                    <Button type="submit">Create pairing code</Button>
                  </fieldset>
                </form>
              </Card>
              <Card className="app-panel">
                <h2>Pairing invitations</h2>
                {pairings.length ? (
                  <ul className="device-list">
                    {pairings.map((p) => (
                      <li key={p.id}>
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {p.mode === 'kitchen' ? 'Kitchen' : 'Counter'} ·{' '}
                            {p.deviceId
                              ? 'Paired'
                              : p.closedAt
                                ? 'Cancelled'
                                : p.expiresAt <= now
                                  ? 'Expired'
                                  : 'Waiting for a screen'}
                          </small>
                        </div>
                        <Button
                          kind="secondary"
                          small
                          disabled={working}
                          onClick={() => {
                            setSelectedId(p.id);
                            setInspection(null);
                            setCompared('');
                          }}
                        >
                          Open pairing
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No pairing invitations for this outlet.</p>
                )}
                {pages.pairings?.next ? (
                  <Button
                    kind="secondary"
                    disabled={working || !online}
                    onClick={() => void loadMore('pairings')}
                  >
                    More invitations
                  </Button>
                ) : null}
              </Card>
            </section>
            <section>
              <Card className="app-panel device-comparison">
                <h2>{pairing ? pairing.name : 'Compare the new screen'}</h2>
                {pairing ? (
                  <>
                    <p>
                      {pairing.deviceId
                        ? 'This invitation has already paired a screen.'
                        : pairing.closedAt
                          ? 'This invitation was cancelled.'
                          : expired
                            ? 'This code expired. Create a new invitation.'
                            : 'Enter this code on the new screen, or scan the setup QR.'}
                    </p>
                    <output
                      className="device-pair-code"
                      aria-label="Pairing code"
                    >
                      {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
                    </output>
                    {!pairing.closedAt && !expired ? (
                      <ScreenSetupShare
                        pairing={pairing}
                        config={ready.config}
                      />
                    ) : null}
                    {inspection?.requests.length ? (
                      <ul className="device-requests">
                        {inspection.requests.map((claim) => (
                          <li key={claim.id}>
                            <strong>
                              {claim.approvedAt
                                ? 'Approved screen'
                                : 'Screen requesting approval'}
                            </strong>
                            <output
                              className="screen-verification"
                              aria-label="Verification to compare"
                            >
                              {claim.verification}
                            </output>
                            {!pairing.closedAt && !expired ? (
                              <>
                                <label className="device-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={compared === claim.id}
                                    onChange={(event) =>
                                      setCompared(
                                        event.target.checked ? claim.id : '',
                                      )
                                    }
                                  />
                                  Every group matches the new screen
                                </label>
                                <Button
                                  disabled={
                                    working ||
                                    !!pending ||
                                    compared !== claim.id ||
                                    !online
                                  }
                                  onClick={() =>
                                    void perform({
                                      kind: 'approve',
                                      pairing,
                                      claim,
                                      eventId: newInboxId(),
                                    })
                                  }
                                >
                                  Approve this screen
                                </Button>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : !pairing.closedAt && !expired ? (
                      <p>Waiting for the new screen to request approval…</p>
                    ) : null}
                    {!pairing.closedAt ? (
                      <Button
                        kind="secondary"
                        disabled={working || !!pending || !online}
                        onClick={() =>
                          void perform({
                            kind: 'cancel',
                            id: pairing.id,
                            eventId: newInboxId(),
                          })
                        }
                      >
                        Cancel this invitation
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p>
                    Choose an invitation to see its code and compare the
                    verification. Codes expire after ten minutes.
                  </p>
                )}
              </Card>
            </section>
          </div>
          <Card className="app-panel">
            <div className="device-panel-heading">
              <div>
                <h2>Paired screens</h2>
                <p>
                  Revoking a screen stops its PIN sessions and permitted reads.
                </p>
              </div>
              <Button
                kind="secondary"
                disabled={working || !online}
                onClick={() => setVersion((value) => value + 1)}
              >
                Refresh screens
              </Button>
            </div>
            {devices.length ? (
              <ul className="device-list">
                {devices.map((d) => (
                  <li key={d.id}>
                    <div>
                      <strong>{d.name}</strong>
                      <small>
                        {d.mode === 'kitchen' ? 'Kitchen' : 'Counter'} ·{' '}
                        {d.revokedAt
                          ? 'Revoked'
                          : d.expiresAt <= now
                            ? 'Expired'
                            : 'Paired'}
                      </small>
                    </div>
                    {d.revokedAt === null ? (
                      <Button
                        kind="secondary"
                        small
                        disabled={working || !!pending || !online}
                        onClick={() =>
                          void perform({
                            kind: 'revoke',
                            id: d.id,
                            eventId: newInboxId(),
                          })
                        }
                      >
                        Revoke screen
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No paired screens for this outlet.</p>
            )}
            {pages.devices?.next ? (
              <Button
                kind="secondary"
                disabled={working || !online}
                onClick={() => void loadMore('devices')}
              >
                More screens
              </Button>
            ) : null}
          </Card>
          {ready.role === 'owner' ? (
            <Card className="app-panel">
              <h2>Staff PINs</h2>
              <p>
                Only the owner can set or clear PINs. Staff must be active and
                assigned to this outlet to sign in.
              </p>
              <form className="device-pin-admin" onSubmit={savePin}>
                <fieldset disabled={working || !online}>
                  <label>
                    Staff member
                    <select
                      required
                      value={memberId}
                      onChange={(event) => {
                        setMemberId(event.target.value);
                        setPin('');
                        setRepeat('');
                      }}
                    >
                      <option value="">Choose staff</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {JSON.parse(m.nameJson) as string} · {m.role}
                          {!m.active
                            ? ' · inactive'
                            : !m.assigned
                              ? ' · not assigned'
                              : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedMember ? (
                    <p>
                      {selectedMember.configured
                        ? 'PIN configured'
                        : 'No PIN configured'}
                    </p>
                  ) : null}
                  {selectedMember?.role==='rider'?<p>{pinAllowed?'Order-phone attendance is enabled for this rider at this outlet.':'Enable this rider’s order-phone check-in in Team before setting a PIN here. A former PIN can still be cleared.'}</p>:null}
                  <div className="device-pin-fields">
                    <label>
                      New four-digit PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        minLength={4}
                        maxLength={4}
                        pattern="[0-9০-৯]{4}"
                        autoComplete="new-password"
                        value={pin}
                        onChange={(event) => setPin(event.target.value)}
                      />
                    </label>
                    <label>
                      Repeat PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        minLength={4}
                        maxLength={4}
                        pattern="[0-9০-৯]{4}"
                        autoComplete="new-password"
                        value={repeat}
                        onChange={(event) => setRepeat(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="device-actions">
                    <Button
                      type="submit"
                      disabled={
                        !selectedMember ||
                        !selectedMember.active ||
                        !selectedMember.assigned ||
                        !pinAllowed ||
                        pin.length !== 4 ||
                        repeat.length !== 4
                      }
                    >
                      Save staff PIN
                    </Button>
                    {selectedMember?.configured ? (
                      <Button
                        type="button"
                        kind="secondary"
                        onClick={() => {
                          setPin('');
                          setRepeat('');
                          void action(async (value) => {
                            await value.session.pin(memberId, 'clear');
                            if (value.active) {
                              setNotice(
                                'Staff PIN cleared. Its existing sessions are no longer valid.',
                              );
                              setVersion((previous) => previous + 1);
                            }
                          });
                        }}
                      >
                        Clear staff PIN
                      </Button>
                    ) : null}
                  </div>
                </fieldset>
              </form>
              {pages.members?.next ? (
                <Button
                  kind="secondary"
                  disabled={working || !online}
                  onClick={() => void loadMore('members')}
                >
                  More staff
                </Button>
              ) : null}
            </Card>
          ) : (
            <Card className="app-panel">
              <p>
                The owner manages staff PINs. As the assigned manager, you can
                pair and revoke screens for this outlet.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
