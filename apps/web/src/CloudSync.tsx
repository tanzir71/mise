import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link,useNavigate } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { parseSyncSession, syncSessionLabel } from '@mise/core/sync-session';
import { db } from './data/db';
import { getPhoneAuth, type PhoneAuth } from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import { CloudUploadJournal } from './data/cloud-upload';
import { createSyncRuntime } from './data/sync-runtime';
import { watchSyncRealtime } from './data/sync-realtime';
import { enableSync } from './data/sync-enable';
import {
  requestSync,
  pauseSyncSession,
  freshSyncDownload,
} from './data/sync-session';
import { newInboxId } from '@mise/core/inbox';
import './cloud-sync.css';

function useSyncView() {
  return useLiveQuery(async () => {
    const raw = await db.syncSessions.get('active'),
      state = raw ? parseSyncSession(raw) : null,
      unsent = await db.outbox
        .where('status')
        .anyOf('pending', 'retained')
        .count(),
      binding = await db.cloudState.get('binding'),
      operator = await db.operatorState.get('active'),
      canRecover = await db.syncCanonical.where('id').equals('active').count() > 0;
    return { state, unsent, binding, operator, canRecover };
  }, []);
}
function sameConnection(config: CloudConnection) {
  try {
    const current = readCloudConnection(localStorage);
    return (
      current?.apiUrl === config.apiUrl &&
      current.publishableKey === config.publishableKey
    );
  } catch {
    return false;
  }
}
export function CloudSyncStatus({
  setup,
  online,
}: {
  setup: SetupSnapshot;
  online: boolean;
}) {
  const view = useSyncView(),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    state = view?.state,
    scope = import.meta.env.BASE_URL + setup.business.id;
  const sessionId = state?.sessionId,
    generation = state?.generation,
    forThisOutlet =
      state?.target.businessId === setup.business.id &&
      state.target.outletId === setup.outlet.id &&
      state.target.actorId === setup.owner.id &&
      state.operatorRevision === view?.operator?.revision &&
      view.operator.phase === 'active';
  useEffect(() => {
    let current = true,
      stop: (() => Promise<void>) | undefined;
    setBusy(false);
    setFailed(false);
    if (!sessionId || !forThisOutlet) return;
    void (async () => {
      const config = readCloudConnection(localStorage);
      if (!config) return;
      const authScope = await resolveCloudAuthScope(
        config,
        import.meta.env.BASE_URL,
        setup.business.id,
        state!.authKey,
      );
      const auth = await getPhoneAuth(config, authScope);
      if (!current) return;
      const journal = new CloudUploadJournal(
          'mise-cloud-uploads:' + import.meta.env.BASE_URL,
        ),
        runtime = createSyncRuntime(db, {
          config,
          scope,
          auth,
          journal,
          realtime: (wake, disconnected, signal) =>
            watchSyncRealtime(
              {
                config,
                scope,
                auth,
                journal,
                connectionCurrent: () => sameConnection(config),
              },
              state!,
              wake,
              disconnected,
              signal,
            ),
          connectionCurrent: () => sameConnection(config),
          onBusy: (value) => {
            if (current) setBusy(value);
          },
          onFailure: () => {
            if (current) setFailed(true);
          },
        });
      stop = async () => {
        try {
          await runtime.stop();
        } finally {
          journal.close();
        }
      };
    })().catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
      if (stop) void stop().catch(() => {});
    };
  }, [sessionId, generation, forThisOutlet, scope]);
  const label =
    failed || (state && !forThisOutlet)
      ? 'Needs review'
      : syncSessionLabel(
          forThisOutlet ? (state ?? null) : null,
          online,
          view?.unsent ?? 0,
          busy,
        );
  return (
    <Link
      className="sync-chip"
      to="/settings/sync"
      aria-label={`Sync: ${label}${view?.unsent ? `, ${view.unsent} unsent` : ''}`}
    >
      <span role="status">{label}</span>
      {view?.unsent ? (
        <span className="sync-unsent" aria-hidden="true">
          {view.unsent}
        </span>
      ) : null}
    </Link>
  );
}
export function CloudSyncControls({
  setup,
  config,
  auth,
  online,
}: {
  setup: SetupSnapshot;
  config: CloudConnection | null;
  auth: PhoneAuth | null;
  online: boolean;
}) {
  const navigate=useNavigate();
  const view = useSyncView(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    mounted = useRef(true),
    active = useRef<AbortController | null>(null),
    scope = import.meta.env.BASE_URL + setup.business.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = view?.state,
    needsRebind =
      !!state && state.operatorRevision !== view?.operator?.revision,
    label = syncSessionLabel(state ?? null, online, view?.unsent ?? 0),
    verified = auth?.getSnapshot().phase === 'signed-in';
  async function start() {
    if (!config || !auth || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    const journal = new CloudUploadJournal(
      'mise-cloud-uploads:' + import.meta.env.BASE_URL,
    );
    try {
      await enableSync(
        db,
        {
          setup,
          config,
          scope,
          auth,
          journal,
          connectionCurrent: () => sameConnection(config),
        },
        controller.signal,
      );
    } catch {
      if (mounted.current)
        setError(
          controller.signal.aborted
            ? 'Transfer stopped. Your local records and saved review are kept.'
            : 'Sync could not finish. Keep your local records, check your account and saved review, then try again.',
        );
    } finally {
      journal.close();
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  async function action(run: () => Promise<void>) {
    setError('');
    try {
      await run();
    } catch {
      setError(
        'This step could not finish. Keep your local records and try again.',
      );
    }
  }
  return (
    <Card className="app-panel cloud-sync-controls">
      <header>
        <MiseIcon name="link" size={20} />
        <h2>Sync this outlet</h2>
      </header>
      <p className="sync-state" role="status">
        {busy ? 'Starting sync…' : label}
        {view?.unsent
          ? ` · ${view.unsent} saved ${view.unsent === 1 ? 'action' : 'actions'} waiting`
          : ''}
      </p>
      <p>
        Your local shop stays available offline. Keep a separate JSON backup
        too.
      </p>
      {!state ? (
        <p>
          {view?.binding?.phase === 'uploading'
            ? 'Resume the original upload after checking your phone sign-in.'
            : 'Prepare the record review above, then verify your phone to turn on sync.'}
        </p>
      ) : state.problem === 'auth' ? (
        <p>
          Sign in with the original account, review your operator and choose
          Resume sync.
        </p>
      ) : state.problem === 'review' ? (
        <p>
          Some saved work needs review. Your local records and downloaded pages
          are kept.
        </p>
      ) : state.problem === 'retry' ? (
        <p>
          Sync will retry when the connection is ready. You can keep working.
        </p>
      ) : null}
      <footer>
        {view?.binding&&view.canRecover&&state?.problem==='review'?<Button kind="secondary" disabled={busy} onClick={()=>navigate('/settings/recovery')}>Review outlet access</Button>:null}
        {view?.binding?.version===1&&view.binding.phase==='ready'&&!view.canRecover&&(state?.problem==='review'||state?.problem==='auth'||needsRebind)?<Button kind="secondary" disabled={busy} onClick={()=>navigate('/settings/owner-recovery')}>Review original connection</Button>:null}
        {!state || state.problem === 'auth' || needsRebind ? (
          <Button
            disabled={busy || !online || !verified || !config}
            onClick={() => void start()}
          >
            {view?.binding?.phase === 'uploading'
              ? 'Resume upload'
              : state
                ? 'Resume sync'
                : 'Turn on sync'}
          </Button>
        ) : (
          <>
            <Button
              disabled={
                busy || !online || !verified || (!!state.lease && !state.paused)
              }
              onClick={() => void action(() => requestSync(db, true))}
            >
              {state.paused ? 'Resume sync' : 'Sync now'}
            </Button>
            {!state.paused ? (
              <Button
                kind="secondary"
                onClick={() => void action(() => pauseSyncSession(db))}
              >
                Pause sync
              </Button>
            ) : null}
            {state.problem === 'review' ? (
              <Button
                kind="secondary"
                disabled={!!state.lease || !online || !verified}
                onClick={() =>
                  void action(() => freshSyncDownload(db, newInboxId()))
                }
              >
                Start a fresh check
              </Button>
            ) : null}
          </>
        )}
        {busy ? (
          <Button kind="secondary" onClick={() => active.current?.abort()}>
            Stop transfer
          </Button>
        ) : null}
        <Link className="button button-secondary" to="/settings/exports">
          Download a JSON backup
        </Link>
      </footer>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
