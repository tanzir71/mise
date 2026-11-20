import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import { formatMoney } from '@mise/core/money';
import { financialMoneyCommand } from '@mise/core/money-review';
import { parseSyncSession } from '@mise/core/sync-session';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import type { SetupSnapshot } from '@mise/core/models';
import type { MoneyReviewChoice } from '@mise/core/money-review-journal';
import { db } from './data/db';
import type { PhoneAuth } from './data/phone-auth';
import { cycleAccount } from './data/sync-cycle';
import {
  prepareSavedMoneyReview,
  decideSavedMoneyReview,
  readMoneyReviewWorkspace,
  type MoneyReviewWorkspace,
  type MoneyReviewOptions,
} from './data/money-review-session';

const names: Record<string, string> = {
 'sale.record':'Record sale', 'sale.credit':'Record credit sale', 'sale.undo':'Undo sale',
 'khata.payment':'Record khata payment', 'khata.undo':'Undo khata entry',
};
export function MoneyActionReview({
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
    [workspace, setWorkspace] = useState<MoneyReviewWorkspace | null>(null),
    [working, setWorking] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    [confirmCredit, setConfirmCredit] = useState(false);
  const active = useRef<AbortController | null>(null),
    mounted = useRef(true),
    selected = useRef<string | undefined>(undefined);
  // Subscribe to control metadata only. Complete source/Blob verification runs
  // outside the live query, and only when the operator opens this review.
  const selectedId = workspace?.source.review.id;
  const change = useLiveQuery(async () => {
    const observations = await db.syncActionReviews.toArray(),
      review = selectedId ? await db.moneyReviews.get(selectedId) : null,
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
    let previous = auth.getSnapshot();
    const stop = auth.subscribe(() => {
      const current = auth.getSnapshot();
      if (current.phase !== 'signed-in') active.current?.abort();
      if (current.phase !== previous.phase || current.userId !== previous.userId)
        setConfirmCredit(false);
      previous = current;
      setVersion((v) => v + 1);
    });
    return () => {
      stop();
    };
  }, [auth]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void readMoneyReviewWorkspace(db, selected.current)
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
  useEffect(() => { setConfirmCredit(false); }, [selectedId, workspace?.record?.quoteHash, setup.owner.id, auth?.key]);
  async function options(): Promise<MoneyReviewOptions> {
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
  async function run(kind: string, outcome?: MoneyReviewChoice) {
    if (active.current || !workspace) return;
    const controller = new AbortController();
    active.current = controller;
    setWorking(kind);
    setError('');
    setNotice('');
    if (kind === 'check') setConfirmCredit(false);
    const id = workspace.source.review.id,
      revision = workspace.record?.revision ?? null;
    try {
      const access = await options();
      if (outcome && revision !== null) {
        const result = await decideSavedMoneyReview(
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
        const result = await prepareSavedMoneyReview(
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
  const record = workspace?.record,
    quote = record?.quote,
    command = workspace ? financialMoneyCommand(workspace.source.command) : null,
    saved = workspace?.original,
    proposal = quote?.proposal,
    completed = record?.phase === 'confirmed',
    acknowledged = workspace?.acknowledged === true,
    unconfirmed = !!record && ['deciding', 'unconfirmed'].includes(record.phase),
    ready = online && !!config && auth?.getSnapshot().phase === 'signed-in' && !working,
    canCheck = online && !!config && !!auth && !working &&
      !['signed-out', 'closed', 'code'].includes(auth.getSnapshot().phase),
    requiresCredit = proposal?.enabled === true && proposal.requiresCreditConfirmation;
  const actual = record?.receipt;
  const actualMessage = actual?.type === 'command.resolved'
    ? actual.outcome === 'withdrawn'
      ? 'The saved action was withdrawn. It adds no sale or payment. Your original record is kept.'
      : 'The reviewed replacement was recorded. Your original action is kept with its confirmed outcome.'
    : 'The original action was already recorded. No replacement was needed.';
  return (
    <section className="order-action-review money-action-review" aria-label="Saved money review">
      <Button kind="secondary" aria-expanded={open} disabled={!!working} onClick={() => setOpen(v => !v)}>
        {open ? 'Close money review' : 'Review saved money action'}
      </Button>
      {open ? <>
        <h3>Review saved money action</h3>
        <p>Your original amount, currency and source stay on this device. Check current values before choosing what to record.</p>
        {!workspace && !error ? <p role="status">No rejected money action is ready here. Use the original outlet connection and keep a JSON backup.</p> : null}
        {command && saved ? <>
          <p className="review-action-name">{names[command.type]}</p>
          <p>Saved {new Date(command.occurredAt).toLocaleString('en-GB')} on this device.</p>
          <div className="order-review-comparison">
            <div>
              <h4>Saved on this device</h4>
              <dl>
                <div><dt>Amount ({saved.currency})</dt><dd className="money">{formatMoney(saved.amount, saved.currency)}</dd></div>
                <div><dt>Method</dt><dd>{saved.methodName || (saved.accountId ? 'Khata' : 'Unspecified')}</dd></div>
                {'input' in command && 'expression' in command.input ? <div><dt>Calculation</dt><dd>{command.input.expression}</dd></div> : null}
              </dl>
              {'input' in command && 'note' in command.input && command.input.note ? <details><summary>Saved payment note</summary><pre className="order-review-source">{command.input.note}</pre></details> : null}
              <p>The original currency is kept for every decision.</p>
            </div>
            <div>
              <h4>Last checked online</h4>
              {quote ? <>
                <dl>
                  <div><dt>Shop currency</dt><dd>{quote.current.profileCurrency}</dd></div>
                  {'saleId' in command ? <div><dt>Sale recorded online</dt><dd>{quote.current.sale ? <><span className="money">{formatMoney(quote.current.sale.amount, quote.current.sale.currency)}</span><br />{quote.current.sale.voided ? 'Voided' : quote.current.sale.closed ? 'Day closed' : quote.current.sale.methodName}</> : 'No sale yet'}</dd></div> : null}
                  {quote.current.entry ? <div><dt>Original khata entry ({quote.current.entry.type})</dt><dd className="money">{formatMoney(quote.current.entry.amount, quote.current.entry.currency)}</dd></div> : null}
                  {quote.current.creditCustomer ? <div><dt>Khata customer</dt><dd>{quote.current.creditCustomer.name}{quote.current.creditCustomer.phone ? <><br />{quote.current.creditCustomer.phone}</> : null}</dd></div> : null}
                  {quote.current.balance !== null ? <>
                    <div><dt>Current balance ({quote.current.creditCurrency})</dt><dd className="money">{formatMoney(quote.current.balance, quote.current.creditCurrency!)}</dd></div>
                    <div><dt>Credit limit</dt><dd className="money">{formatMoney(quote.current.limit!, quote.current.creditCurrency!)}</dd></div>
                  </> : null}
                </dl>
                <p>Checked {new Date(quote.at).toLocaleString('en-GB')}. Values are checked again before applying.</p>
              </> : <p>Check the current shop values to compare them with this saved action.</p>}
            </div>
          </div>
          {completed ? <p className="review-outcome" role="status">{actualMessage} The local totals update when sync completes.</p> : <>
            {proposal ? <div className="review-outcome">
              <h4>Reviewed replacement</h4>
              {proposal.enabled ? <>
                <dl className="order-review-after">
                  <div><dt>{command.type === 'khata.payment' ? 'Payment to record' : command.type.endsWith('undo') ? 'Reversal to record' : 'Sale to record'} ({proposal.currency})</dt><dd className="money">{formatMoney(proposal.amount, proposal.currency)}</dd></div>
                  {proposal.balance !== null ? <div><dt>Khata balance after this action</dt><dd className="money">{formatMoney(proposal.balance, proposal.currency)}</dd></div> : null}
                </dl>
                {command.type === 'sale.record' && command.input.method === 'cash' ? <p>Check the actual cash before applying.{command.input.given !== null ? <> Cash given: <span className="money">{formatMoney(command.input.given, saved.currency)}</span>. Change using checked values: <span className="money">{formatMoney(command.input.given - proposal.amount, saved.currency)}</span>.</> : null}</p> : null}
                {requiresCredit ? <>
                  <p>This credit sale would exceed the current limit. Confirm this exact balance and limit before applying.</p>
                  <label className="money-review-consent"><input type="checkbox" checked={unconfirmed ? !!record?.choice?.confirmCredit : confirmCredit} disabled={!ready || record?.phase !== 'review'} onChange={event => setConfirmCredit(event.target.checked)} /><span>Allow this credit sale above the checked limit</span></label>
                </> : null}
              </> : <p>{proposal.reason === 'currency' ? 'The saved currency differs from the current shop or khata. Withdraw this action and record the correct amount manually.' : 'This action cannot be applied to the current records. The original undo deadline and financial records are kept. You can withdraw it or make a manual correction.'}</p>}
            </div> : null}
            {unconfirmed ? <p role="status">Your choice to {record?.choice?.outcome === 'withdrawn' ? 'withdraw this money action' : 'apply this reviewed replacement'}{record?.choice?.confirmCredit ? ' with the checked credit override' : ''} is saved, but its server outcome is unconfirmed. Check the saved outcome before making another correction.</p> : null}
            <div className="order-review-actions">
              <Button kind="secondary" disabled={!canCheck} onClick={() => void run('check')}>{unconfirmed || acknowledged ? 'Check saved money outcome' : quote ? 'Check money values again' : 'Check money values'}</Button>
              {unconfirmed && !acknowledged ? <Button disabled={!ready} onClick={() => void run('retry', record!.choice!)}>Retry saved money decision</Button> : !acknowledged && quote && record?.phase === 'review' ? <>
                <Button kind="secondary" disabled={!ready} onClick={() => void run('withdraw', {outcome:'withdrawn',confirmCredit:false})}>Withdraw saved money action</Button>
                <Button disabled={!ready || !proposal?.enabled || (requiresCredit && !confirmCredit)} onClick={() => void run('replace', {outcome:'replaced',confirmCredit:requiresCredit && confirmCredit})}>Apply reviewed money action</Button>
              </> : null}
            </div>
          </>}
          {record?.attempts.length ? <details><summary>Saved money decisions ({record.attempts.length})</summary><ol>{record.attempts.map((attempt,index) => <li key={index}>{attempt.outcome === 'withdrawn' ? 'Withdraw action' : 'Apply reviewed replacement'}{attempt.confirmCredit ? ' · Credit override confirmed' : ''} · {new Date(attempt.at).toLocaleString('en-GB')}</li>)}</ol></details> : null}
          <Link to={saved.accountId && saved.customerId ? '/khata/' + saved.customerId + '?currency=' + saved.currency : '/counter'}>{saved.accountId ? 'Open khata for manual changes' : 'Open counter for manual changes'}</Link>
        </> : null}
        {working ? <><p role="status" aria-live="polite">{working === 'check' ? 'Checking the actual outcome and current money values…' : 'Confirming your saved money decision…'}</p><Button kind="secondary" onClick={() => active.current?.abort()}>Stop money check</Button></> : null}
        {notice ? <p role="status" aria-live="polite">{notice}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {!online ? <p>Offline. Your saved source, last checked values and choice stay here. Reconnect before checking or sending a decision.</p> : null}
        <Link to="/settings/exports">Download a JSON backup</Link>
      </> : null}
    </section>
  );
}
