import {useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router-dom';
import {Button} from '@mise/ui/primitives.tsx';
import {parseStockCommand} from '@mise/core/stock-commands';
import {parseSyncSession} from '@mise/core/sync-session';
import {readCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import type {SetupSnapshot} from '@mise/core/models';
import type {StockReviewChoice} from '@mise/core/stock-review-journal';
import {db} from './data/db';
import type {PhoneAuth} from './data/phone-auth';
import {cycleAccount} from './data/sync-cycle';
import {prepareSavedStockReview,decideSavedStockReview,readStockReviewWorkspace,type StockReviewWorkspace,type StockReviewOptions} from './data/stock-review-session';
import {StockReviewRows,StockReviewInputFacts,StockReviewNotes,CopyStockReview,stockActionName} from './StockReviewFacts';
export function StockActionReview({
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
    [workspace, setWorkspace] = useState<StockReviewWorkspace | null>(null),
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
      review = selectedId ? await db.stockReviews.get(selectedId) : null,
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
    void readStockReviewWorkspace(db, selected.current)
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
  async function options(): Promise<StockReviewOptions> {
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
  async function run(kind: string, outcome?: StockReviewChoice) {
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
        const result = await decideSavedStockReview(
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
        const result = await prepareSavedStockReview(
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

  const record=workspace?.record,quote=record?.quote,command=workspace?parseStockCommand(workspace.source.command):null,saved=workspace?.original,proposal=quote?.proposal,completed=record?.phase==='confirmed',acknowledged=workspace?.acknowledged===true,unconfirmed=!!record&&['deciding','unconfirmed'].includes(record.phase),ready=online&&!!config&&auth?.getSnapshot().phase==='signed-in'&&!working,canCheck=online&&!!config&&!!auth&&!working&&!['signed-out','closed','code'].includes(auth.getSnapshot().phase),timezone=quote?.current.timezone??setup.outlet.timezone;
  const names=new Map(saved?.events.map(e=>[e.stockItemId,e.after.item.name])??[]),actual=record?.receipt,actualMessage=actual?.type==='command.resolved'?actual.outcome==='withdrawn'?'The saved stock action was withdrawn. Online quantities are unchanged, and your original source is kept.':'The reviewed stock action was recorded. Your original source and confirmed outcome are kept.':'The original stock action was already recorded. No replacement was needed.';
  const unavailable=proposal&&!proposal.enabled?({unit:'The stock unit changed. The saved quantity cannot be reinterpreted in a different unit. You can keep this source or withdraw the action and enter a separate update.',clock:'The saved device time is ahead of the server. Check the device clock and keep this source.',expired:'The original 24-hour undo window has ended. You can keep the source or withdraw this action.',count:'A later physical count blocks this undo. Undo that count first, or record a new count.',unavailable:'This action cannot be applied with the current item, available quantity or related records. You can keep the source or withdraw this action.'}[proposal.reason]):'';
  return <section className="order-action-review stock-action-review" aria-label="Saved stock review">
    <Button kind="secondary" aria-expanded={open} disabled={!!working} onClick={()=>{if(!open){selected.current=undefined;setWorkspace(null);setError('');setNotice('');}setOpen(value=>!value);}}>{open?'Close stock review':'Review saved stock'}</Button>
    {open?<>
      <h3>Review saved stock</h3>
      <p>Your saved quantities, units and notes stay on this device. Check current stock before choosing what to record.</p>
      {!workspace&&!error?<p role="status">{sourceLoading?'Reading the saved stock source…':'No rejected stock action is ready here. Use the original outlet and keep a JSON backup.'}</p>:null}
      {command&&saved?<>
        <p className="review-action-name">{stockActionName(command)}{saved.events.length>1?` · ${saved.events.length.toLocaleString('en')} items`:''}</p>
        <p>Saved {new Date(command.occurredAt).toLocaleString('en-GB',{timeZone:timezone})} · {timezone}</p>
        <div className="order-review-comparison">
          <div><h4>Saved on this device</h4><StockReviewRows rows={saved.events.map(e=>({id:e.stockItemId,name:e.after.item.name,item:e.after.item,...(e.before?{before:e.before.onHand}:{})}))} timezone={timezone}/>{'input'in command?<StockReviewInputFacts input={command.input} supplier={quote?.current.suppliers.saved??null} checked={!!quote}/>:null}<StockReviewNotes command={command} names={names}/><p>The original quantities, units and physical times are kept.</p></div>
          <div><h4>Last checked online</h4>{quote?<><StockReviewRows rows={quote.current.items.map(row=>({id:row.stockItemId,name:names.get(row.stockItemId)??'Stock item',item:row.item}))} timezone={timezone}/>{quote.current.input?<StockReviewInputFacts input={quote.current.input} supplier={quote.current.suppliers.current} checked/>:null}{quote.current.undo?<p>{quote.current.undo.reversed?'This movement has already been undone.':`Original undo deadline: ${new Date(quote.current.undo.move.createdAt+86400000).toLocaleString('en-GB',{timeZone:timezone})} · ${timezone}`}</p>:null}<p>Checked {new Date(quote.at).toLocaleString('en-GB',{timeZone:timezone})}. Values are checked again before applying.</p></>:<p>Check online to compare this saved action with current stock.</p>}</div>
        </div>
        {'input'in command&&quote&&(command.input.supplierId||quote.current.input?.supplierId)?<p>Supplier names reflect current online records. The saved supplier selection is kept.{quote.current.input&&command.input.supplierId!==quote.current.input.supplierId?' This action changes the linked supplier.':''}</p>:null}
        {quote&&!completed?<div className="order-review-proposal"><h4>Reviewed result</h4>{proposal?.enabled?<><StockReviewRows rows={proposal.items.map((item,i)=>({id:item.id,name:item.name,item,...(quote.current.items[i].item?{before:quote.current.items[i].item.onHand}:{})}))} timezone={timezone}/>{proposal.input?<StockReviewInputFacts input={proposal.input} supplier={quote.current.suppliers.saved} checked/>:null}<p>{command.type==='stock.undo'?'This reverses the original movement within its original 24-hour limit.':command.type==='stock.update'&&command.moveId===null||command.type==='stock.archive'||command.type==='stock.restore'?'The current quantity and physical-count history are kept.':command.type==='stock.batch'?`All ${proposal.items.length.toLocaleString('en')} saved changes are recorded together.`:'The saved count or movement is applied to the checked current stock.'}</p></>:<p>{unavailable}</p>}</div>:null}
        {unconfirmed?<p role="status">Your choice to {record?.choice?.outcome==='withdrawn'?'withdraw this stock action':'apply this reviewed stock action'} is saved, but its server outcome is unconfirmed. Check the saved outcome before making another correction.</p>:null}
        {completed?<p className="review-outcome" role="status">{actualMessage}</p>:null}
        <div className="order-review-actions"><Button kind="secondary" disabled={!canCheck} onClick={()=>void run('check')}>{working==='check'?'Checking…':unconfirmed||acknowledged?'Check saved outcome':completed?'Recheck confirmed outcome':'Check current stock values'}</Button>{!completed&&!acknowledged&&record?.phase==='review'?<><Button kind="secondary" disabled={!ready} onClick={()=>void run('withdraw',{outcome:'withdrawn'})}>Withdraw saved stock action</Button><Button disabled={!ready||!proposal?.enabled} onClick={()=>void run('replace',{outcome:'replaced'})}>Apply reviewed stock action{saved.events.length>1?` (${saved.events.length.toLocaleString('en')} items)`:''}</Button></>:null}</div>
        {record?.attempts.length?<details><summary>Saved stock decisions ({record.attempts.length})</summary><ol>{record.attempts.map((attempt,index)=><li key={index}>{attempt.outcome==='withdrawn'?'Withdraw action':'Apply reviewed replacement'} · {new Date(attempt.at).toLocaleString('en-GB')}</li>)}</ol></details>:null}
        <CopyStockReview source={saved} command={command}/>
      </>:null}
      {working?<><p role="status" aria-live="polite">{working==='check'?'Checking the actual outcome and current stock…':'Confirming your saved stock decision…'}</p><Button kind="secondary" onClick={()=>active.current?.abort()}>Stop stock check</Button></>:null}
      {error?<p className="form-error" role="alert">{error}</p>:null}{notice?<p role="status" aria-live="polite">{notice}</p>:null}{!online?<p>Offline. Your source and any saved choice stay on this device. Reconnect to check the actual outcome.</p>:null}
      <div className="order-review-actions"><Link to="/stock">Open stock</Link><Link to="/settings/exports">Download a JSON backup</Link></div>
    </>:null}
  </section>;
}
