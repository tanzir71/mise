import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import {
  parseUrgentInboxNotice,
  type UrgentInboxTarget as Target,
} from '@mise/core/urgent-inbox';
import { useUrgentInbox } from './urgent-inbox-context';
import { OwnerTaskInbox } from './OwnerTaskInbox';
import { PaymentSourceReview } from './PaymentSourceReview';
import type { UrgentInboxSession } from './data/urgent-inbox-session';

export function UrgentInboxTarget({ setup }: { setup: SetupSnapshot }) {
  const location = useLocation(),
    view = useUrgentInbox(),
    session = view?.session ?? null,
    [attempt, setAttempt] = useState(0),
    [result, setResult] = useState<{
      key: string;
      session: UrgentInboxSession;
      target: Target | null;
      error: string;
    } | null>(null);
  const raw = new URLSearchParams(location.search).get('urgent'),
    notice = useMemo(() => {
      try {
        if (!raw || raw.length > 2048) throw Error();
        return parseUrgentInboxNotice(JSON.parse(raw));
      } catch {
        return null;
      }
    }, [raw]);
  const snapshot = view?.snapshot,
    choice = snapshot?.profile?.choiceRevision ?? '',
    key = JSON.stringify([
      raw,
      attempt,
      choice,
      snapshot?.profile?.enabled,
      snapshot?.desk.pointer.revision,
      snapshot?.desk.profile.choiceRevision,
      view?.online,
    ]),
    sameOutlet =
      !!notice &&
      notice.businessId === setup.business.id &&
      notice.outletId === setup.outlet.id,
    eligible = !!view?.effective && !!session && sameOutlet;
  useEffect(() => {
    let active = true;
    if (!eligible || !notice || !session) return;
    void session
      .target(notice)
      .then((target) => {
        if (active) setResult({ key, session, target, error: '' });
      })
      .catch(() => {
        if (active)
          setResult({
            key,
            session,
            target: null,
            error:
              'This alert could not be checked with the current setup. Its task may have changed, or access may be unavailable.',
          });
      });
    return () => {
      active = false;
    };
  }, [key, eligible, session, raw]);
  const current =
      result?.key === key && result.session === session && eligible
        ? result
        : null,
    target = current?.target;
  if (target)
    return (
      <>
        <Card className="desk-setting-card urgent-target-status">
          <h2>From your notification</h2>
          <p>
            {target.active
              ? 'The current item is shown below. Review its source before choosing an action.'
              : target.currentGeneration > target.notice.generation
                ? 'This alert belongs to an earlier version. The current item is shown below.'
                : 'This alert is no longer active. The current recorded item is shown below.'}
          </p>
          <Link className="button button-secondary" to="/inbox">
            All Inbox tasks
          </Link>
        </Card>
        {target.task.target?.kind === 'payment' ? (
          <PaymentSourceReview
            key={key}
            setup={setup}
            paymentId={target.task.target.paymentId}
          />
        ) : (
          <OwnerTaskInbox
            key={key}
            setup={setup}
            focusTask={target.task.id}
            resolved={target.task.status === 'resolved'}
          />
        )}
      </>
    );
  return (
    <Card className="app-panel urgent-target-status">
      <h1>Open the urgent item</h1>
      <p role="status">
        {!notice
          ? 'This notification link is incomplete. Open Inbox to review current work.'
          : !sameOutlet
            ? 'This alert belongs to a different outlet. Choose its outlet and member in More, then check this original link again.'
            : !view?.online
              ? 'Connect to check the current item. Inbox and saved originals remain available.'
              : !eligible
                ? 'Use the original phone account and this browser’s active alert setup to check this item.'
                : current?.error ||
                  'Checking the current item and your access…'}
      </p>
      <div className="desk-actions">
        <Button
          disabled={!eligible || !current?.error}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Check original alert again
        </Button>
        <Link className="button button-secondary" to="/inbox">
          Open Inbox
        </Link>
        <Link className="button button-secondary" to="/more">
          Choose outlet or member
        </Link>
        <Link to="/settings/notifications">Notification settings</Link>
        <Link to="/settings/sync">Sync setup</Link>
      </div>
    </Card>
  );
}
