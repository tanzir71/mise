import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import { formatMoney } from '@mise/core/money';
import { activePaymentPosting } from '@mise/core/payment-posting-shape';
import type { PaymentMoneyTarget } from '@mise/core/payment-finance';
import { newInboxId } from '@mise/core/inbox';
import { PaymentCheckedForm } from './PaymentCheckedForm';
import { db } from './data/db';
import { readPaymentMoneyChoices } from './data/payment-review';
import {
  associateSavedPayment,
  compareSavedPayment,
  unmatchSavedPayment,
  setSavedPaymentVoided,
  editSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
  recoverSavedPaymentMoneyAction,
  savedPaymentReceipt,
  type SavedPaymentSource,
  type SavedPaymentReceipt,
  type SavedPaymentMatches,
  type SavedPaymentMoneyComparison,
  type SavedPaymentUndoComparison,
} from './data/payment-capture';
import { errorText, khataDate } from './khata-data';

const historyLabels: Record<string, string> = {
  'payment.capture': 'Details saved',
  'payment.edit': 'Checked details changed',
  'payment.match': 'Receipt or order linked',
  'payment.unmatch': 'Link removed',
  'payment.record': 'Received money recorded',
  'payment.record-undo': 'Original financial undo saved',
  'payment.void': 'Observation set aside',
  'payment.reopen': 'Observation reopened',
};

export function PaymentCaptureActions({
  setup,
  review,
  saved,
  blocked,
  archived,
  onSaved,
}: {
  setup: SetupSnapshot;
  review: SavedPaymentSource;
  saved: SavedPaymentReceipt;
  blocked: boolean;
  archived: boolean;
  onSaved: (value: SavedPaymentReceipt, message?: string) => void;
}) {
  const p = saved.payment,
    posting = activePaymentPosting(p);
  const [editing, setEditing] = useState(false),
    [matches, setMatches] = useState<SavedPaymentMatches>(),
    [windowMinutes, setWindowMinutes] = useState('30'),
    [kind, setKind] = useState(''),
    [targetId, setTargetId] = useState(''),
    [who, setWho] = useState(''),
    [note, setNote] = useState('');
  const [plan, setPlan] = useState<{
      comparison: SavedPaymentMoneyComparison;
      id: string;
    }>(),
    [undo, setUndo] = useState<{
      comparison: SavedPaymentUndoComparison;
      id: string;
    }>(),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [historyLimit, setHistoryLimit] = useState(10);
  const running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const choices = useLiveQuery(async () => {
    try {
      return { data: await readPaymentMoneyChoices(db, setup, p) };
    } catch (problem) {
      return { error: errorText(problem) };
    }
  }, [setup, p]);
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (problem) {
      if (alive.current) {
        setError(errorText(problem));
        setConfirmed(false);
      }
      try {
        const actual = await savedPaymentReceipt(db, review);
        if (actual && alive.current) onSaved(actual);
      } catch {
        /* Keep the original and the visible failure for a fresh open. */
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function write(
    task: () => Promise<SavedPaymentReceipt>,
    message: string,
  ) {
    await run(async () => {
      const value = await task();
      if (alive.current) onSaved(value, message);
    });
  }
  const disabled = busy || blocked || archived,
    available = p.voidedAt === undefined;
  function clearPlan() {
    setPlan(undefined);
    setUndo(undefined);
    setConfirmed(false);
  }
  async function compareMoney() {
    await run(async () => {
      let target: PaymentMoneyTarget;
      if (kind === 'counter') target = { kind, who };
      else if ((kind === 'order' || kind === 'credit') && targetId)
        target = { kind, id: targetId };
      else
        throw Error(
          'Choose an actual order, customer account or a new counter receipt.',
        );
      const comparison = await compareSavedPaymentMoney(
        db,
        review,
        target,
        note,
      );
      if (alive.current) {
        setPlan({ comparison, id: newInboxId() });
        setUndo(undefined);
        setConfirmed(false);
      }
    });
  }
  async function recordMoney() {
    if (!plan) return;
    await write(async () => {
      try {
        return await recordSavedPaymentMoney(
          db,
          review,
          plan.comparison,
          confirmed,
          plan.id,
        );
      } catch (problem) {
        const original = await recoverSavedPaymentMoneyAction(
          db,
          review,
          { id: plan.id, revision: plan.comparison.revision },
          'record',
        );
        if (original) return original.receipt;
        throw problem;
      }
    }, 'Received money recorded once. Its original receipt is kept.');
  }
  async function undoMoney() {
    if (!undo) return;
    await write(async () => {
      try {
        return await undoSavedPaymentMoney(
          db,
          review,
          undo.comparison,
          confirmed,
          undo.id,
        );
      } catch (problem) {
        const original = await recoverSavedPaymentMoneyAction(
          db,
          review,
          { id: undo.id, revision: undo.comparison.revision },
          'undo',
        );
        if (original) return original.receipt;
        throw problem;
      }
    }, 'Original financial undo saved. The source and history are kept.');
  }
  if (editing)
    return (
      <>
        <PaymentCheckedForm
          setup={setup}
          parsed={saved.original.parsed}
          payment={p}
          disabled={disabled}
          onSave={(input) =>
            write(
              () =>
                editSavedPayment(
                  db,
                  review,
                  { id: newInboxId(), revision: p.revision },
                  input,
                ),
              'Checked details updated; the original proposal is kept.',
            )
          }
          onCancel={() => setEditing(false)}
        />
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </>
    );
  return (
    <section className="payment-saved" aria-label="Saved payment review">
      <header>
        <h2>
          {posting
            ? 'Money recorded'
            : p.association
              ? 'Payment linked'
              : available
                ? 'Details saved'
                : 'Set aside'}
        </h2>
        <p>
          {formatMoney(p.amount, p.currency)} · {p.methodName}
        </p>
      </header>
      <p>
        Times below use {setup.outlet.timezone}; the original source clock is
        kept in history.
      </p>
      <dl className="payment-details">
        <div>
          <dt>Reference</dt>
          <dd dir="auto">
            {p.reference || 'None entered'}
            {p.referenceScope ? ' · ' + p.referenceScope : ''}
          </dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{khataDate(p.receivedAt, setup, true)}</dd>
        </div>
        <div>
          <dt>Details saved</dt>
          <dd>{khataDate(p.createdAt, setup, true)}</dd>
        </div>
      </dl>
      {blocked ? (
        <p role="status">
          This review is currently available for local shops. Keep this source
          and its history here; use the manual payment form for this connected
          shop.
        </p>
      ) : null}
      {archived ? (
        <p role="status">
          This source is archived. Reopen it in Inbox before changing this
          review.
        </p>
      ) : null}
      {posting ? (
        <section className="payment-financial-original">
          <h3>Original financial recording</h3>
          <p>
            {formatMoney(posting.money.amount, posting.money.currency)} ·{' '}
            {posting.money.methodName}
          </p>
          <p>
            Recorded {khataDate(posting.at, setup, true)}. Received{' '}
            {khataDate(posting.money.receivedAt, setup, true)}.
          </p>
          <p>
            {posting.target.kind === 'order'
              ? 'Order'
              : posting.target.kind === 'credit'
                ? 'Customer account'
                : 'Counter receipt'}{' '}
            · {posting.target.id.slice(-8)}. Receipt ·{' '}
            {posting.receipt.id.slice(-8)}.
          </p>
          {posting.target.kind === 'order' ? (
            <Link to={'/orders/' + posting.target.id}>Open actual order</Link>
          ) : posting.receipt.kind === 'sale' ? (
            <Link to="/counter">Open counter receipts</Link>
          ) : (
            <Link to="/khata">Open customer accounts</Link>
          )}
          {posting.note ? <p dir="auto">{posting.note}</p> : null}
          {saved.associationCurrent === false ? (
            <p>
              The actual financial receipt changed after this recording. Check
              its current history before correcting it.
            </p>
          ) : null}
          <Button
            kind="secondary"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                const comparison = await compareSavedPaymentMoneyUndo(
                  db,
                  review,
                );
                if (alive.current) {
                  setUndo({ comparison, id: newInboxId() });
                  setPlan(undefined);
                  setConfirmed(false);
                }
              })
            }
          >
            Review original undo
          </Button>
        </section>
      ) : p.association ? (
        <section className="payment-association">
          <h3>
            {p.association.kind === 'order'
              ? 'Linked unpaid order'
              : 'Linked recorded receipt'}
          </h3>
          <p>
            {p.association.kind === 'order'
              ? 'This link records no money. If the money arrived, review a separate financial payment for this order.'
              : 'The money was already recorded. Linking it changes no balance or sales total.'}
          </p>
          <p>
            {saved.associationCurrent === false
              ? 'The linked record changed. Check it again.'
              : 'The original link is kept with this source.'}
          </p>
          {p.association.kind === 'order' ? (
            <>
              <Link to={'/orders/' + p.association.id}>Open linked order</Link>
              <label className="inbox-field">
                Recording note (optional)
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={note}
                  disabled={disabled}
                  onChange={(event) => {
                    setNote(event.target.value);
                    clearPlan();
                  }}
                />
              </label>
              <Button
                kind="secondary"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    const comparison = await compareSavedPaymentMoney(
                      db,
                      review,
                      { kind: 'order', id: p.association!.id },
                      note,
                    );
                    if (alive.current) {
                      setPlan({ comparison, id: newInboxId() });
                      setUndo(undefined);
                      setConfirmed(false);
                    }
                  })
                }
              >
                Review payment for linked order
              </Button>
            </>
          ) : null}
          <Button
            kind="secondary"
            disabled={disabled}
            onClick={() =>
              void write(
                () =>
                  unmatchSavedPayment(db, review, {
                    id: newInboxId(),
                    revision: p.revision,
                  }),
                'Link removed. Recorded money is unchanged.',
              )
            }
          >
            Remove link
          </Button>
        </section>
      ) : available ? (
        <>
          <section className="payment-matches">
            <h3>Find an existing match</h3>
            <p>
              Match by the checked amount and received time. A link records no
              new money.
            </p>
            <label className="inbox-field">
              Matching window (minutes)
              <input
                type="number"
                min="1"
                max="1440"
                step="1"
                value={windowMinutes}
                disabled={disabled}
                onChange={(event) => {
                  setWindowMinutes(event.target.value);
                  setMatches(undefined);
                }}
              />
            </label>
            <Button
              kind="secondary"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  if (
                    !/^\d+$/.test(windowMinutes) ||
                    Number(windowMinutes) < 1 ||
                    Number(windowMinutes) > 1440
                  )
                    throw Error(
                      'Choose a matching window from 1 to 1,440 minutes.',
                    );
                  const value = await compareSavedPayment(db, review, {
                    windowMs: Number(windowMinutes) * 60000,
                    receivedTimeConfirmed: true,
                  });
                  if (alive.current) setMatches(value);
                })
              }
            >
              Find matches
            </Button>
            {matches ? (
              <>
                <p role="status">
                  {matches.result.eligibleCount === 0
                    ? 'No current match found.'
                    : matches.result.eligibleCount === 1
                      ? 'One current match found.'
                      : 'Showing the closest ' +
                        matches.result.candidates.length +
                        ' of ' +
                        matches.result.eligibleCount +
                        ' current matches.'}
                </p>
                <ul className="payment-match-list">
                  {matches.result.candidates.map((candidate) => (
                    <li key={candidate.kind + candidate.id}>
                      <strong dir="auto">{candidate.label}</strong>
                      <span>
                        {candidate.customerName} ·{' '}
                        {formatMoney(candidate.amount, candidate.currency)}
                      </span>
                      <span>
                        {khataDate(candidate.at, setup, true)} ·{' '}
                        {candidate.state === 'recorded'
                          ? 'Money already recorded'
                          : 'Unpaid order'}
                      </span>
                      <Button
                        kind="secondary"
                        disabled={disabled}
                        onClick={() =>
                          void write(
                            () =>
                              associateSavedPayment(
                                db,
                                review,
                                matches,
                                candidate,
                                newInboxId(),
                              ),
                            'Payment linked. No new money was recorded.',
                          )
                        }
                      >
                        Link{' '}
                        {candidate.state === 'recorded'
                          ? 'existing receipt'
                          : 'unpaid order'}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
          <section className="payment-new-money">
            <h3>Record received money</h3>
            <p>
              Use this only when the money arrived and has no existing financial
              receipt.
            </p>
            <fieldset disabled={disabled}>
              <label className="inbox-field">
                Record against
                <select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value);
                    setTargetId('');
                    clearPlan();
                  }}
                >
                  <option value="">Choose what this pays</option>
                  <option value="order">An unpaid order</option>
                  <option value="credit">A customer's khata</option>
                  <option value="counter">A new counter receipt</option>
                </select>
              </label>
              {kind === 'order' ? (
                <label className="inbox-field">
                  Unpaid order
                  <select
                    value={targetId}
                    onChange={(event) => {
                      setTargetId(event.target.value);
                      clearPlan();
                    }}
                  >
                    <option value="">Choose order</option>
                    {choices?.data?.orders.map((order) => (
                      <option value={order.id} key={order.id}>
                        {order.number} · {order.customer.name || 'Customer'} ·{' '}
                        {formatMoney(p.amount, p.currency)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : kind === 'credit' ? (
                <label className="inbox-field">
                  Customer account
                  <select
                    value={targetId}
                    onChange={(event) => {
                      setTargetId(event.target.value);
                      clearPlan();
                    }}
                  >
                    <option value="">Choose customer</option>
                    {choices?.data?.accounts.map((account) => (
                      <option value={account.id} key={account.id}>
                        {account.label} · owes{' '}
                        {formatMoney(account.balance, p.currency)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : kind === 'counter' ? (
                <label className="inbox-field">
                  Who (optional)
                  <input
                    maxLength={120}
                    value={who}
                    onChange={(event) => {
                      setWho(event.target.value);
                      clearPlan();
                    }}
                  />
                </label>
              ) : null}
              <label className="inbox-field">
                Recording note (optional)
                <textarea
                  maxLength={4000}
                  rows={3}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    clearPlan();
                  }}
                />
              </label>
            </fieldset>
            {choices?.error ? <p role="alert">{choices.error}</p> : null}
            <Button
              kind="secondary"
              disabled={disabled || !kind || (kind !== 'counter' && !targetId)}
              onClick={() => void compareMoney()}
            >
              {plan ? 'Review latest money details' : 'Review new payment'}
            </Button>
          </section>
        </>
      ) : (
        <p>
          This observation is set aside. Its full source and history remain
          saved.
        </p>
      )}
      {plan ? (
        <section
          className="payment-confirm"
          aria-label="Confirm new received money"
        >
          <h3>Confirm new received money</h3>
          <p dir="auto">{plan.comparison.preview.label}</p>
          <p>
            {formatMoney(
              plan.comparison.preview.amount,
              plan.comparison.preview.currency,
            )}{' '}
            · {plan.comparison.preview.methodName}
          </p>
          <p>
            Received{' '}
            {khataDate(plan.comparison.preview.receivedAt, setup, true)}. The
            financial receipt will use the actual recording time.
          </p>
          {plan.comparison.preview.balance !== undefined ? (
            <p>
              Current debt{' '}
              {formatMoney(plan.comparison.preview.balance, p.currency)}.
            </p>
          ) : null}
          <label className="payment-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            This money was received and is not already recorded
          </label>
          <Button
            disabled={disabled || !confirmed}
            onClick={() => void recordMoney()}
          >
            Record received money
          </Button>
          <Button kind="ghost" disabled={busy} onClick={clearPlan}>
            Cancel new payment
          </Button>
        </section>
      ) : null}
      {undo ? (
        <section
          className="payment-confirm"
          aria-label="Confirm original financial undo"
        >
          <h3>
            {undo.comparison.preview.alreadyUndone
              ? 'Acknowledge original undo'
              : 'Undo original financial recording'}
          </h3>
          <p>
            Original receipt · {undo.comparison.preview.receiptId.slice(-8)}.
            Recorded{' '}
            {khataDate(undo.comparison.preview.recordedAt, setup, true)}.
          </p>
          {undo.comparison.preview.alreadyUndone ? (
            <p>
              The actual original money was already undone. This acknowledges
              that result without changing money again.
            </p>
          ) : undo.comparison.preview.expired ? (
            <p>
              The ten-minute undo window has ended. Open the actual order,
              account or counter history to make a manual correction.
            </p>
          ) : (
            <p>
              This undoes only this source's original financial recording. The
              full source and audit history stay saved.
            </p>
          )}
          <label className="payment-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled || undo.comparison.preview.expired}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I checked this original receipt and its undo
          </label>
          <Button
            disabled={disabled || !confirmed || undo.comparison.preview.expired}
            onClick={() => void undoMoney()}
          >
            {undo.comparison.preview.alreadyUndone
              ? 'Acknowledge original undo'
              : 'Undo this recording'}
          </Button>
          <Button kind="ghost" disabled={busy} onClick={clearPlan}>
            Keep original recording
          </Button>
        </section>
      ) : null}
      {!posting && !p.association ? (
        <div className="payment-actions">
          {available ? (
            <Button
              kind="secondary"
              disabled={disabled}
              onClick={() => {
                clearPlan();
                setEditing(true);
              }}
            >
              Edit checked details
            </Button>
          ) : null}
          <Button
            kind="ghost"
            disabled={disabled}
            onClick={() =>
              void write(
                () =>
                  setSavedPaymentVoided(
                    db,
                    review,
                    { id: newInboxId(), revision: p.revision },
                    available,
                  ),
                available
                  ? 'Observation set aside. Money is unchanged.'
                  : 'Observation reopened for review.',
              )
            }
          >
            {available ? 'Set observation aside' : 'Reopen observation'}
          </Button>
        </div>
      ) : null}
      <details className="payment-history">
        <summary>Original proposal and saved history</summary>
        <p>
          Original source · {saved.original.source}. Parser version{' '}
          {saved.original.parsed.parserVersion}. Source clock ·{' '}
          {saved.original.parsed.sourceContext.timeZone}.
        </p>
        <dl className="payment-details">
          <div>
            <dt>Original read</dt>
            <dd>
              {saved.original.parsed.status} · {saved.original.parsed.channel} ·{' '}
              {saved.original.parsed.direction}
            </dd>
          </div>
          <div>
            <dt>Proposed amount</dt>
            <dd>
              {saved.original.parsed.amount === null
                ? 'No amount found'
                : formatMoney(
                    saved.original.parsed.amount,
                    saved.original.parsed.currency,
                  )}
            </dd>
          </div>
          <div>
            <dt>Proposed reference</dt>
            <dd dir="auto">
              {saved.original.parsed.reference || 'No reference found'}
            </dd>
          </div>
          <div>
            <dt>Proposed time</dt>
            <dd>
              {new Intl.DateTimeFormat('en-GB', {
                timeZone: saved.original.parsed.sourceContext.timeZone,
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(saved.original.parsed.receivedAt)}{' '}
              · {saved.original.parsed.sourceContext.timeZone} ·{' '}
              {saved.original.parsed.timeSource === 'message'
                ? 'from the message'
                : 'saved-source time'}
            </dd>
          </div>
          <div>
            <dt>Sender label</dt>
            <dd dir="auto">
              {saved.original.parsed.sourceContext.sender || 'None entered'}
            </dd>
          </div>
          <div>
            <dt>Date order</dt>
            <dd>
              {saved.original.parsed.sourceContext.dateOrder ||
                'Market default; ambiguous dates require review'}
            </dd>
          </div>
        </dl>
        {saved.original.parsed.warnings.length ? (
          <ul>
            {saved.original.parsed.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <p>
          First checked amount{' '}
          {formatMoney(saved.original.amount, saved.original.currency)} ·{' '}
          {saved.original.methodName}. First checked received time{' '}
          {khataDate(saved.original.receivedAt, setup, true)}.
        </p>
        {p.postings
          ?.slice(-historyLimit)
          .reverse()
          .map((post) => (
            <article key={post.eventId}>
              <h3>
                {post.undo ? 'Original recording undone' : 'Original recording'}
              </h3>
              <p>
                {formatMoney(post.money.amount, post.money.currency)} ·{' '}
                {post.money.methodName} · {khataDate(post.at, setup, true)}
              </p>
              <p>
                Received {khataDate(post.money.receivedAt, setup, true)} ·{' '}
                {post.target.kind} · {post.target.id.slice(-8)}.
              </p>
              {post.note ? <p dir="auto">{post.note}</p> : null}
              {post.undo ? (
                <p>
                  {post.undo.mode === 'already-undone'
                    ? 'Original undo acknowledged'
                    : 'Undone'}{' '}
                  {khataDate(post.undo.at, setup, true)}.
                </p>
              ) : null}
            </article>
          ))}
        <ol>
          {saved.events
            .slice(-historyLimit)
            .reverse()
            .map((event) => (
              <li key={event.id}>
                {historyLabels[event.command] ?? event.command} ·{' '}
                {khataDate(event.at, setup, true)}
              </li>
            ))}
        </ol>
        {Math.max(saved.events.length, p.postings?.length ?? 0) >
        historyLimit ? (
          <Button kind="ghost" onClick={() => setHistoryLimit((n) => n + 20)}>
            Show older history
          </Button>
        ) : null}
      </details>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {busy ? <p role="status">Checking the original records…</p> : null}
    </section>
  );
}
