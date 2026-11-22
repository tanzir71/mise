import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import type { DeskAlarmSettings } from '@mise/core/desk-tasks';
import { useDeskNotifications } from './desk-context';
import './desk-notifications.css';

export function DeskNotificationSettings() {
  const view = useDeskNotifications(),
    [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [draft, setDraft] = useState<DeskAlarmSettings | null>(null),
    action = useRef(0),
    live = useRef(false),
    disabling = useRef(false),
    inFlight = useRef('');
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      action.current++;
    };
  }, []);
  async function run(kind: string, work: () => Promise<void>, success: string) {
    if (kind === 'disable' ? disabling.current : !!inFlight.current) return;
    const generation = ++action.current;
    inFlight.current = kind;
    if (kind === 'disable') disabling.current = true;
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      await work();
      if (live.current && generation === action.current) {
        setMessage(success);
        if (kind === 'settings') setDraft(null);
      }
    } catch (problem) {
      if (live.current && generation === action.current)
        setError(
          problem instanceof Error
            ? problem.message
            : 'This change is unconfirmed. Keep the saved action and retry.',
        );
    } finally {
      if (kind === 'disable') disabling.current = false;
      if (generation === action.current) inFlight.current = '';
      if (live.current && generation === action.current) setBusy('');
    }
  }
  if (!view)
    return (
      <Card className="app-panel">
        <h1>Notifications</h1>
        <p>Notification setup is unavailable.</p>
      </Card>
    );
  const profile = view.snapshot?.profile,
    settings = profile?.tasks.settings,
    effective = !!profile?.enabled && view.permission === 'granted',
    state =
      view.permission === 'denied'
        ? 'Blocked in browser'
        : effective
          ? 'Enabled here'
          : view.registerPending
            ? 'Enable saved · awaiting confirmation'
            : 'Off on this browser';
  return (
    <div className="desk-settings">
      <header className="app-page-heading">
        <div>
          <h1>Notifications</h1>
          <p>Kitchen warnings for this browser and outlet.</p>
        </div>
        <Link className="button button-secondary" to="/inbox">
          Open Inbox
        </Link>
      </header>
      <Card className="desk-setting-card">
        <header>
          <h2>This browser</h2>
          <span className="desk-caption">{state}</span>
        </header>
        <p>
          Get a notification when the kitchen has not confirmed an order. You
          can open the order or copy its warning from Inbox.
        </p>
        {!effective ? (
          <Button
            disabled={!!busy || !view.canEnable || view.registerPending}
            onClick={() =>
              void run(
                'enable',
                view.enable,
                'Notifications enabled on this browser.',
              )
            }
          >
            {busy === 'enable'
              ? 'Enabling…'
              : view.registerPending
                ? 'Enable awaiting confirmation'
                : 'Enable here'}
          </Button>
        ) : null}
        {profile &&
        (profile.subscription ||
          view.registerPending ||
          busy === 'enable' ||
          effective) ? (
          <Button
            kind="secondary"
            disabled={disabling.current}
            onClick={() =>
              void run(
                'disable',
                view.disable,
                'Disabled on this browser. Saved warnings stay in Inbox.',
              )
            }
          >
            {busy === 'disable' ? 'Disabling…' : 'Disable here'}
          </Button>
        ) : null}
        {view.permission === 'unsupported' ? (
          <p>
            Use a browser that supports notifications, or install Mise on your
            phone. Inbox remains available.
          </p>
        ) : view.permission === 'denied' ? (
          <p>
            Notifications are blocked for Mise. Change permission in your
            browser settings to enable them again.
          </p>
        ) : !profile ? (
          <p>
            Connect this outlet in Sync setup before enabling notifications.
          </p>
        ) : !view.online ? (
          <p>You are offline. Saved warnings and Disable remain available.</p>
        ) : !view.canEnable && !effective ? (
          <p>
            Notification setup is not ready. You can keep using Inbox and retry
            the connection.
          </p>
        ) : null}
        {view.pending ? (
          <p className="desk-caption">
            {view.pending} saved change{view.pending === 1 ? '' : 's'} awaiting
            confirmation.
          </p>
        ) : null}
        <div className="desk-setting-links">
          <Button
            kind="ghost"
            disabled={!view.canSave || !!busy}
            onClick={() =>
              void run('retry', view.retry, 'Saved changes checked.')
            }
          >
            Retry saved changes
          </Button>
          <Link to="/settings/notifications/cleanup">
            Manage earlier setups
          </Link>
        </div>
      </Card>
      <Card className="desk-setting-card">
        <header>
          <h2>Kitchen acknowledgement</h2>
          <span className="desk-caption">
            {settings
              ? settings.enabled
                ? `After ${settings.minutes} minutes`
                : 'Warnings disabled'
              : 'Not loaded'}
          </span>
        </header>
        <p>
          An unacknowledged order creates an Inbox task and a red queue warning.
          A genuine Got it on the kitchen screen stops it.
        </p>
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                'settings',
                () => view.saveSettings({ ...draft }),
                'Kitchen warning saved.',
              );
            }}
          >
            <label className="desk-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              Raise unacknowledged warnings
            </label>
            <label className="desk-field">
              Warn after (minutes)
              <input
                type="number"
                min="1"
                max="1440"
                step="1"
                required
                value={draft.minutes}
                onChange={(event) =>
                  setDraft({ ...draft, minutes: Number(event.target.value) })
                }
              />
            </label>
            <div className="desk-actions">
              <Button type="submit" disabled={!!busy || !view.canSave}>
                Save kitchen warning
              </Button>
              <Button
                kind="secondary"
                disabled={busy === 'settings'}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            kind="secondary"
            disabled={!settings || !view.canSave}
            onClick={() => setDraft(settings ? { ...settings } : null)}
          >
            Change kitchen warning
          </Button>
        )}
        <p className="desk-caption">
          This setting applies to the outlet. Disable here above affects this
          browser’s notifications.
        </p>
      </Card>
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {view.error ? (
        <p role="status" className="desk-caption">
          {view.error}
        </p>
      ) : null}
      <div className="desk-setting-links">
        <Link to="/settings/sync">Sync setup</Link>
        <Link to="/settings/notifications/cleanup">
          Earlier notifications on this browser
        </Link>
      </div>
    </div>
  );
}
