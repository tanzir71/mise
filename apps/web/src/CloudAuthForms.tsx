import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { normalisePhone } from '@mise/core/phone';
import type { MarketCode } from '@mise/core/packs';
import type { CloudConnection } from '@mise/core/cloud-connection';
import type { PhoneAuth, PhoneAuthState } from './data/phone-auth';
import { sitePath } from '@mise/core/paths';
const servicesGuide = sitePath(
  import.meta.env.BASE_URL.replace(/app\/$/, ''),
  'docs/configure-services.md',
);
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'This step could not finish. Keep your local copy and try again.';
}

export function ConnectionForm({
  config,
  saving,
  onSave,
  onCancel,
}: {
  config: CloudConnection | null;
  saving: boolean;
  onSave: (v: CloudConnection) => Promise<void>;
  onCancel?: () => void;
}) {
  const [apiUrl, setUrl] = useState(config?.apiUrl ?? ''),
    [publishableKey, setKey] = useState(config?.publishableKey ?? '');
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSave({ apiUrl, publishableKey });
      }}
    >
      <p>
        Use the cloud connection configured for your shop. Your shop controls its
        services and accounts.
      </p>
      <p>
        <a href={servicesGuide} target="_blank" rel="noreferrer">
          Cloud and service setup guide
        </a>
      </p>
      <fieldset className="form-fields" disabled={saving}>
        <label>
          Project URL
          <input
            type="url"
            value={apiUrl}
            onChange={(event) => setUrl(event.target.value)}
            required
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://your-project.supabase.co"
          />
        </label>
        <label>
          Publishable key
          <input
            type="password"
            value={publishableKey}
            onChange={(event) => setKey(event.target.value)}
            required
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </fieldset>
      <footer>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save connection'}
        </Button>
        {onCancel ? (
          <Button
            kind="ghost"
            type="button"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </footer>
    </form>
  );
}
export function PhoneSignIn({
  manager,
  state,
  market,
  initialPhone = '',
  online,
  onSignOut,
  saving,
}: {
  manager: PhoneAuth;
  state: PhoneAuthState;
  market: MarketCode;
  initialPhone?: string;
  online: boolean;
  onSignOut: () => Promise<void>;
  saving: boolean;
}) {
  const [phone, setPhone] = useState(initialPhone),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (state.phase === 'signed-in' || state.phase === 'signed-out')
      setCode('');
  }, [state.phase]);
  const wait = Math.max(0, Math.ceil((state.resendAt - now) / 1000)),
    busy = state.busy || saving;
  async function send() {
    setError('');
    const number = normalisePhone(
      state.phase === 'code' ? (state.phone ?? '') : phone,
      market,
    );
    if (!number) {
      setError('Enter a valid phone number.');
      return;
    }
    try {
      await manager.sendCode(number);
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function verify() {
    setError('');
    try {
      await manager.verifyCode(code);
      setCode('');
    } catch (error) {
      setError(errorText(error));
    }
  }
  return (
    <div className="cloud-phone-form" aria-busy={busy}>
      {state.phase === 'checking' ? (
        <p role="status">Checking sign-in…</p>
      ) : state.phase === 'signed-in' ? (
        <>
          <p className="cloud-verified">
            Phone verified <strong>{state.phone}</strong>
          </p>
          <p>Your connection is ready for the next setup step.</p>
          <footer>
            <Button
              kind="secondary"
              disabled={busy}
              onClick={() => void onSignOut()}
            >
              Sign out on this device
            </Button>
          </footer>
        </>
      ) : state.phase === 'closed' ? (
        <>
          <p role="status">Sign-in closed.</p>
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => void onSignOut()}
          >
            Try sign-out again
          </Button>
        </>
      ) : state.phase === 'offline' ? (
        <>
          <p>
            Connect to the internet to check your sign-in. The local shop
            remains available.
          </p>
          <footer>
            <Button
              kind="secondary"
              disabled={busy || !online}
              onClick={() => void manager.check()}
            >
              Check sign-in
            </Button>
            <Button
              kind="ghost"
              disabled={busy}
              onClick={() => void onSignOut()}
            >
              Sign out on this device
            </Button>
          </footer>
        </>
      ) : state.phase === 'code' ? (
        <>
          <p>
            Enter the code sent to <strong>{state.phone}</strong>.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <fieldset className="form-fields" disabled={busy || !online}>
              <label>
                Verification code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={20}
                  required
                />
              </label>
            </fieldset>
            <footer>
              <Button type="submit" disabled={busy || !online}>
                {busy ? 'Verifying…' : 'Verify phone'}
              </Button>
              <Button
                kind="secondary"
                type="button"
                disabled={busy || !online || wait > 0}
                onClick={() => void send()}
              >
                {wait > 0 ? `Send again in ${wait}s` : 'Send a new code'}
              </Button>
            </footer>
          </form>
          <Button
            kind="ghost"
            disabled={busy}
            onClick={() => {
              manager.resetCode();
              setCode('');
              setError('');
            }}
          >
            Use a different number
          </Button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p>
            Use your own phone number to sign in. Your shop’s installer configures
            the SMS service.
          </p>
          <p>
            <a href={servicesGuide} target="_blank" rel="noreferrer">
              Set up phone sign-in and services
            </a>
          </p>
          <fieldset className="form-fields" disabled={busy || !online}>
            <label>
              Phone number
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                autoComplete="tel"
                maxLength={40}
                required
              />
            </label>
          </fieldset>
          <footer>
            <Button type="submit" disabled={busy || !online || wait > 0}>
              {busy
                ? 'Requesting…'
                : wait > 0
                  ? `Try again in ${wait}s`
                  : 'Send verification code'}
            </Button>
          </footer>
        </form>
      )}
      {!online ? (
        <p role="status">You’re offline. Keep using your local shop.</p>
      ) : null}
      {state.message &&
      !(state.phase === 'signed-in' && state.message === 'Phone verified.') ? (
        <p role="status">{state.message}</p>
      ) : null}
      {!state.persistent ? (
        <p role="status">
          This browser could not save your sign-in. Keep this page open and try
          again later.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
