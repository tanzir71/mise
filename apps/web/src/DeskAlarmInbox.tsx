import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import type { DeskAlarmTask } from '@mise/core/desk-tasks';
import type { SetupSnapshot } from '@mise/core/models';
import { useDeskNotifications } from './desk-context';
import './desk-notifications.css';

function AlarmCard({ task, saved }: { task: DeskAlarmTask; saved: boolean }) {
  const [copied, setCopied] = useState(false),
    [manual, setManual] = useState(false),
    area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (manual) area.current?.select();
  }, [manual]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(task.copyText);
      setCopied(true);
    } catch {
      setManual(true);
    }
  }
  return (
    <Card className="desk-alarm-card" id={'task-' + task.id}>
      <header className="desk-card-meta">
        <MiseIcon name="bell" size={16} />
        <span>
          Kitchen · {saved ? 'saved on this device' : 'needs acknowledgement'}
        </span>
      </header>
      <h3>{task.title}</h3>
      <p>{task.body}</p>
      <footer>
        <Link className="button button-primary" to={'/orders/' + task.orderId}>
          Open order
        </Link>
        <Button kind="secondary" onClick={() => void copy()}>
          <MiseIcon name="copy" size={16} />
          Copy warning
        </Button>
      </footer>
      {copied ? <p role="status">Warning copied.</p> : null}
      {manual ? (
        <label className="desk-copy-fallback">
          Copy this warning by hand
          <textarea
            ref={area}
            readOnly
            value={task.copyText}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </Card>
  );
}
export function DeskAlarmTasks() {
  const view = useDeskNotifications(),
    [visible, setVisible] = useState(20);
  if (!view) return null;
  const tasks = view.snapshot?.profile.tasks.tasks ?? [];
  return (
    <section
      className="desk-alarm-section"
      aria-labelledby="desk-kitchen-heading"
    >
      <header className="desk-section-heading">
        <h2 id="desk-kitchen-heading">
          Kitchen acknowledgement{view.snapshot ? ` · ${tasks.length}` : ''}
        </h2>
        <Link to="/settings/notifications">Notification settings</Link>
      </header>
      {view.loading ? (
        <p aria-busy="true">Checking this outlet’s saved tasks…</p>
      ) : !view.snapshot ? (
        <Card className="desk-empty">
          <h3>Connect this outlet</h3>
          <p>
            Open Sync setup to sign in and load this outlet’s kitchen warnings.
            Your saved shop records stay on this device.
          </p>
          <Link className="button button-secondary" to="/settings/sync">
            Open Sync setup
          </Link>
        </Card>
      ) : tasks.length ? (
        <>
          <p className="desk-caption">
            {view.fresh
              ? 'Warnings stop when the kitchen confirms Got it.'
              : 'Showing the last complete task list saved for this outlet.'}
          </p>
          <div className="desk-alarm-grid">
            {tasks.slice(0, visible).map((task) => (
              <AlarmCard
                key={task.id + ':' + task.generation}
                task={task}
                saved={!view.fresh}
              />
            ))}
          </div>
          {tasks.length > visible ? (
            <Button
              kind="secondary"
              onClick={() => setVisible((value) => value + 20)}
            >
              Show more kitchen warnings
            </Button>
          ) : null}
        </>
      ) : (
        <Card className="desk-empty">
          <h3>
            {view.fresh ? 'Nothing waiting' : 'No warnings in the saved list'}
          </h3>
          <p>
            {view.fresh
              ? 'The kitchen has no unacknowledged warnings for this outlet.'
              : 'Reconnect to check for new kitchen warnings.'}
          </p>
        </Card>
      )}
      {view.error ? (
        <p role="status" className="desk-caption">
          {view.error}
        </p>
      ) : null}
    </section>
  );
}
export function DeskInboxPage({ setup }: { setup: SetupSnapshot }) {
  const view = useDeskNotifications(),
    count = view?.snapshot?.profile.tasks.tasks.length ?? 0;
  return (
    <div className="inbox-list desk-inbox">
      <header className="desk-inbox-heading">
        <div className="desk-inbox-top">
          <Link to="/settings/business">
            {setup.outlet.name}
            <MiseIcon name="chevronDown" size={16} />
          </Link>
          <Link to="/settings/notifications" aria-label="Notification settings">
            <MiseIcon name="bell" size={24} />
          </Link>
        </div>
        <h1>Inbox</h1>
        <p>Kitchen warnings waiting for a person.</p>
        <span className="desk-count">All {count}</span>
      </header>
      <DeskAlarmTasks />
    </div>
  );
}
