import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import { formatMoney } from '@mise/core/money';
import { orderStatusLabels } from '@mise/core/orders';
import { parseSyncSession } from '@mise/core/sync-session';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import type { SetupSnapshot, Order } from '@mise/core/models';
import type { OrderReviewOutcome } from '@mise/core/order-review-journal';
import { db } from './data/db';
import type { PhoneAuth } from './data/phone-auth';
import { cycleAccount } from './data/sync-cycle';
import { OrderFinancialProposal } from './OrderFinancialProposal';
import {
  prepareSavedOrderReview,
  decideSavedOrderReview,
  readOrderReviewWorkspace,
  type OrderReviewWorkspace,
  type OrderReviewOptions,
} from './data/order-review-session';

const names: Record<string, string> = {
  'order.create': 'Save order',
  'order.update': 'Update order',
  'order.payment': 'Record payment',
  'order.payment-undo': 'Undo payment',
  'order.refund': 'Record refund',
  'order.refund-undo': 'Undo refund',
  'order.status': 'Change order status',
  'order.status-undo': 'Undo status change',
  'order.note': 'Add order note',
  'order.communication': 'Record sent message',
};
export function OrderActionReview({
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
  const [open, setOpen] = useState(false),
    [workspace, setWorkspace] = useState<OrderReviewWorkspace | null>(null),
    [working, setWorking] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0);
  const active = useRef<AbortController | null>(null),
    mounted = useRef(true),
    selected = useRef<string | undefined>(undefined);
  // Subscribe to control metadata only. Complete source/Blob verification runs
  // outside the live query, and only when the operator opens this review.
  const selectedId = workspace?.source.review.id;
  const change = useLiveQuery(async () => {
    const observations = await db.syncActionReviews.toArray(),
      review = selectedId ? await db.orderReviews.get(selectedId) : null,
      operator = await db.operatorState.get('active');
    return JSON.stringify([
      observations.map((v) => [v.id, v.observations, v.receiptHash]),
      review?.revision,
      operator,
    ]);
  }, [selectedId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    active.current?.abort();
    setWorkspace(null);
    selected.current = undefined;
    setOpen(false);
    setError('');
    setNotice('');
  }, [
    setup.business.id,
    setup.outlet.id,
    setup.owner.id,
    config?.apiUrl,
    config?.publishableKey,
    auth?.key,
  ]);
  useEffect(() => {
    if (!online) active.current?.abort();
  }, [online]);
  useEffect(() => {
    if (!auth) return;
    const stop = auth.subscribe(() => {
      if (auth.getSnapshot().phase !== 'signed-in') active.current?.abort();
      setVersion((v) => v + 1);
    });
    return () => {
      stop();
    };
  }, [auth]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void readOrderReviewWorkspace(db, selected.current)
      .then((value) => {
        if (current) {
          setWorkspace(value);
          if (value) selected.current = value.source.review.id;
        }
      })
      .catch(() => {
        if (current)
          setError(
            'Use the original outlet and keep the complete saved action. A JSON backup is available below.',
          );
      });
    return () => {
      current = false;
    };
  }, [open, change, version]);
  async function options(): Promise<OrderReviewOptions> {
    if (!config || !auth) throw Error('Verify the original connection.');
    const state = parseSyncSession(await db.syncSessions.get('active')),
      original = config;
    if (
      state.target.businessId !== setup.business.id ||
      state.target.outletId !== setup.outlet.id ||
      state.target.actorId !== setup.owner.id
    )
      throw Error('Use the original selected outlet.');
    return {
      config: original,
      account: cycleAccount(
        {
          config: original,
          scope: import.meta.env.BASE_URL + setup.business.id,
          auth,
          connectionCurrent: () => {
            try {
              const current = readCloudConnection(localStorage);
              return (
                current?.apiUrl === original.apiUrl &&
                current.publishableKey === original.publishableKey
              );
            } catch {
              return false;
            }
          },
        },
        state,
      ),
    };
  }
  async function run(kind: string, outcome?: OrderReviewOutcome) {
    if (active.current || !workspace) return;
    const controller = new AbortController();
    active.current = controller;
    setWorking(kind);
    setError('');
    setNotice('');
    const id = workspace.source.review.id,
      revision = workspace.record?.revision ?? null;
    try {
      const access = await options();
      if (outcome && revision !== null) {
        const result = await decideSavedOrderReview(
          db,
          id,
          revision,
          outcome,
          access,
          controller.signal,
        );
        if (mounted.current)
          setNotice(
            result.changed
              ? 'The shop values changed. Review the updated comparison before choosing again.'
              : 'The server outcome is saved. Your local view updates when sync completes.',
          );
      } else {
        const result = await prepareSavedOrderReview(
          db,
          id,
          revision,
          access,
          controller.signal,
        );
        if (mounted.current)
          setNotice(
            result.phase === 'confirmed'
              ? 'The server already recorded this action. Its actual outcome is saved.'
              : 'Current shop values are ready to review.',
          );
      }
    } catch {
      if (mounted.current)
        setError(
          'This check or decision is unconfirmed on this device. Your original action and chosen values are kept. Verify the original phone account and check the saved outcome again.',
        );
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) {
        setWorking('');
        setVersion((v) => v + 1);
      }
    }
  }
  const source = workspace?.source,
    record = workspace?.record,
    quote = record?.quote,
    command = source?.command;
  const savedOrder = source?.entry.changes
    .filter(
      (v) =>
        v.table === 'orders' &&
        v.key === ('orderId' in source.command ? source.command.orderId : ''),
    )
    .at(-1)?.after as Order | undefined;
  const currency = quote?.proposal.enabled
    ? quote.proposal.currency
    : (quote?.current.order?.currency ??
      savedOrder?.currency ??
      setup.outlet.currency);
  const currencyChanged =
    !!quote?.proposal.enabled &&
    !!savedOrder &&
    savedOrder.currency !== quote.proposal.currency;
  const money = (value: number | null | undefined) =>
    value === null || value === undefined
      ? 'Not priced'
      : formatMoney(value, currency);
  const ready =
      online &&
      !!config &&
      auth?.getSnapshot().phase === 'signed-in' &&
      !working,
    canCheck =
      online &&
      !!config &&
      !!auth &&
      !working &&
      !['signed-out', 'closed', 'code'].includes(auth.getSnapshot().phase),
    unconfirmed = record && ['deciding', 'unconfirmed'].includes(record.phase);
  const actual = record?.receipt,
    completed = record?.phase === 'confirmed';
  const createManually =
    completed &&
    actual?.type === 'command.resolved' &&
    actual.outcome === 'withdrawn' &&
    quote?.current.order === null;
  return (
    <section className="order-action-review" aria-label="Saved order review">
      <Button
        kind="secondary"
        aria-expanded={open}
        disabled={!!working}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close review' : 'Review saved order action'}
      </Button>
      {open ? (
        <>
          <header>
            <h3 id="saved-order-review-title">Review saved order action</h3>
          </header>
          <p>
            Your original action and complete source stay on this device. Every
            decision checks the server’s actual outcome first.
          </p>
          {!workspace && !error ? (
            <p role="status">
              No rejected order action is ready here. Other saved work stays
              queued; use the original outlet connection and keep a JSON backup.
            </p>
          ) : null}
          {workspace && command ? (
            <>
              <p className="review-action-name">
                {names[command.type] ?? 'Saved order action'}
                {savedOrder?.number ? ' · ' + savedOrder.number : ''}
              </p>
              <p>
                Saved{' '}
                {new Date(
                  'occurredAt' in command
                    ? command.occurredAt
                    : source!.entry.at,
                ).toLocaleString('en-GB')}{' '}
                on this device.
              </p>
              <div className="order-review-comparison">
                <div>
                  <h4>Saved on this device</h4>
                  <dl>
                    <div>
                      <dt>
                        Order total
                        {savedOrder ? ' (' + savedOrder.currency + ')' : ''}
                      </dt>
                      <dd className="money">
                        {savedOrder?.total === null ||
                        savedOrder?.total === undefined
                          ? 'Not priced'
                          : formatMoney(savedOrder.total, savedOrder.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt>Payment</dt>
                      <dd>{savedOrder?.payment.status ?? 'Pending'}</dd>
                    </div>
                    <div>
                      <dt>Method</dt>
                      <dd>
                        {savedOrder?.payment.wallet ??
                          savedOrder?.payment.method ??
                          'Unspecified'}
                      </dd>
                    </div>
                    <div>
                      <dt>Customer</dt>
                      <dd>
                        {savedOrder?.customer.name || 'Not named'}
                        {savedOrder?.customer.phone ? (
                          <>
                            <br />
                            {savedOrder.customer.phone}
                          </>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Order status</dt>
                      <dd>
                        {savedOrder
                          ? orderStatusLabels[savedOrder.status]
                          : 'Unconfirmed'}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h4>Last checked online</h4>
                  {quote ? (
                    <>
                      <dl>
                        <div>
                          <dt>
                            Order total
                            {quote.current.order
                              ? ' (' + quote.current.order.currency + ')'
                              : ''}
                          </dt>
                          <dd className="money">
                            {quote.current.order
                              ? money(quote.current.order.total)
                              : 'No order yet'}
                          </dd>
                        </div>
                        <div>
                          <dt>Payment</dt>
                          <dd>
                            {quote.current.order?.payment.status ??
                              'No order yet'}
                          </dd>
                        </div>
                        <div>
                          <dt>Method</dt>
                          <dd>
                            {quote.current.order?.payment.wallet ??
                              quote.current.order?.payment.method ??
                              'No order yet'}
                          </dd>
                        </div>
                        <div>
                          <dt>Customer</dt>
                          <dd>
                            {quote.current.order?.customer.name || 'Not named'}
                            {quote.current.order?.customer.phone ? (
                              <>
                                <br />
                                {quote.current.order.customer.phone}
                              </>
                            ) : null}
                          </dd>
                        </div>
                        <div>
                          <dt>Order status</dt>
                          <dd>
                            {quote.current.order
                              ? orderStatusLabels[quote.current.order.status]
                              : 'No order yet'}
                          </dd>
                        </div>
                        {quote.current.balance !== null ? (
                          <>
                            <div>
                              <dt>
                                Khata for{' '}
                                {quote.current.creditCustomer?.name ||
                                  'selected customer'}{' '}
                                ({quote.current.creditCurrency})
                              </dt>
                              <dd className="money">
                                {formatMoney(
                                  quote.current.balance,
                                  quote.current.creditCurrency!,
                                )}
                              </dd>
                            </div>
                            {quote.current.creditCustomer?.phone ? (
                              <div>
                                <dt>Khata contact</dt>
                                <dd>{quote.current.creditCustomer.phone}</dd>
                              </div>
                            ) : null}
                            <div>
                              <dt>Credit limit</dt>
                              <dd className="money">
                                {formatMoney(
                                  quote.current.limit!,
                                  quote.current.creditCurrency!,
                                )}
                              </dd>
                            </div>
                          </>
                        ) : null}
                      </dl>
                      <p>
                        Checked {new Date(quote.at).toLocaleString('en-GB')}.
                        Values are checked again before applying.
                      </p>
                    </>
                  ) : (
                    <p>
                      Check the current shop values to compare them with this
                      saved action.
                    </p>
                  )}
                </div>
              </div>
              {savedOrder ? (
                <details>
                  <summary>Saved order lines</summary>
                  <ul className="order-review-lines">
                    {savedOrder.lines.map((line) => (
                      <li key={line.id}>
                        <span>
                          {line.qty} {line.unit} · {line.name}
                        </span>
                        <span className="money">
                          {line.lineTotal === null
                            ? 'Not priced'
                            : formatMoney(line.lineTotal, savedOrder.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {command.type === 'order.note' ||
              command.type === 'order.communication' ? (
                <details>
                  <summary>Saved message</summary>
                  <pre className="order-review-source">
                    {command.type === 'order.note'
                      ? command.text
                      : command.input.text}
                  </pre>
                </details>
              ) : null}
              {quote?.current.order ? (
                <details>
                  <summary>Current order lines</summary>
                  <ul className="order-review-lines">
                    {quote.current.order.lines.map((line) => (
                      <li key={line.id}>
                        <span>
                          {line.qty} {line.unit} · {line.name}
                        </span>
                        <span className="money">{money(line.lineTotal)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {completed ? (
                <p className="review-outcome" role="status">
                  {actual?.type === 'command.resolved'
                    ? actual.outcome === 'withdrawn'
                      ? 'The saved action was withdrawn. Current shop money was left unchanged.'
                      : 'The reviewed action was recorded using the checked shop values.'
                    : 'The original action was already recorded by the server.'}{' '}
                  Original details stay in history.
                </p>
              ) : (
                <>
                  {unconfirmed ? (
                    <p role="status">
                      Your choice to{' '}
                      {record.choice === 'withdrawn'
                        ? 'withdraw this action'
                        : 'apply the reviewed action'}{' '}
                      is saved here. Its server outcome is unconfirmed. Check
                      what happened, or deliberately retry that same decision.
                    </p>
                  ) : null}
                  {quote?.proposal.enabled ? (
                    <p>
                      The reviewed order total is{' '}
                      <span className="money">
                        {money(quote.proposal.total)}
                      </span>
                      . Applying this action leaves the order{' '}
                      {orderStatusLabels[quote.proposal.status].toLowerCase()}.
                      The original saved time and related records are kept.
                    </p>
                  ) : quote ? (
                    <p>
                      This action cannot be applied to the checked shop values.
                      You can withdraw it, then open the order to record the
                      correct action manually.
                    </p>
                  ) : null}
                  {currencyChanged ? (
                    <p role="status">
                      The saved currency is {savedOrder!.currency}; the checked
                      currency is {currency}. Withdraw this saved action and
                      record the correct amount manually in {currency}.
                    </p>
                  ) : null}
                  {quote?.proposal.enabled && !currencyChanged ? (
                    <OrderFinancialProposal quote={quote} />
                  ) : null}
                  {command.type === 'order.refund' ? (
                    <p>
                      Refund amount:{' '}
                      <span className="money">
                        {money(command.input.amount)}
                      </span>
                      .
                    </p>
                  ) : null}
                  {quote &&
                  !currencyChanged &&
                  command.type === 'order.payment' &&
                  command.input.method === 'cash' ? (
                    <p>
                      {command.input.given !== undefined ? (
                        <>
                          Cash given:{' '}
                          <span className="money">
                            {money(command.input.given)}
                          </span>
                          .{' '}
                          {quote.proposal.enabled &&
                          quote.proposal.total !== null ? (
                            <>
                              Change using checked values:{' '}
                              <span className="money">
                                {money(
                                  command.input.given - quote.proposal.total,
                                )}
                              </span>
                              .
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          Cash to record:{' '}
                          <span className="money">
                            {money(
                              quote.proposal.enabled
                                ? quote.proposal.total
                                : null,
                            )}
                          </span>
                          .
                        </>
                      )}{' '}
                      Check the actual cash before applying.
                    </p>
                  ) : null}
                  <div className="order-review-actions">
                    <Button
                      kind="secondary"
                      disabled={!canCheck}
                      onClick={() => void run('check')}
                    >
                      {unconfirmed
                        ? 'Check saved outcome'
                        : quote
                          ? 'Check current values again'
                          : 'Check current values'}
                    </Button>
                    {unconfirmed ? (
                      <Button
                        disabled={
                          !ready ||
                          (record.choice === 'replaced' && currencyChanged)
                        }
                        onClick={() => void run('retry', record.choice!)}
                      >
                        Retry saved decision
                      </Button>
                    ) : quote && record?.phase === 'review' ? (
                      <>
                        <Button
                          disabled={
                            !ready || !quote.proposal.enabled || currencyChanged
                          }
                          onClick={() => void run('apply', 'replaced')}
                        >
                          Apply reviewed action
                        </Button>
                        <Button
                          kind="secondary"
                          disabled={!ready}
                          onClick={() => void run('withdraw', 'withdrawn')}
                        >
                          Withdraw saved action
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <p>
                    Withdrawal leaves the shop’s current money unchanged and
                    keeps the original action in history.
                  </p>
                </>
              )}
              {record?.attempts.length ? (
                <details>
                  <summary>Saved review choices</summary>
                  <ol>
                    {record.attempts.map((attempt, index) => (
                      <li key={index}>
                        {attempt.outcome === 'withdrawn'
                          ? 'Withdraw saved action'
                          : 'Apply reviewed action'}{' '}
                        · {new Date(attempt.at).toLocaleString('en-GB')}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              <Link
                to={
                  createManually
                    ? '/orders/new'
                    : '/orders/' + ('orderId' in command ? command.orderId : '')
                }
              >
                {createManually
                  ? 'Create correct order manually'
                  : 'Open order for manual changes'}
              </Link>
            </>
          ) : null}
          {working ? (
            <>
              <p aria-live="polite" role="status">
                {working === 'check'
                  ? 'Checking the actual server outcome and current values…'
                  : 'Confirming your saved decision…'}
              </p>
              <Button kind="secondary" onClick={() => active.current?.abort()}>
                Stop check
              </Button>
            </>
          ) : null}
          {notice ? (
            <p role="status" aria-live="polite">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {!online ? (
            <p>
              Offline. Your saved source, last checked values and choice stay
              here. Reconnect before checking or sending a decision.
            </p>
          ) : null}
          <Link to="/settings/exports">Download a JSON backup</Link>
        </>
      ) : null}
    </section>
  );
}
