import {useEffect,useMemo,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router-dom';
import {Button} from '@mise/ui/primitives.tsx';
import {formatMoney} from '@mise/core/money';
import {parseClosingCommand} from '@mise/core/closing-commands';
import {parseSyncSession} from '@mise/core/sync-session';
import {readCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import type {SetupSnapshot} from '@mise/core/models';
import type {ClosingReviewChoice} from '@mise/core/closing-review-journal';
import {db} from './data/db';
import type {PhoneAuth} from './data/phone-auth';
import {cycleAccount} from './data/sync-cycle';
import {prepareSavedClosingReview,decideSavedClosingReview,readClosingReviewWorkspace,type ClosingReviewWorkspace,type ClosingReviewOptions} from './data/closing-review-session';
import {ClosingFacts,ClosingTotals,CopyClosingReview,closingActionName} from './ClosingReviewFacts';
import {readClosingReviewContext} from '@mise/core/closing-review-view';
import {closingPreview} from '@mise/core/today';
export function ClosingActionReview({
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
    [workspace, setWorkspace] = useState<ClosingReviewWorkspace | null>(null),
    [sourceLoading,setSourceLoading]=useState(false),
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
      review = selectedId ? await db.closingReviews.get(selectedId) : null,
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
    setSourceLoading(true);
    void readClosingReviewWorkspace(db, selected.current)
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
      }).finally(()=>{if(current)setSourceLoading(false);});
    return () => {
      current = false;
    };
  }, [open, change, version]);
  async function options(): Promise<ClosingReviewOptions> {
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
  async function run(kind: string, outcome?: ClosingReviewChoice) {
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
        const result = await decideSavedClosingReview(
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
        const result = await prepareSavedClosingReview(
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

  const record=workspace?.record,quote=record?.quote,saved=workspace?.original;
  const command=useMemo(()=>workspace?parseClosingCommand(workspace.source.command):null,[workspace?.source.command]);
  const current=useMemo(()=>quote&&command?readClosingReviewContext(quote.current.contextJson,quote.businessId,quote.outletId,quote.actorId,command.closingId):null,[quote,command]);
  const summary=useMemo(()=>current&&command?.type==='closing.record'?closingPreview(current.today,command.occurredAt).summary:null,[current,command]);
  const original=saved?.events[0],proposal=quote?.proposal;
  const completed=record?.phase==='confirmed',acknowledged=workspace?.acknowledged===true,unconfirmed=!!record&&['deciding','unconfirmed'].includes(record.phase),ready=online&&!!config&&auth?.getSnapshot().phase==='signed-in'&&!working,canCheck=online&&!!config&&!!auth&&!working&&!['signed-out','closed','code'].includes(auth.getSnapshot().phase),timezone=original?.after.timezone??setup.outlet.timezone;
  const actual=record?.receipt,actualMessage=actual?.type==='command.resolved'?actual.outcome==='withdrawn'?'The saved closing action was withdrawn. Online records are unchanged, and your original count is kept.':'The reviewed closing action was recorded. Your original count and confirmed outcome are kept.':'The original closing action was already recorded. No replacement was needed.';
  const unavailable=proposal&&!proposal.enabled?({unit:'The current outlet uses a different currency. This physical count keeps its original currency. Keep the source, or withdraw it and record a separate count.',day:'The current outlet uses a different timezone. Keep the counted day and timezone, or withdraw this action and record a separate count.',parent:'The original closing or cash receipt has changed. Keep this source, or withdraw this action and review the current closing separately.',closed:'A closing is already recorded, or the original closing has already been undone. Check the current record before making a separate correction.',deadline:'The original closing can only be undone on its recorded day, in its original timezone. Keep this source or withdraw the saved undo.',choice:'The original surplus choice cannot be applied to these totals. Keep the count, or withdraw this action and make a separate correction.',unavailable:'This closing action cannot be applied to the current records. Keep the original count, or withdraw it and review a separate correction.'}[proposal.reason]):'';
  return <section className="order-action-review closing-action-review" aria-label="Saved closing review">
    <Button kind="secondary" aria-expanded={open} disabled={!!working} onClick={()=>{if(!open){selected.current=undefined;setWorkspace(null);setError('');setNotice('');}setOpen(value=>!value);}}>{open?'Close review':'Review saved closing'}</Button>
    {open?<>
      <h3>Review saved closing</h3>
      <p>Your physical cash count, original day and note stay on this device. Compare the current records before choosing what to record.</p>
      {!workspace&&!error?<p role="status">{sourceLoading?'Reading the saved closing source…':'No rejected closing action is ready here. Use the original outlet and keep a JSON backup.'}</p>:null}
      {command&&saved&&original?<>
        <p className="review-action-name">{closingActionName(command)}</p>
        <p>Saved on this device {new Date(saved.at).toLocaleString('en-GB',{timeZone:timezone})} · {timezone}</p>
        <div className="order-review-comparison">
          <div><h4>Saved on this device</h4><ClosingFacts closing={original.after}/>
            <p>{command.type==='closing.undo'?'Undoes this original closing and its linked surplus receipt.':'Keeps the physical count, its original time, note and chosen treatment of extra cash.'}</p>
          </div>
          <div><h4>Last checked online</h4>{quote&&current?<>
            {current.closing?<ClosingFacts closing={current.closing}/>:<p>No closing is recorded online with this identity.</p>}
            {summary?<ClosingTotals summary={summary}/>:null}
            {current.sale?<p>Linked cash receipt: <span className="money">{formatMoney(current.sale.amount,current.sale.currency)}</span> · {current.sale.voidedAt===undefined?'Recorded':'Undone'}</p>:null}
            <p>Checked {new Date(quote.at).toLocaleString('en-GB',{timeZone:timezone})}. Values and the undo deadline are checked again before applying.</p>
          </>:<p>Check online to compare the original count and linked cash receipt with current records.</p>}</div>
        </div>
        {quote&&!completed?<div className="order-review-proposal"><h4>Reviewed result</h4>{proposal?.enabled?<>
          <ClosingFacts closing={proposal.closing}/>
          <p>{command.type==='closing.undo'?'Undoes only the checked original closing and its linked cash surplus.':'The physical cash count stays the same. Only the checked difference and its original surplus choice are applied.'}</p>
        </>:<p>{unavailable}</p>}</div>:null}
        <p>Recorded cash is net cash movement. Opening float and unrecorded expenses are not included.</p>
        {unconfirmed?<p role="status">Your choice to {record?.choice?.outcome==='withdrawn'?'withdraw this closing action':'apply this reviewed closing action'} is saved, but its server outcome is unconfirmed. Check the saved outcome before making another correction.</p>:null}
        {completed?<p className="review-outcome" role="status">{actualMessage}</p>:null}
        <div className="order-review-actions"><Button kind="secondary" disabled={!canCheck} onClick={()=>void run('check')}>{working==='check'?'Checking…':unconfirmed||acknowledged?'Check saved outcome':completed?'Recheck confirmed outcome':'Check current closing values'}</Button>{!completed&&!acknowledged&&record?.phase==='review'?<><Button kind="secondary" disabled={!ready} onClick={()=>void run('withdraw',{outcome:'withdrawn'})}>Withdraw saved closing action</Button><Button disabled={!ready||!proposal?.enabled} onClick={()=>void run('replace',{outcome:'replaced'})}>Apply reviewed closing action</Button></>:null}</div>
        {command.type==='closing.record'?<p>Withdrawing keeps records already online. A later saved undo for this count may need separate review.</p>:null}
        {record?.attempts.length?<details><summary>Saved closing decisions ({record.attempts.length})</summary><ol>{record.attempts.map((attempt,index)=><li key={index}>{attempt.outcome==='withdrawn'?'Withdraw action':'Apply reviewed replacement'} · {new Date(attempt.at).toLocaleString('en-GB',{timeZone:timezone})}</li>)}</ol></details>:null}
        <CopyClosingReview source={saved} command={command}/>
      </>:null}
      {working?<><p role="status" aria-live="polite">{working==='check'?'Checking the actual outcome and current closing…':'Confirming your saved closing decision…'}</p><Button kind="secondary" onClick={()=>active.current?.abort()}>Stop closing check</Button></>:null}
      {error?<p className="form-error" role="alert">{error}</p>:null}{notice?<p role="status" aria-live="polite">{notice}</p>:null}{!online?<p>Offline. Your source and any saved choice stay on this device. Reconnect to check the actual outcome.</p>:null}
      <div className="order-review-actions"><Link to="/">Open Today</Link><Link to="/settings/exports">Download a JSON backup</Link></div>
    </>:null}
  </section>;
}
