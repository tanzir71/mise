import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import {
  cloudConnectionStorageKey,
  readCloudConnection,
  saveCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { newInboxId } from '@mise/core/inbox';
import type { SetupSnapshot } from '@mise/core/models';
import { backupTableNames } from '@mise/core/backup-tables';
import {
  CloudUploadJournal,
  type LocalUploadReview,
} from './data/cloud-upload';
import {
  forgetPhoneAuth,
  getPhoneAuth,
  type PhoneAuth,
  type PhoneAuthState,
} from './data/phone-auth';
import { db } from './data/db';
import { CloudSyncControls } from './CloudSync';
import { ConnectionForm, PhoneSignIn } from './CloudAuthForms';
import { resolveCloudAuthScope } from './data/cloud-auth-scope';
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
const labels: Record<string, string> = {
  businesses: 'Business',
  outlets: 'Outlet',
  members: 'Members',
  categories: 'Categories',
  items: 'Catalogue items',
  customers: 'Customers',
  creditAccounts: 'Khata accounts',
  creditEntries: 'Khata entries',
  orders: 'Orders',
  sales: 'Sales and payments',
  orderNotes: 'Order notes',
  orderCommunications: 'Order messages',
  orderRefunds: 'Refunds',
  suppliers: 'Suppliers',
  stockItems: 'Stock items',
  stockMoves: 'Stock movements',
  supplierMessages: 'Supplier messages',
  dayClosings: 'Day closings',
  purchases: 'Invoices',
  inboxItems: 'Shared sources',
  events: 'Audit records',
};
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'This step could not finish. Keep your local copy and try again.';
}
export function CloudSetup({
  setup,
  online,
  syncEnabled = false,
}: {
  setup: SetupSnapshot;
  online: boolean;
  syncEnabled?: boolean;
}) {
  const [config, setConfig] = useState<CloudConnection | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    [manager, setManager] = useState<PhoneAuth | null>(null),
    [auth, setAuth] = useState<PhoneAuthState>(emptyAuth);
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    busy = useRef(false);
  const binding = useLiveQuery(() => db.cloudState.get('binding')),
    operator = useLiveQuery(async () => ({
      state: await db.operatorState.get('active'),
    })),
    scope = import.meta.env.BASE_URL + setup.business.id;
  useEffect(() => {
    const read = () => {
      try {
        setConfig(readCloudConnection(localStorage));
        setError('');
      } catch (error) {
        setError(errorText(error));
      }
      setLoaded(true);
    };
    read();
    const changed = (event: StorageEvent) => {
      if (event.key === cloudConnectionStorageKey || event.key === null) {
        setNotice('Connection settings changed in another tab.');
        read();
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    let current = true,
      unsubscribe: (() => void) | undefined;
    setManager(null);
    setAuth(emptyAuth);
    if (config && operator !== undefined)
      void resolveCloudAuthScope(
        config,
        import.meta.env.BASE_URL,
        setup.business.id,
        operator.state?.connection?.authKey,
      )
        .then((authScope) => (current ? getPhoneAuth(config, authScope) : null))
        .then((value) => {
          if (!current || !value) return;
          setManager(value);
          const update = () => {
            if (current) setAuth(value.getSnapshot());
          };
          unsubscribe = value.subscribe(update);
          update();
          void value.check();
        })
        .catch(() => {
          if (current)
            setError(
              'The saved connection could not be opened. Review its settings.',
            );
        });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [
    config,
    scope,
    version,
    operator === undefined,
    operator?.state?.connection?.authKey,
  ]);
  async function save(input: CloudConnection) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = saveCloudConnection(localStorage, input);
      await forgetPhoneAuth();
      setConfig(next);
      setEditing(false);
      setVersion((v) => v + 1);
      setNotice('Connection saved on this device.');
    } catch (error) {
      setError(errorText(error));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function forget() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      localStorage.removeItem(cloudConnectionStorageKey);
      setConfig(null);
      await forgetPhoneAuth();
      setNotice(
        'Connection forgotten on this device. Your shop records are kept.',
      );
    } catch {
      setError(
        'This browser could not forget the saved connection. Try again.',
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function signOut() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await forgetPhoneAuth();
      setVersion((v) => v + 1);
      setNotice('Signed out on this device. Your local records are kept.');
    } catch {
      setError('Sign-out could not finish. Try again.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="cloud-setup" aria-busy={!loaded}>
      <header className="app-page-heading">
        <h1>Settings › Sync setup</h1>
        <p>
          Connect this device, verify your phone and review your local shop.
        </p>
      </header>
      <p className="cloud-preview-note">
        {syncEnabled
          ? 'Sync is opt-in. Review your records and keep a backup before starting.'
          : 'Setup is still in progress. Your records stay on this device until an upload is available.'}
      </p>
      <div className="cloud-setup-cards">
        <Card className="app-panel cloud-connection">
          <header>
            <MiseIcon name="link" size={20} />
            <h2>Connection</h2>
          </header>
          {!config || editing ? (
            <ConnectionForm
              key={JSON.stringify(config)}
              config={config}
              saving={saving || auth.busy}
              onSave={save}
              onCancel={config ? () => setEditing(false) : undefined}
            />
          ) : (
            <>
              <p>Connection saved on this device.</p>
              <p>These settings stay separate from your shop’s JSON backup.</p>
              <footer>
                <Button
                  kind="secondary"
                  disabled={saving || auth.busy}
                  onClick={() => setEditing(true)}
                >
                  Edit connection
                </Button>
                <Button
                  kind="ghost"
                  disabled={saving || auth.busy}
                  onClick={() => void forget()}
                >
                  Forget connection
                </Button>
              </footer>
            </>
          )}
        </Card>
        <Card className="app-panel cloud-phone">
          <header>
            <MiseIcon name="phone" size={20} />
            <h2>Phone sign-in</h2>
          </header>
          {config && manager ? (
            <PhoneSignIn
              manager={manager}
              state={auth}
              market={setup.business.marketCode}
              initialPhone={setup.owner.phone ?? ''}
              online={online}
              onSignOut={signOut}
              saving={saving}
            />
          ) : (
            <p>
              {config
                ? 'Opening your saved sign-in…'
                : 'Save a connection to verify your phone.'}
            </p>
          )}
        </Card>
        {binding?.version === 2 ? (
          <Card className="app-panel cloud-review">
            <h2>This device has joined the outlet</h2>
            <p>
              The verified local copy and original images are ready. Turn on
              sync below to keep this device up to date.
            </p>
          </Card>
        ) : (
          <UploadReview setup={setup} />
        )}
        {syncEnabled ? (
          <CloudSyncControls
            setup={setup}
            config={config}
            auth={manager}
            online={online}
          />
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="cloud-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <p className="cloud-backup-link">
        <Link to="/settings/exports">Open exports and JSON backup</Link>
        <Link to="/">Back to the local shop</Link>
      </p>
    </div>
  );
}
function UploadReview({ setup }: { setup: SetupSnapshot }) {
  const [value, setValue] = useState<LocalUploadReview | null>(null),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const journal = useRef<CloudUploadJournal>(),
    preparing = useRef(false);
  useEffect(() => {
    const cache = new CloudUploadJournal(
      'mise-cloud-uploads:' + import.meta.env.BASE_URL,
    );
    journal.current = cache;
    preparing.current = false;
    setBusy(false);
    setLoading(true);
    setError('');
    setReadError(false);
    setValue(null);
    const stop = cache.watchReview(
      db,
      (next) => {
        setValue(next);
        setReadError(false);
        setError('');
        setLoading(false);
      },
      () => {
        setValue(null);
        setReadError(true);
        setLoading(false);
      },
    );
    return () => {
      stop();
      cache.close();
      if (journal.current === cache) journal.current = undefined;
    };
  }, [setup.business.id, setup.outlet.id, setup.owner.id]);
  async function prepare() {
    const cache = journal.current;
    if (preparing.current || !cache) return;
    preparing.current = true;
    setBusy(true);
    setError('');
    try {
      if (!readError) await cache.prepare(db, newInboxId());
      const next = await cache.review(db);
      if (journal.current === cache) {
        setValue(next);
        setReadError(false);
      }
    } catch {
      if (journal.current === cache)
        setError(
          'The local review could not be saved or read. Keep your local copy and JSON backup, then try again.',
        );
    } finally {
      if (journal.current === cache) {
        preparing.current = false;
        setBusy(false);
      }
    }
  }
  const review = value?.snapshot,
    bound = value?.phase === 'uploading' || value?.phase === 'ready';
  const status =
    value?.phase === 'ready'
      ? 'Upload receipt saved. Later local changes remain in the change queue.'
      : value?.phase === 'uploading'
        ? 'Original upload review retained. Later local changes remain in the change queue.'
        : 'Review saved on this device. No upload has started.';
  return (
    <Card className="app-panel cloud-review" aria-busy={busy || loading}>
      <header>
        <MiseIcon name="database" size={20} />
        <h2>Review the local shop</h2>
      </header>
      <p>
        {setup.business.name} · {setup.outlet.name}
      </p>
      <p>Prepare a saved review of your records before setting up an upload.</p>
      {review ? (
        <>
          <div className="cloud-review-totals">
            <strong>
              {review.manifest.records.toLocaleString('en')} records
            </strong>
            <span>{review.manifest.images} original images</span>
          </div>
          <dl className="cloud-review-counts">
            {backupTableNames.map((name) => (
              <div key={name}>
                <dt>{labels[name] ?? name}</dt>
                <dd>{review.manifest.counts[name].toLocaleString('en')}</dd>
              </div>
            ))}
          </dl>
          <p role="status">{status}</p>
        </>
      ) : null}
      <footer>
        <Button
          kind="secondary"
          disabled={busy || loading || bound}
          onClick={() => void prepare()}
        >
          {busy
            ? 'Preparing review…'
            : loading
              ? 'Reading saved review…'
              : readError
                ? 'Read saved review again'
                : bound
                  ? 'Original review retained'
                  : review
                    ? 'Review the latest records'
                    : 'Prepare local review'}
        </Button>
      </footer>
      {readError ? (
        <p role="alert" className="form-error">
          The original upload review needs recovery. Keep your local copy and
          JSON backup. Reading it again will not replace it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
