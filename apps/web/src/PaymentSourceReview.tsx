import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import { formatMoney, parseMoney } from '@mise/core/money';
import { normalisePhone } from '@mise/core/phone';
import { ownerTaskText } from '@mise/core/owner-tasks';
import type {
  ObservedPayment,
  PaymentCandidatePage,
  PaymentMatchPage,
  PaymentMatchTarget,
} from '@mise/core/payment-sources';
import { usePaymentSources, type PaymentSources } from './use-payment-sources';
import type { SavedPaymentSource } from './data/payment-source-journal';
import { PaymentRequestSource } from './PaymentRequestSource';
import { khataDate } from './khata-data';
import './owner-tasks.css';
import './payment-sources.css';
const statuses = {
  unmatched: 'Needs a match',
  matched: 'Matched to a recorded receipt',
  review: 'Recorded receipt changed — review again',
  dismissed: 'Source dismissed',
};

export function PaymentSourceReview({
  setup,
  paymentId,
}: {
  setup: SetupSnapshot;
  paymentId?: string;
}) {
  const owner = usePaymentSources(setup);
  return owner.ready ? (
    <PaymentBoard
      key={owner.ready.ticket + ':' + (paymentId ?? 'new')}
      setup={setup}
      ready={owner.ready}
      paymentId={paymentId}
      refreshAccess={owner.refresh}
    />
  ) : (
    <div className="owner-tasks">
      <h1>Payment review</h1>
      <Card className="app-panel">
        <h2>
          {owner.checking
            ? 'Opening saved requests…'
            : 'Open this installation’s payment review'}
        </h2>
        <p role="status">
          {owner.error ||
            'Checking the original phone account saved on this device.'}
        </p>
        <Link to="/settings/sync" className="button button-primary">
          Open Sync setup
        </Link>
        <Button
          kind="secondary"
          onClick={owner.refresh}
          disabled={owner.checking}
        >
          Refresh access
        </Button>
        <Link to="/settings/payments/recovery">
          Saved payment requests from any outlet
        </Link>
        <Link to="/inbox">Back to Inbox</Link>
      </Card>
    </div>
  );
}
function PaymentBoard({
  setup,
  ready,
  paymentId,
  refreshAccess,
}: {
  setup: SetupSnapshot;
  ready: PaymentSources;
  paymentId?: string;
  refreshAccess: () => void;
}) {
  const [source, setSource] = useState<ObservedPayment | null>(null),
    [checkedAt, setCheckedAt] = useState<number | null>(null),
    [fresh, setFresh] = useState(false),
    [needsReview, setNeedsReview] = useState(false),
    [page, setPage] = useState<PaymentCandidatePage | null>(null),
    [quote, setQuote] = useState<PaymentMatchPage | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(''),
    [saved, setSaved] = useState<SavedPaymentSource | null>(
      () => ready.session.saved().actions.at(-1) ?? null,
    ),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [copyText, setCopyText] = useState<string | null>(null);
  const running = useRef(false),
    generation = useRef(0),
    sourceFingerprint = useRef<string | null>(null),
    reviewRequired = useRef(false),
    area = useRef<HTMLTextAreaElement>(null),
    copyId = useId(),
    reasonId = useId(),
    navigate = useNavigate(),
    pending = !!saved && (!saved.receipt || saved.receipt.state === 'pending');
  const invalidate = () => {
    generation.current++;
    setQuote(null);
    setConfirmed(false);
    setPage(null);
    setCopyText(null);
    setFresh(false);
  };
  useEffect(() => {
    const unsubscribe = ready.session.subscribe(() => {
      if (ready.active())
        try {
          setSaved(ready.session.saved().actions.at(-1) ?? null);
        } catch {
          setError('Keep the original data on this device and refresh access.');
        }
    });
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [ready]);
  useEffect(() => {
    if (copyText === null) return;
    const frame = requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [copyText]);
  useEffect(() => {
    if (!paymentId) return;
    let alive = true,
      reading = false;
    const controller = new AbortController();
    setFresh(false);
    setQuote(null);
    setConfirmed(false);
    setPage(null);
    const load = async () => {
      if (
        !alive ||
        reading ||
        running.current ||
        document.visibilityState === 'hidden'
      )
        return;
      reading = true;
      const ticket = generation.current;
      try {
        const result = await ready.session.read(paymentId, controller.signal);
        if (
          alive &&
          ready.active() &&
          ticket === generation.current &&
          !running.current
        ) {
          if (
            sourceFingerprint.current &&
            sourceFingerprint.current !== result.source.fingerprint
          ) {
            generation.current++;
            setQuote(null);
            setConfirmed(false);
            setPage(null);
            setCopyText(null);
            reviewRequired.current = true;
            setNeedsReview(true);
            setMessage(
              'This source changed. Review the updated details before another choice. Your draft is retained.',
            );
          }
          sourceFingerprint.current = result.source.fingerprint;
          setSource(result.source);
          setCheckedAt(result.at);
          setFresh(!reviewRequired.current);
          setError('');
        }
      } catch (problem) {
        if (
          alive &&
          ready.active() &&
          ticket === generation.current &&
          !running.current
        ) {
          generation.current++;
          setFresh(false);
          setQuote(null);
          setPage(null);
          setCopyText(null);
          if (isAuth(problem)) setSource(null);
          setError(
            isAuth(problem)
              ? 'Current outlet access is unavailable. Your saved original requests remain below.'
              : 'The current source could not be checked. Reconnect or refresh before another review.',
          );
        }
      } finally {
        reading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000),
      resume = () => void load();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [ready, paymentId, version]);
  async function work(run: () => Promise<void>, refresh = true) {
    if (running.current) return;
    running.current = true;
    generation.current++;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await run();
      if (refresh && ready.active()) {
        invalidate();
        setVersion((v) => v + 1);
      }
    } catch (problem) {
      if (ready.active()) {
        invalidate();
        if (isAuth(problem)) setSource(null);
        setError(
          isAuth(problem)
            ? 'Use the original phone account and current outlet access. Your saved requests are retained.'
            : 'This step is unconfirmed or the source changed. Check the saved original result before another choice; otherwise refresh the source.',
        );
      }
    } finally {
      running.current = false;
      if (ready.active()) {
        try {
          setSaved(ready.session.saved().actions.at(-1) ?? null);
        } catch {
          setError(
            'Saved originals could not be read. Keep this browser’s data.',
          );
        }
        setBusy(false);
      }
    }
  }
  async function copy(value: string) {
    const at = generation.current,
      check = async () => {
        await ready.session.assertCurrent();
        if (at !== generation.current || !ready.active()) throw Error();
      };
    try {
      await check();
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        await check();
        setCopyText(value);
        return;
      }
      await check();
      setMessage('Copied.');
    } catch {
      /* An older copy cannot reopen private text after scope changes. */
    }
  }
  async function recover(operation: 'inspect' | 'submit' | 'close') {
    if (!saved) return;
    await work(async () => {
      const receipt = await ready.session.call(
        saved.intent.id,
        operation,
        ready.signal,
      );
      if (!ready.active()) return;
      expectedReceipt(receipt);
      setMessage(
        receipt.state === 'pending'
          ? 'No accepted result yet. Keep this exact original until it is retried or closed.'
          : receipt.state === 'applied'
            ? 'The original result was recorded once. Current source facts are checked separately.'
            : 'The original request is closed; a delayed submission cannot apply it.',
      );
      if (receipt.state === 'applied' && saved.intent.type === 'capture')
        navigate('/inbox/payments/' + saved.intent.paymentId);
    });
  }
  async function capture(
    draft: Parameters<PaymentSources['session']['prepareCapture']>[0],
  ) {
    await work(async () => {
      const original = await ready.session.prepareCapture(draft);
      setSaved(ready.session.saved().actions.at(-1) ?? null);
      const receipt = await ready.session.call(
        original.id,
        'submit',
        ready.signal,
      );
      if (ready.active() && receipt.state === 'applied')
        navigate('/inbox/payments/' + original.paymentId);
    });
  }
  function expectedReceipt(receipt: {
    state: string;
    after: ObservedPayment | null;
  }) {
    if (receipt.state === 'applied' && receipt.after) {
      sourceFingerprint.current = receipt.after.fingerprint;
      reviewRequired.current = false;
      setNeedsReview(false);
    }
  }
  async function choose(target: PaymentMatchTarget) {
    if (!source || !fresh) return;
    await work(async () => {
      const result = await ready.session.match(
        source,
        target.kind,
        target.id,
        ready.signal,
      );
      if (!result.eligible || !result.target)
        throw Error('Receipt unavailable');
      if (ready.active()) {
        setQuote(result);
        setConfirmed(false);
      }
    }, false);
  }
  async function receipts(older = false) {
    if (!source || !fresh) return;
    await work(async () => {
      const result = await ready.session.candidates(
        source,
        older ? (page?.next ?? null) : null,
        ready.signal,
      );
      if (ready.active()) {
        setPage(result);
        setQuote(null);
        setConfirmed(false);
      }
    }, false);
  }
  async function change(
    value: Parameters<PaymentSources['session']['prepare']>[1],
    current = source,
  ) {
    if (!current || !fresh) return;
    const originalSource = current;
    await work(async () => {
      let reviewedSource = originalSource;
      if (value.type === 'link') {
        const checked = await ready.session.match(
          reviewedSource,
          value.target.kind,
          value.target.id,
          ready.signal,
        );
        if (
          !checked.eligible ||
          !checked.target ||
          checked.target.fingerprint !== value.target.fingerprint
        )
          throw Error('Receipt changed during review');
        reviewedSource = checked.source;
        value = { ...value, target: checked.target };
      }
      const original = await ready.session.prepare(reviewedSource, value);
      setSaved(ready.session.saved().actions.at(-1) ?? null);
      const receipt = await ready.session.call(
        original.id,
        'submit',
        ready.signal,
      );
      if (ready.active()) {
        expectedReceipt(receipt);
        setMessage(
          receipt.state === 'applied'
            ? 'Review recorded. No money was posted or reversed.'
            : 'The original request is closed.',
        );
        setReason('');
      }
    });
  }
  const disabled = busy || pending || !fresh,
    sourceCopy = source
      ? [
          formatMoney(source.amount, source.currency) +
            ' · ' +
            ownerTaskText(source.methodNameJson, 80),
          ownerTaskText(source.referenceJson, 4000),
          ownerTaskText(source.sourceJson, 16000),
        ].join('\n')
      : '';
  return (
    <div className="owner-tasks payment-review" data-node-id="103:900">
      <header className="owner-task-heading">
        <div>
          <h1>{paymentId ? 'Review payment source' : 'Add payment by hand'}</h1>
          <p>Keep the original observation and check its recorded receipt.</p>
        </div>
        <div>
          <Link className="button button-secondary" to="/inbox">
            Back to Inbox
          </Link>
          {paymentId ? (
            <Button
              kind="secondary"
              disabled={busy}
              onClick={() => {
                invalidate();
                reviewRequired.current = false;
                setNeedsReview(false);
                setVersion((v) => v + 1);
              }}
            >
              {needsReview ? 'Review updated source' : 'Refresh source'}
            </Button>
          ) : null}
          <Button kind="ghost" disabled={busy} onClick={refreshAccess}>
            Refresh access
          </Button>
        </div>
      </header>
      <p className="owner-task-caption">
        An observation does not record money. Matching links a receipt already
        recorded by this shop.
      </p>
      {error ? (
        <p role="alert" className="owner-task-error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {saved ? (
        <section aria-label="Saved payment request">
          <h2>
            {pending
              ? 'Original request needs review'
              : 'Last saved payment request'}
          </h2>
          <PaymentRequestSource row={saved} />
          {pending ? (
            <>
              <p>
                A new choice waits until this exact original is confirmed or
                closed.
              </p>
              <div className="owner-task-actions">
                <Button
                  kind="secondary"
                  disabled={busy}
                  onClick={() => void recover('inspect')}
                >
                  Check original result
                </Button>
                <Button disabled={busy} onClick={() => void recover('submit')}>
                  {saved.closeRequested
                    ? 'Retry original closure'
                    : 'Retry original request'}
                </Button>
                <Button
                  kind="ghost"
                  disabled={busy}
                  onClick={() => void recover('close')}
                >
                  Close original request
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      {!paymentId ? (
        <CapturePayment
          setup={setup}
          disabled={busy || pending}
          save={capture}
        />
      ) : source ? (
        <>
          <p role="status" className="owner-task-caption">
            {fresh ? 'Checked source' : 'Last checked source — read-only'}
            {checkedAt !== null
              ? ' · ' + khataDate(checkedAt, setup, true)
              : ''}{' '}
            · {statuses[source.status]}
          </p>
          <div className="payment-review-grid">
            <Card className="owner-task-card payment-source-facts">
              <header>
                <h2>Observed payment</h2>
              </header>
              <p className="payment-amount">
                {formatMoney(source.amount, source.currency)}
              </p>
              <dl className="owner-task-saved-source">
                <div>
                  <dt>Method</dt>
                  <dd dir="auto">{ownerTaskText(source.methodNameJson, 80)}</dd>
                </div>
                <div>
                  <dt>Reference</dt>
                  <dd dir="auto">
                    {ownerTaskText(source.referenceJson, 4000) ||
                      'None recorded'}
                  </dd>
                </div>
                <div>
                  <dt>Received</dt>
                  <dd>{khataDate(source.receivedAt, setup, true)}</dd>
                </div>
                <div>
                  <dt>Recorded by</dt>
                  <dd dir="auto">{ownerTaskText(source.authorJson, 200)}</dd>
                </div>
                {source.fromPhone ? (
                  <div>
                    <dt>From</dt>
                    <dd>{source.fromPhone}</dd>
                  </div>
                ) : null}
              </dl>
              <details
                open={ownerTaskText(source.sourceJson, 16000).length < 300}
              >
                <summary>Complete original source</summary>
                <p className="owner-task-literal" dir="auto">
                  {ownerTaskText(source.sourceJson, 16000)}
                </p>
              </details>
              {source.reasonJson ? (
                <p dir="auto">
                  Review: {ownerTaskText(source.reasonJson, 4000)}
                </p>
              ) : null}
              {source.match ? (
                <section>
                  <h3>Recorded association</h3>
                  <Receipt target={source.match.target} setup={setup} />
                  <p>
                    {source.match.valid
                      ? 'The receipt still matches its recorded financial facts.'
                      : 'The recorded receipt changed or was reversed. Review it again; the original association remains historical.'}
                  </p>
                </section>
              ) : null}
              <footer>
                <Button kind="secondary" onClick={() => void copy(sourceCopy)}>
                  Copy source
                </Button>
              </footer>
            </Card>
            <Card className="owner-task-card payment-match-picker">
              <header>
                <h2>Recorded receipts</h2>
              </header>
              <p>
                Choose a receipt with the same amount, currency and method. Only
                records currently available to this outlet are offered.
              </p>
              <Button disabled={disabled} onClick={() => void receipts()}>
                Check recorded receipts
              </Button>
              {page ? (
                <>
                  <p className="owner-task-caption">
                    {page.targets.length} receipt
                    {page.targets.length === 1 ? '' : 's'} on this checked page.
                    A receipt is checked again when selected.
                  </p>
                  <div className="payment-candidates">
                    {page.targets.map((target) => (
                      <div key={target.kind + target.financialId}>
                        <Receipt target={target} setup={setup} />
                        <Button
                          kind="secondary"
                          disabled={disabled}
                          onClick={() => void choose(target)}
                        >
                          Review receipt {target.financialId.slice(-6)}
                        </Button>
                      </div>
                    ))}
                  </div>
                  {!page.targets.length ? (
                    <p>
                      No eligible receipt was found on this page. The source
                      stays open for manual review.
                    </p>
                  ) : null}
                  {page.next ? (
                    <Button
                      kind="secondary"
                      disabled={disabled}
                      onClick={() => void receipts(true)}
                    >
                      Older receipts
                    </Button>
                  ) : null}
                </>
              ) : null}
              <footer>
                <p>
                  No receipt yet? Record the actual collection through its
                  normal flow, then return to match it.
                </p>
                <div className="owner-task-actions">
                  <Link className="button button-secondary" to="/orders">
                    Open orders
                  </Link>
                  <Link className="button button-secondary" to="/khata">
                    Open customer ledger
                  </Link>
                  <Link className="button button-secondary" to="/counter">
                    Open counter
                  </Link>
                </div>
              </footer>
            </Card>
          </div>
          <Card className="owner-task-card">
            <h2>Review by hand</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void change({ type: 'dismiss', reason });
              }}
            >
              <div className="owner-task-field">
                <label htmlFor={reasonId}>Reason for dismissal</label>
                <textarea
                  id={reasonId}
                  rows={3}
                  maxLength={4000}
                  required
                  disabled={disabled}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="owner-task-actions">
                <Button
                  type="submit"
                  kind="secondary"
                  disabled={disabled || !reason.trim()}
                >
                  Dismiss source
                </Button>
                <Button
                  type="button"
                  kind="ghost"
                  disabled={disabled}
                  onClick={() => void change({ type: 'undo' })}
                >
                  {source.revision === 0
                    ? 'Withdraw observation'
                    : 'Undo last review'}
                </Button>
              </div>
            </form>
            <p>
              Dismissal and undo change the source review only. Recorded money
              stays unchanged.
            </p>
          </Card>
        </>
      ) : (
        <p role="status">
          Check this outlet’s current source. Your personal original requests
          remain available above.
        </p>
      )}
      <Link to="/settings/payments/recovery">
        Saved payment requests from any outlet
      </Link>
      <Modal
        open={quote !== null}
        title="Confirm recorded receipt"
        variant="sheet"
        closeLabel="Close receipt review"
        onClose={() => {
          setQuote(null);
          setConfirmed(false);
        }}
      >
        {quote?.target ? (
          <div className="owner-task-detail">
            <h3>
              Observed:{' '}
              {formatMoney(quote.source.amount, quote.source.currency)}
            </h3>
            <p dir="auto">{ownerTaskText(quote.source.sourceJson, 16000)}</p>
            <Receipt target={quote.target} setup={setup} />
            <p>
              This links an existing receipt. It does not confirm a provider
              message or record another collection.
            </p>
            <label className="payment-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I checked this source against this recorded receipt
            </label>
            <Button
              disabled={disabled || !confirmed}
              onClick={() =>
                void change(
                  { type: 'link', target: quote.target!, confirmed: true },
                  quote.source,
                )
              }
            >
              Confirm match
            </Button>
          </div>
        ) : null}
      </Modal>
      {copyText !== null ? (
        <Modal
          open
          title="Copy by hand"
          closeLabel="Close manual copy"
          onClose={() => setCopyText(null)}
        >
          <div className="owner-task-field">
            <label htmlFor={copyId}>Select and copy</label>
            <textarea
              id={copyId}
              ref={area}
              readOnly
              value={copyText}
              rows={8}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
function Receipt({
  target,
  setup,
}: {
  target: PaymentMatchTarget;
  setup: SetupSnapshot;
}) {
  return (
    <div className="payment-receipt">
      <h3>{ownerTaskText(target.labelJson, 4000)}</h3>
      <p>
        {formatMoney(target.amount, target.currency)} ·{' '}
        {ownerTaskText(target.methodNameJson, 80)}
      </p>
      <p>
        {khataDate(target.at, setup, true)} · Receipt{' '}
        {target.financialId.slice(-6)}
      </p>
    </div>
  );
}
function CapturePayment({
  setup,
  disabled,
  save,
}: {
  setup: SetupSnapshot;
  disabled: boolean;
  save: (
    draft: Parameters<PaymentSources['session']['prepareCapture']>[0],
  ) => Promise<void>;
}) {
  const [amount, setAmount] = useState(''),
    [method, setMethod] = useState<'cash' | 'card' | 'wallet'>('cash'),
    [wallet, setWallet] = useState(''),
    [reference, setReference] = useState(''),
    [source, setSource] = useState(''),
    [phone, setPhone] = useState(''),
    [received, setReceived] = useState(''),
    [error, setError] = useState('');
  return (
    <Card className="owner-task-card">
      <form
        className="owner-task-detail"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          const minor = parseMoney(amount, setup.outlet.currency);
          const fromPhone = phone.trim()
            ? normalisePhone(phone, setup.business.marketCode)
            : null;
          const receivedAt = received
            ? new Date(received).getTime()
            : Date.now();
          if (
            minor === null ||
            minor <= 0 ||
            !Number.isFinite(receivedAt) ||
            receivedAt < 0 ||
            receivedAt > Date.now() + 300000 ||
            !source.trim() ||
            (method === 'wallet' && !wallet.trim()) ||
            (phone.trim() && !fromPhone)
          ) {
            setError(
              'Enter a positive amount, complete source, method and an optional phone with country code.',
            );
            return;
          }
          void save({
            amount: minor,
            currency: setup.outlet.currency,
            method,
            methodName:
              method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : wallet,
            reference,
            source,
            fromPhone,
            receivedAt,
          });
        }}
      >
        <fieldset disabled={disabled}>
          <label className="owner-task-field">
            Amount observed ({setup.outlet.currency})
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="owner-task-field">
            Payment method
            <select
              value={method}
              onChange={(event) =>
                setMethod(event.target.value as typeof method)
              }
            >
              <option value="cash">Cash</option>
              <option value="wallet">Wallet or bank</option>
              <option value="card">Card</option>
            </select>
          </label>
          {method === 'wallet' ? (
            <label className="owner-task-field">
              Wallet or bank name
              <input
                required
                maxLength={80}
                value={wallet}
                onChange={(event) => setWallet(event.target.value)}
              />
            </label>
          ) : null}
          <label className="owner-task-field">
            Reference (optional)
            <textarea
              rows={2}
              maxLength={4000}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label className="owner-task-field">
            Complete original source
            <textarea
              required
              rows={6}
              maxLength={16000}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <label className="owner-task-field">
            Received time (optional, this device’s local time)
            <input
              type="datetime-local"
              value={received}
              onChange={(event) => setReceived(event.target.value)}
            />
          </label>
          <p>Leave the received time empty to use now.</p>
          <label className="owner-task-field">
            Sender phone (optional)
            <input
              type="tel"
              placeholder="+880…"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
        </fieldset>
        {error ? <p role="alert">{error}</p> : null}
        <p>
          This records an observation for human review, with manual origin. It
          does not prove a provider payment or change money.
        </p>
        <Button type="submit" disabled={disabled || !amount || !source.trim()}>
          Save observed payment
        </Button>
      </form>
    </Card>
  );
}
function isAuth(problem: unknown) {
  return (
    !!problem &&
    typeof problem === 'object' &&
    'kind' in problem &&
    problem.kind === 'auth'
  );
}
