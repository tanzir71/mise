import {useEffect,useMemo,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router-dom';
import {Button} from '@mise/ui/primitives.tsx';
import {parseCustomerCommand} from '@mise/core/customer-commands';
import {parseSyncSession} from '@mise/core/sync-session';
import {readCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import type {SetupSnapshot} from '@mise/core/models';
import type {CustomerReviewChoice} from '@mise/core/customer-review-journal';
import {db} from './data/db';
import type {PhoneAuth} from './data/phone-auth';
import {cycleAccount} from './data/sync-cycle';
import {prepareSavedCustomerReview,decideSavedCustomerReview,readCustomerReviewWorkspace,type CustomerReviewWorkspace,type CustomerReviewOptions} from './data/customer-review-session';
import {CustomerProfileFacts,CustomerAccountFacts,CustomerOpeningFacts,CopyCustomerReview,customerActionName} from './CustomerReviewFacts';
import {readCustomerReviewContext} from '@mise/core/customer-review-view';
export function CustomerActionReview({
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
    [workspace, setWorkspace] = useState<CustomerReviewWorkspace | null>(null),
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
      review = selectedId ? await db.customerReviews.get(selectedId) : null,
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
    void readCustomerReviewWorkspace(db, selected.current)
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
  async function options(): Promise<CustomerReviewOptions> {
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
  async function run(kind: string, outcome?: CustomerReviewChoice) {
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
        const result = await decideSavedCustomerReview(
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
        const result = await prepareSavedCustomerReview(
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

  const record=workspace?.record,quote=record?.quote,command=workspace?parseCustomerCommand(workspace.source.command):null,saved=workspace?.original;
  const current=useMemo(()=>quote&&command?readCustomerReviewContext(quote.current.contextJson,quote.businessId,quote.outletId,command.customerId):null,[quote,command?.customerId]);
  const profile=saved?.events.find(event=>event.kind==='customer'),account=saved?.events.find(event=>event.kind==='account'),opening=saved?.events.find(event=>event.kind==='opening'),proposal=quote?.proposal;
  const completed=record?.phase==='confirmed',acknowledged=workspace?.acknowledged===true,unconfirmed=!!record&&['deciding','unconfirmed'].includes(record.phase),ready=online&&!!config&&auth?.getSnapshot().phase==='signed-in'&&!working,canCheck=online&&!!config&&!!auth&&!working&&!['signed-out','closed','code'].includes(auth.getSnapshot().phase),timezone=current?.outlet.timezone??setup.outlet.timezone;
  const actual=record?.receipt,actualMessage=actual?.type==='command.resolved'?actual.outcome==='withdrawn'?'The saved customer action was withdrawn. Online records are unchanged, and your original source is kept.':'The reviewed customer action was recorded. Your original source and confirmed outcome are kept.':'The original customer action was already recorded. No replacement was needed.';
  const unavailable=proposal&&!proposal.enabled?({account:'The original khata is missing or a different khata already exists. Keep this source, or withdraw the action and make a separate change using the current account.',unit:'The saved account currency cannot be changed. Keep this source, or withdraw the action and make a separate change in the intended currency.',phone:'This phone is already used by another customer. Keep this source, or withdraw the action and correct the phone separately.',unavailable:'This customer action cannot be applied to the current records. Keep the source, or withdraw it and make a separate change.'}[proposal.reason]):'';
  return <section className="order-action-review customer-action-review" aria-label="Saved customer review">
    <Button kind="secondary" aria-expanded={open} disabled={!!working} onClick={()=>{if(!open){selected.current=undefined;setWorkspace(null);setError('');setNotice('');}setOpen(value=>!value);}}>{open?'Close customer review':'Review saved customer'}</Button>
    {open?<>
      <h3>Review saved customer</h3>
      <p>Your saved details, khata settings and opening balance stay on this device. Check the current records before choosing what to record.</p>
      {!workspace&&!error?<p role="status">{sourceLoading?'Reading the saved customer source…':'No rejected customer action is ready here. Use the original outlet and keep a JSON backup.'}</p>:null}
      {command&&saved?<>
        <p className="review-action-name">{customerActionName(command)}</p>
        <p>Recorded on this device {new Date(saved.at).toLocaleString('en-GB',{timeZone:timezone})} · {timezone}</p>
        <div className="order-review-comparison">
          <div><h4>Saved on this device</h4>
            {profile?.kind==='customer'?<CustomerProfileFacts profile={profile.after}/>:<p>This action saves khata settings. The original audit does not include a customer name.</p>}
            {account?.kind==='account'?<><h5>Saved khata · {account.after.currency}</h5><CustomerAccountFacts account={account.after}/><p>{account.before===null?'Creates a new khata with these settings.':'Updates settings on the original khata.'}</p></>:<p>The original action does not change khata settings or create an account.</p>}
            {opening?.kind==='opening'?<CustomerOpeningFacts opening={opening.after} timezone={timezone}/>:null}
            <p>The original customer, khata and opening balance identities are kept.</p>
          </div>
          <div><h4>Last checked online</h4>{quote&&current?<>
            {current.customer?<><CustomerProfileFacts profile={current.customer}/>{!profile?<p>This is the current checked name, not a historical name from the saved settings.</p>:null}</>:<p>No customer is recorded online with this identity.</p>}
            {current.accounts.map(value=><div className="customer-review-account" key={value.id}><h5>Current khata · {value.currency}</h5><CustomerAccountFacts account={value} balance={quote.current.balances.find(balance=>balance.accountId===value.id)!.balance}/></div>)}
            {!current.accounts.length?<p>No khata is recorded at this outlet.</p>:null}
            {current.hasBalance?<p>This customer has an unsettled balance. Other outlets' ledger details stay private.</p>:null}
            {quote.current.phoneTaken?<p>The saved phone is unavailable for this customer.</p>:null}
            <p>Checked {new Date(quote.at).toLocaleString('en-GB',{timeZone:timezone})}. Values are checked again before applying.</p>
          </>:<p>Check online to compare this saved action with the current customer and khata.</p>}</div>
        </div>
        {quote&&!completed?<div className="order-review-proposal"><h4>Reviewed result</h4>{proposal?.enabled?<>
          {proposal.customer?<CustomerProfileFacts profile={proposal.customer}/>:<p>The current customer details are kept.</p>}
          {proposal.account?<><h5>Reviewed khata · {proposal.account.currency}</h5><CustomerAccountFacts account={proposal.account}/></>:<p>The current khata settings are kept.</p>}
          {proposal.opening?<CustomerOpeningFacts opening={proposal.opening} timezone={timezone}/>:null}
          <p>{proposal.opening?'The opening amount and its original balance date are kept.':'No opening balance is added.'} Existing ledger entries are kept.</p>
        </>:<p>{unavailable}</p>}</div>:null}
        {unconfirmed?<p role="status">Your choice to {record?.choice?.outcome==='withdrawn'?'withdraw this customer action':'apply this reviewed customer action'} is saved, but its server outcome is unconfirmed. Check the saved outcome before making another correction.</p>:null}
        {completed?<p className="review-outcome" role="status">{actualMessage}</p>:null}
        <div className="order-review-actions"><Button kind="secondary" disabled={!canCheck} onClick={()=>void run('check')}>{working==='check'?'Checking…':unconfirmed||acknowledged?'Check saved outcome':completed?'Recheck confirmed outcome':'Check current customer values'}</Button>{!completed&&!acknowledged&&record?.phase==='review'?<><Button kind="secondary" disabled={!ready} onClick={()=>void run('withdraw',{outcome:'withdrawn'})}>Withdraw saved customer action</Button><Button disabled={!ready||!proposal?.enabled} onClick={()=>void run('replace',{outcome:'replaced'})}>Apply reviewed customer action</Button></>:null}</div>
        {account?.before===null?<p>Withdrawing keeps records already online. Later saved actions for this new khata may need review.</p>:null}
        {record?.attempts.length?<details><summary>Saved customer decisions ({record.attempts.length})</summary><ol>{record.attempts.map((attempt,index)=><li key={index}>{attempt.outcome==='withdrawn'?'Withdraw action':'Apply reviewed replacement'} · {new Date(attempt.at).toLocaleString('en-GB')}</li>)}</ol></details>:null}
        <CopyCustomerReview source={saved} command={command}/>
      </>:null}
      {working?<><p role="status" aria-live="polite">{working==='check'?'Checking the actual outcome and current customer…':'Confirming your saved customer decision…'}</p><Button kind="secondary" onClick={()=>active.current?.abort()}>Stop customer check</Button></>:null}
      {error?<p className="form-error" role="alert">{error}</p>:null}{notice?<p role="status" aria-live="polite">{notice}</p>:null}{!online?<p>Offline. Your source and any saved choice stay on this device. Reconnect to check the actual outcome.</p>:null}
      <div className="order-review-actions"><Link to="/khata">Open khata</Link><Link to="/settings/exports">Download a JSON backup</Link></div>
    </>:null}
  </section>;
}
