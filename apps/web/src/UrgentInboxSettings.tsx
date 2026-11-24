import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { useUrgentInbox } from './urgent-inbox-context';

export function UrgentInboxSettings() {
  const view = useUrgentInbox(),
    [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    generation = useRef(0),
    live = useRef(false),
    running = useRef(''),
    off = useRef(false),
    scope = useRef(view?.scopeKey);
  scope.current = view?.scopeKey;
  useEffect(() => {
    generation.current++;
    running.current = '';
    off.current = false;
    setBusy('');
    setMessage('');
    setError('');
  }, [view?.scopeKey]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  async function run(kind: string, work: () => Promise<void>) {
    if (kind === 'off' ? off.current : !!running.current) return;
    const ticket = ++generation.current;
    const originalScope = scope.current;
    running.current = kind;
    if (kind === 'off') off.current = true;
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      await work();
      if (
        live.current &&
        generation.current === ticket &&
        scope.current === originalScope
      )
        setMessage(
          kind === 'off'
            ? 'Urgent alerts are off here. Any original removals are saved for confirmation.'
            : kind === 'enable'
              ? 'Urgent Inbox alerts enabled on this browser.'
              : 'Original alert choices checked.',
        );
    } catch (value) {
      if (
        live.current &&
        generation.current === ticket &&
        scope.current === originalScope
      )
        setError(
          value instanceof Error && value.name === 'QuotaExceededError'
            ? kind === 'off'
              ? 'This browser could not save the off choice. Alerts may still be enabled. Keep this page and retry; Inbox remains available.'
              : 'This browser could not save the choice or its confirmation. Keep the original request and use Inbox while you retry.'
            : value instanceof Error
              ? value.message
              : 'This choice is unconfirmed. Keep its original request and retry.',
        );
    } finally {
      if (kind === 'off') off.current = false;
      if (generation.current === ticket) {
        running.current = '';
        if (live.current) setBusy('');
      }
    }
  }
  if (!view) return null;
  return (
    <Card className="desk-setting-card" aria-label="Urgent Inbox alerts">
      <header>
        <h2>Urgent Inbox alerts</h2>
        <span className="desk-caption">
          {view.effective
            ? 'Enabled here'
            : view.registerPending
              ? 'Enable awaiting confirmation'
              : 'Off on this browser'}
        </span>
      </header>
      <p>
        Get a private notification for urgent questions, failures and unmatched
        payments. Open the actual item in Inbox to review it. Kitchen warnings
        keep their separate settings.
      </p>
      {!view.effective ? (
        <Button
          disabled={!!busy || !view.canEnable || view.registerPending}
          onClick={() => void run('enable', view.enable)}
        >
          {busy === 'enable'
            ? 'Preparing urgent alerts…'
            : view.registerPending
              ? 'Enable awaiting confirmation'
              : 'Enable urgent alerts'}
        </Button>
      ) : null}
      <Button
        kind="secondary"
        disabled={!view.snapshot || off.current}
        onClick={() => void run('off', view.disable)}
      >
        {busy === 'off' ? 'Saving off…' : 'Turn off urgent alerts'}
      </Button>
      {!view.snapshot?.desk.profile.enabled ? (
        <p>
          Enable notifications for this browser first. Urgent alerts need their
          own choice above.
        </p>
      ) : null}
      {!view.online ? (
        <p>
          You are offline. Turn off remains available; original removals are
          confirmed after reconnecting.
        </p>
      ) : null}
      {view.pending ? (
        <p className="desk-caption">
          {view.pending} original change{view.pending === 1 ? '' : 's'} awaiting
          confirmation.
        </p>
      ) : null}
      <div className="desk-setting-links">
        <Button
          kind="ghost"
          disabled={!!busy || !view.online || !view.session}
          onClick={() => void run('retry', view.retry)}
        >
          Check original alert choices
        </Button>
        <Link to="/settings/notifications/urgent-cleanup">
          Earlier urgent alert setups
        </Link>
        <Link to="/inbox">Open Inbox</Link>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {view.error ? (
        <p role="status" className="desk-caption">
          {view.error}
        </p>
      ) : null}
    </Card>
  );
}
