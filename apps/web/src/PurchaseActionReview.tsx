import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import { formatMoney } from '@mise/core/money';
import { financialPurchaseCommand,type PurchaseReviewInvoice } from '@mise/core/purchase-review';
import { parseSyncSession } from '@mise/core/sync-session';
import {
  readCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import type { SetupSnapshot } from '@mise/core/models';
import type { PurchaseReviewChoice } from '@mise/core/purchase-review-journal';
import { db } from './data/db';
import type { PhoneAuth } from './data/phone-auth';
import { cycleAccount } from './data/sync-cycle';
import {
  prepareSavedPurchaseReview,
  decideSavedPurchaseReview,
  readPurchaseReviewWorkspace,
  type PurchaseReviewWorkspace,
  type PurchaseReviewOptions,
} from './data/purchase-review-session';

function InvoiceLines({invoice}:{invoice:PurchaseReviewInvoice}) {
  const [expanded,setExpanded]=useState(false);
  return <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Invoice lines ({invoice.lines.length})</summary>{expanded?<ol className="purchase-review-lines">{invoice.lines.map((line,index)=><li key={index}><strong>{line.name}</strong><span>{line.qty} {line.unit} × <span className="money">{formatMoney(line.unitPrice,invoice.currency)}</span></span><span className="money">{formatMoney(line.lineTotal,invoice.currency)}</span></li>)}</ol>:null}</details>;
}
function InvoiceFacts({invoice}:{invoice:PurchaseReviewInvoice}) {
  return <><dl><div><dt>Total ({invoice.currency})</dt><dd className="money">{formatMoney(invoice.total,invoice.currency)}</dd></div><div><dt>Supplier</dt><dd>{invoice.supplierName}</dd></div><div><dt>Reference</dt><dd>{invoice.reference||'No reference'}</dd></div><div><dt>Payment</dt><dd>{invoice.methodName}</dd></div><div><dt>Invoice date</dt><dd>{new Date(invoice.createdAt).toLocaleString('en-GB',{timeZone:invoice.timezone})}<br/>{invoice.timezone}</dd></div></dl><InvoiceLines invoice={invoice}/></>;
}

export function PurchaseActionReview({
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
    [workspace, setWorkspace] = useState<PurchaseReviewWorkspace | null>(null),
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
      review = selectedId ? await db.purchaseReviews.get(selectedId) : null,
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
      // Restoring the original sign-in after an offline reload is not an
      // account switch. Transport and native writes still verify that account.
      const accountChanged = previous.userId !== null &&
        current.userId !== previous.userId;
      if (current.phase !== 'signed-in' || accountChanged) {
        active.current?.abort();
        setWorkspace(null);
        selected.current = undefined;
      }
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
    void readPurchaseReviewWorkspace(db, selected.current)
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
  async function options(): Promise<PurchaseReviewOptions> {
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
  async function run(kind: string, outcome?: PurchaseReviewChoice) {
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
        const result = await decideSavedPurchaseReview(
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
        const result = await prepareSavedPurchaseReview(
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

  const record=workspace?.record,quote=record?.quote,command=workspace?financialPurchaseCommand(workspace.source.command):null,saved=workspace?.original,proposal=quote?.proposal,completed=record?.phase==='confirmed',acknowledged=workspace?.acknowledged===true,unconfirmed=!!record&&['deciding','unconfirmed'].includes(record.phase),ready=online&&!!config&&auth?.getSnapshot().phase==='signed-in'&&!working,canCheck=online&&!!config&&!!auth&&!working&&!['signed-out','closed','code'].includes(auth.getSnapshot().phase);
  const actual=record?.receipt,actualMessage=actual?.type==='command.resolved'?actual.outcome==='withdrawn'?'The saved invoice action was withdrawn. The current online invoice is unchanged, and your original source is kept.':'The reviewed invoice action was recorded. Your original source and confirmed outcome are kept.':'The original invoice action was already recorded. No replacement was needed.';
  return <section className="order-action-review purchase-action-review" aria-label="Saved invoice review">
    <Button kind="secondary" aria-expanded={open} disabled={!!working} onClick={()=>{if(!open){selected.current=undefined;setWorkspace(null);setError('');setNotice('');}setOpen(value=>!value);}}>{open?'Close invoice review':'Review saved invoice'}</Button>
    {open?<>
      <h3>Review saved invoice</h3>
      <p>Your original invoice, prices and payment method stay on this device. Check current values before choosing what to record.</p>
      {!workspace&&!error?<p role="status">No rejected invoice is ready here. Use the original outlet connection and keep a JSON backup.</p>:null}
      {command&&saved?<>
        <p className="review-action-name">{command.type==='purchase.undo'?'Undo invoice':'Record invoice'}</p>
        <p>Saved {new Date(command.occurredAt).toLocaleString('en-GB')} on this device.</p>
        <div className="order-review-comparison">
          <div><h4>Saved on this device</h4><InvoiceFacts invoice={saved}/>{command.type==='purchase.record'&&command.input.note?<details><summary>Saved invoice note</summary><pre className="order-review-source">{command.input.note}</pre></details>:null}<p>The original currency and invoice identity are kept.</p></div>
          <div><h4>Last checked online</h4>{quote?<><dl><div><dt>Shop currency</dt><dd>{quote.current.profileCurrency}</dd></div><div><dt>Shop time zone</dt><dd>{quote.current.profileTimezone}</dd></div>{quote.current.supplier?<div><dt>Current supplier</dt><dd>{quote.current.supplier.name}{quote.current.supplier.archived?' · Archived':''}</dd></div>:null}</dl>{quote.current.invoice?<><p>{quote.current.invoice.voided?'Invoice already undone':'Invoice recorded online'}</p><InvoiceFacts invoice={quote.current.invoice}/></>:<p>No invoice recorded online.</p>}<p>Checked {new Date(quote.at).toLocaleString('en-GB')}. Values are checked again before applying.</p></>:<p>Check the current shop values to compare them with this saved action.</p>}</div>
        </div>
        {quote&&!completed?<div className="order-review-proposal"><h4>Reviewed result</h4>{proposal?.enabled?<><InvoiceFacts invoice={proposal.invoice}/><p>{command.type==='purchase.undo'?'This would undo the original invoice within its original ten-minute window. It records no stock return or cash refund.':'This would record the saved prices and quantities. Recording an invoice does not mark stock as received.'}</p></>:<p>{proposal&&proposal.reason==='currency'?'The shop currency changed. The saved prices cannot be recorded in a different currency. You can withdraw this action and enter a separate invoice in the current currency.':'This invoice cannot be applied with the current supplier, stock or undo window. You can keep the source or withdraw this action.'}</p>}</div>:null}
        {unconfirmed?<p role="status">Your choice to {record?.choice?.outcome==='withdrawn'?'withdraw this invoice action':'apply this reviewed invoice action'} is saved, but its server outcome is unconfirmed. Check the saved outcome before making another correction.</p>:null}
        {completed?<p className="review-outcome" role="status">{actualMessage}</p>:null}
        <div className="order-review-actions">
          <Button kind="secondary" disabled={!canCheck} onClick={()=>void run('check')}>{working==='check'?'Checking…':unconfirmed||acknowledged?'Check saved outcome':completed?'Recheck confirmed outcome':'Check current invoice values'}</Button>
          {!completed&&!acknowledged&&record?.phase==='review'?<><Button kind="secondary" disabled={!ready} onClick={()=>void run('withdraw',{outcome:'withdrawn'})}>Withdraw saved invoice action</Button><Button disabled={!ready||!proposal?.enabled} onClick={()=>void run('replace',{outcome:'replaced'})}>Apply reviewed invoice action</Button></>:null}
        </div>
        {record?.attempts.length?<details><summary>Saved invoice decisions ({record.attempts.length})</summary><ol>{record.attempts.map((attempt,index)=><li key={index}>{attempt.outcome==='withdrawn'?'Withdraw action':'Apply reviewed replacement'} · {new Date(attempt.at).toLocaleString('en-GB')}</li>)}</ol></details>:null}
      </>:null}
      {working?<><p role="status" aria-live="polite">{working==='check'?'Checking the actual outcome and current invoice values…':'Confirming your saved invoice decision…'}</p><Button kind="secondary" onClick={()=>active.current?.abort()}>Stop invoice check</Button></>:null}
      {error?<p className="form-error" role="alert">{error}</p>:null}{notice?<p role="status" aria-live="polite">{notice}</p>:null}{!online?<p>Offline. Your source and any saved choice stay on this device. Reconnect to check the actual outcome.</p>:null}
      <Link to="/settings/exports">Download a JSON backup</Link>
    </>:null}
  </section>;
}
