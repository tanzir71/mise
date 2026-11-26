import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import { formatMoney } from '@mise/core/money';
import type { SetupSnapshot } from '@mise/core/models';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import type { PhoneAuth } from './data/phone-auth';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
import { db } from './data/db';
import { readNativePaymentQueue } from './data/native-payment-review';
import { errorText } from './khata-data';
const noAuthSubscription = () => () => {};
const noAuthSnapshot = () => null;

export function NativePaymentQueueReview({
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [limit, setLimit] = useState(10);
  const active = useRef<AbortController | null>(null),
    alive = useRef(true);
  const authentication = useSyncExternalStore(
    auth?.subscribe ?? noAuthSubscription,
    auth?.getSnapshot ?? noAuthSnapshot,
  );
  const view = useLiveQuery(async () => {
    try {
      return { value: await readNativePaymentQueue(db, setup) };
    } catch (error) {
      return { error: errorText(error) };
    }
  }, [setup]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    active.current?.abort();
    setError('');
    setNotice('');
    setLimit(10);
  }, [
    setup.business.id,
    setup.outlet.id,
    setup.owner.id,
    config?.apiUrl,
    config?.publishableKey,
    auth?.key,
  ]);
  useEffect(() => {
    if (authentication?.phase !== 'signed-in') active.current?.abort();
    return () => active.current?.abort();
  }, [authentication?.phase, authentication?.userId]);
  useEffect(() => {
    if (!online) active.current?.abort();
  }, [online]);
  const queue = view?.value;
  async function proceed() {
    if (!queue?.canContinue || !config || !auth || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current = readCloudConnection(localStorage);
      if (
        current?.apiUrl !== config.apiUrl ||
        current.publishableKey !== config.publishableKey
      )
        throw Error('Review the current backend connection first.');
      const state = await db.syncSessions.get('active');
      if (!state) throw Error('Review sync for this outlet first.');
      const authScope = await resolveCloudAuthScope(
        config,
        import.meta.env.BASE_URL,
        setup.business.id,
        state.authKey,
      );
      const { continueNativePaymentQueue } =
        await import('./data/native-payment-review-session');
      controller.signal.throwIfAborted();
      const result = await continueNativePaymentQueue(
        db,
        {
          setup,
          config,
          auth,
          authScope,
          storage: localStorage,
          expectedToken: queue.token,
        },
        controller.signal,
      );
      if (alive.current)
        setNotice(
          result.result.blockedEntryId
            ? 'An earlier saved action still needs review. Original requests and results are kept.'
            : 'Original connected results are kept. Sync stays paused until the original records can be reconciled.',
        );
    } catch (error) {
      if (alive.current)
        setError(
          controller.signal.aborted
            ? 'Stopped. An in-flight request may have finished; keep its original and check again.'
            : errorText(error),
        );
    } finally {
      active.current = null;
      if (alive.current) setBusy(false);
    }
  }
  if (view?.error)
    return (
      <section
        className="native-payment-queue"
        aria-label="Original payment queue"
      >
        <h3>Keep original payment actions</h3>
        <p role="alert">{view.error}</p>
        <Link to="/settings/exports">Download a complete backup</Link>
      </section>
    );
  if (!queue?.rows.length) return null;
  return (
    <section
      className="native-payment-queue"
      aria-label="Original payment queue"
      aria-busy={busy}
    >
      <h3>Original payment actions</h3>
      <p>
        These are your saved approvals. An unconfirmed result does not mean the
        money was not recorded.
      </p>
      <ol>
        {queue.rows.slice(0, limit).map((row) => (
          <li key={row.id}>
            <strong>{row.label}</strong>
            <span>{row.status}</span>
            <span dir="auto">
              {row.reference || `Payment ${row.paymentId.slice(-8)}`}
            </span>
            <span>
              {formatMoney(row.amount, row.currency)} · Action{' '}
              {row.id.slice(-8)}
            </span>
          </li>
        ))}
      </ol>
      {limit < queue.rows.length ? (
        <Button
          kind="secondary"
          disabled={busy}
          onClick={() => setLimit((n) => n + 10)}
        >
          Show more original actions
        </Button>
      ) : null}
      {queue.installed || queue.localOnly ? (
        <p>
          Keep these originals for source registration and review. They cannot
          create a new outgoing approval.
        </p>
      ) : (
        <p>
          Continue the already approved payment and shop actions in their
          original order. Normal sync will pause; a saved result does not
          confirm a new sync cursor.
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="order-review-actions">
        <Button
          kind="secondary"
          disabled={
            busy ||
            !online ||
            !queue.canContinue ||
            !config ||
            authentication?.phase !== 'signed-in'
          }
          onClick={() => void proceed()}
        >
          Pause sync and continue saved queue
        </Button>
        {busy ? (
          <Button kind="secondary" onClick={() => active.current?.abort()}>
            Stop
          </Button>
        ) : null}
        <Link to="/inbox">Open original sources</Link>
        <Link to="/settings/exports">Complete backup</Link>
      </div>
    </section>
  );
}
