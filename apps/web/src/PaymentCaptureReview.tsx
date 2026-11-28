import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import type { Payment, SetupSnapshot } from '@mise/core/models';
import type { InboxDestination } from './data/inbox';
import { literalToken } from '@mise/core/literal-token';
import { activePaymentPosting } from '@mise/core/payment-posting-shape';
import { PaymentCheckedForm } from './PaymentCheckedForm';
import { PaymentCaptureActions } from './PaymentCaptureActions';
import { InboxPayment } from './InboxForms';
import { db } from './data/db';
import { readPaymentReviewFrame } from './data/payment-review';
import {
  openSavedPaymentSource,
  savedPaymentReceipt,
  recordSavedPayment,
  compareSavedPayment,
  associateSavedPayment,
  type SavedPaymentSource,
  type SavedPaymentReceipt,
} from './data/payment-capture';
import { errorText } from './khata-data';
import './payment-capture.css';

export function PaymentCaptureReview({
  setup,
  itemId,
  onDone,
}: {
  setup: SetupSnapshot;
  itemId: string;
  onDone: () => void;
}) {
  const frame = useLiveQuery(async () => {
    try {
      return { value: await readPaymentReviewFrame(db, setup, itemId) };
    } catch (problem) {
      return { error: errorText(problem) };
    }
  }, [setup, itemId]);
  if (frame?.error)
    return (
      <div className="inbox-manual">
        <h2>Keep the original source</h2>
        <p role="alert">{frame.error}</p>
        <Link to="/inbox">Open current Inbox</Link>
        <Link to="/settings/exports">Download a local backup</Link>
      </div>
    );
  if (!frame?.value)
    return <p aria-busy="true">Opening the saved payment source…</p>;
  const f = frame.value;
  return (
    <OpenedPayment
      key={f.key}
      setup={f.setup}
      itemId={itemId}
      destination={f.destination}
      blocked={f.blocked}
      nativeEligible={f.nativeEligible}
      frameKey={f.key}
      archived={f.item.archived}
      onDone={onDone}
    />
  );
}
type Options = {
  sender?: string;
  timeZone?: string;
  dateOrder?: 'DMY' | 'MDY';
  kind?: Payment['source'];
};
function OpenedPayment({
  setup,
  itemId,
  destination,
  blocked: frameBlocked,
  nativeEligible,
  frameKey,
  archived,
  onDone,
}: {
  setup: SetupSnapshot;
  itemId: string;
  destination: InboxDestination;
  blocked: boolean;
  nativeEligible: boolean;
  frameKey: string;
  archived: boolean;
  onDone: () => void;
}) {
  const [openedDestination] = useState(() => structuredClone(destination)),
    [review, setReview] = useState<SavedPaymentSource>(),
    [optimistic, setOptimistic] = useState<SavedPaymentReceipt | null>(null),
    [manual, setManual] = useState(false),
    [sender, setSender] = useState(''),
    [zone, setZone] = useState(setup.outlet.timezone),
    [dateOrder, setDateOrder] = useState(''),
    [sourceKind, setSourceKind] = useState<Payment['source']>('sms'),
    [appliedKind, setAppliedKind] = useState<Payment['source']>('sms'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [copyFallback, setCopyFallback] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const blocked = frameBlocked && !(nativeEligible && nativeReady);
  const alive = useRef(true),
    running = useRef(false),
    generation = useRef(0),
    sourceHandle = useRef<{ stop(): void }>(),
    opening = useRef<AbortController>();
  const live = useLiveQuery(async () => {
    if (!review) return undefined;
    try {
      return { value: await savedPaymentReceipt(db, review) };
    } catch (problem) {
      return { error: errorText(problem) };
    }
  }, [review]);
  const saved =
    live?.value &&
    (!optimistic || live.value.payment.revision >= optimistic.payment.revision)
      ? live.value
      : optimistic;
  async function open(options: Options) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNativeReady(false);
    sourceHandle.current?.stop();
    sourceHandle.current = undefined;
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    const attempt = ++generation.current;
    try {
      let value: SavedPaymentSource;
      let handle:
        { review: SavedPaymentSource; native: true; stop(): void } | undefined;
      let connectionProblem = '';
      if (nativeEligible) {
        try {
          const { openConfiguredPaymentSource } =
            await import('./data/payment-review-session');
          handle = await openConfiguredPaymentSource(
            db,
            setup,
            itemId,
            frameKey,
            options,
            {
              storage: localStorage,
              base: import.meta.env.BASE_URL,
            },
            controller.signal,
          );
        } catch (problem) {
          controller.signal.throwIfAborted();
          connectionProblem = errorText(problem);
        }
      }
      if (handle) value = handle.review;
      else
        value = await openSavedPaymentSource(
          db,
          itemId,
          openedDestination,
          options,
        );
      if (alive.current && attempt === generation.current) {
        sourceHandle.current = handle;
        setNativeReady(!!handle);
        setError(connectionProblem);
        setReview(value);
        setAppliedKind(options.kind ?? 'sms');
        setOptimistic(null);
        setMessage('');
      } else handle?.stop();
    } catch (problem) {
      if (alive.current && attempt === generation.current)
        setError(errorText(problem));
    } finally {
      if (attempt === generation.current) {
        running.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void open({});
    return () => {
      alive.current = false;
      generation.current++;
      running.current = false;
      opening.current?.abort();
      sourceHandle.current?.stop();
    };
  }, [itemId, openedDestination, frameKey, nativeEligible]);
  function receive(value: SavedPaymentReceipt, text?: string) {
    if (!alive.current) return;
    setOptimistic(value);
    if (text) setMessage(text);
  }
  async function save(input: Parameters<typeof recordSavedPayment>[2]) {
    if (!review || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      let value = await recordSavedPayment(db, review, input);
      receive(value, 'Checked details saved. No new money was recorded.');
      const comparison = await compareSavedPayment(db, review, {
        receivedTimeConfirmed: true,
      });
      if (comparison.result.selection === 'automatic') {
        value = await associateSavedPayment(
          db,
          review,
          comparison,
          comparison.result.candidates[0],
        );
        receive(
          value,
          'One current match linked automatically. No new money was recorded.',
        );
      }
    } catch (problem) {
      if (alive.current) setError(errorText(problem));
      try {
        const actual = await savedPaymentReceipt(db, review);
        if (actual) receive(actual);
      } catch {
        /* An unreadable original remains available for manual recovery. */
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const text = review
    ? [review.original.title, review.original.text, review.original.url]
        .filter(Boolean)
        .join('\n')
    : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current) setMessage('Full original source copied.');
    } catch {
      if (alive.current) {
        setCopyFallback(true);
        setMessage('Select the complete original below and copy it.');
      }
    }
  }
  if (!review)
    return (
      <div className="inbox-manual">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button
              kind="secondary"
              disabled={busy}
              onClick={() => void open({})}
            >
              Open saved source again
            </Button>
            <Link to="/inbox">Keep original in Inbox</Link>
          </>
        ) : (
          <p aria-busy="true">Reading the original payment text…</p>
        )}
      </div>
    );
  const settingsDirty =
    sender !== (review.parsed.sourceContext.sender ?? '') ||
    zone !== review.parsed.sourceContext.timeZone ||
    dateOrder !== (review.parsed.sourceContext.dateOrder ?? '') ||
    sourceKind !== appliedKind;
  const originalParsed = saved?.original.parsed ?? review.parsed,
    post = saved ? activePaymentPosting(saved.payment) : undefined;
  return (
    <div className="inbox-manual payment-capture" aria-busy={busy}>
      <div className="payment-actions">
        <Button
          kind="secondary"
          onClick={() => setManual((v) => !v)}
          disabled={busy}
        >
          {manual
            ? 'Back to saved-source review'
            : 'Use manual customer payment'}
        </Button>
        <Button kind="ghost" onClick={() => void copy()}>
          Copy full original
        </Button>
      </div>
      {copyFallback ? (
        <label className="inbox-field">
          Complete original for copying
          <textarea
            readOnly
            rows={6}
            value={text}
            onFocus={(event) => event.target.select()}
          />
        </label>
      ) : null}
      {manual ? (
        <>
          {post ? (
            <p role="alert">
              This source already recorded money. A manual payment creates
              another financial receipt. Review the original recording before
              entering any correction.
            </p>
          ) : null}
          <InboxPayment
            setup={setup}
            text={review.original.text || review.original.title}
            onDone={onDone}
          />
        </>
      ) : live?.error ? (
        <>
          <p role="alert">{live.error}</p>
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => void open({})}
          >
            Inspect saved source again
          </Button>
          <Link to="/settings/exports">Download a local backup</Link>
        </>
      ) : live === undefined && !optimistic ? (
        <p aria-busy="true">Checking saved payment history…</p>
      ) : saved && busy ? (
        <p aria-busy="true">Checking the saved details and current matches…</p>
      ) : saved ? (
        <PaymentCaptureActions
          key={saved.payment.revision}
          setup={setup}
          review={review}
          saved={saved}
          blocked={blocked}
          archived={archived}
          onSaved={receive}
        />
      ) : (
        <>
          <h2>Review payment text</h2>
          <p>
            The complete original stays in Inbox. Reading and matching never
            verify that a transfer arrived.
          </p>
          <details className="payment-source-settings">
            <summary>Source settings</summary>
            <p>
              Reading with changed settings replaces unsaved draft edits. Saved
              originals keep their original settings.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void open({
                  sender,
                  timeZone: zone,
                  ...(dateOrder
                    ? { dateOrder: dateOrder as 'DMY' | 'MDY' }
                    : {}),
                  kind: sourceKind,
                });
              }}
            >
              <fieldset disabled={busy}>
                <label className="inbox-field">
                  Sender label (optional)
                  <input
                    maxLength={120}
                    value={sender}
                    onChange={(event) => setSender(event.target.value)}
                  />
                </label>
                <label className="inbox-field">
                  Source timezone
                  <input
                    required
                    value={zone}
                    onChange={(event) => setZone(event.target.value)}
                  />
                </label>
                <label className="inbox-field">
                  Numeric date order
                  <select
                    value={dateOrder}
                    onChange={(event) => setDateOrder(event.target.value)}
                  >
                    <option value="">Ask when ambiguous</option>
                    <option value="DMY">Day / month / year</option>
                    <option value="MDY">Month / day / year</option>
                  </select>
                </label>
                <label className="inbox-field">
                  Source type
                  <select
                    value={sourceKind}
                    onChange={(event) =>
                      setSourceKind(event.target.value as Payment['source'])
                    }
                  >
                    <option value="sms">SMS text</option>
                    <option value="notification">Notification text</option>
                    <option value="manual">Entered by hand</option>
                  </select>
                </label>
                <Button kind="secondary" type="submit">
                  Read with these settings
                </Button>
              </fieldset>
            </form>
          </details>
          {blocked ? (
            <p role="status">
              Keep this source and its recorded history. Use the manual payment
              form for any new payment.{' '}
              <Link to="/settings/sync">Review this device’s connection</Link>
            </p>
          ) : archived ? (
            <p role="status">
              Reopen the source in Inbox before saving payment details.
            </p>
          ) : null}
          {settingsDirty ? (
            <p role="status">
              Read with the changed source settings before saving details.
            </p>
          ) : null}
          <PaymentCheckedForm
            key={literalToken({ originalParsed, appliedKind })}
            setup={setup}
            parsed={originalParsed}
            disabled={busy || blocked || archived || settingsDirty}
            onSave={save}
          />
        </>
      )}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <footer className="payment-actions">
        <Button kind="ghost" disabled={busy} onClick={onDone}>
          Keep this review
        </Button>
        <Link to="/settings/exports">Backup and restore</Link>
      </footer>
    </div>
  );
}
