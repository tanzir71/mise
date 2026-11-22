import {useEffect, useRef, useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {kitchenReadyPath, type KitchenActionKind} from '@mise/core/kitchen';
import {isOrderFinished} from '@mise/core/orders';
import {sameKitchenSession, type KitchenScreenState,type KitchenTap} from '@mise/core/kitchen-screen';
import type {KitchenTicket} from '@mise/core/kitchen-tickets';
import type {ScreenJournalRecord} from '@mise/core/device-screen-state';
import type {ScreenJournal} from './data/device-screen-journal';
import {createKitchenScreenSession} from './data/kitchen-screen-session';
import {DeviceScreenRequestError} from './data/device-screen-remote';
import {useAppUpdate} from './app-update';
import {watchKitchenLive} from './data/kitchen-live';
import {KitchenTapReview} from './KitchenTapReview';
import './kitchen-screen.css';

type Board = ReturnType<typeof createKitchenScreenSession>;
type Stage = 'New' | 'Cooking' | 'Ready';
const stages: Stage[] = ['New','Cooking','Ready'];
const readyStatuses = new Set(['ready','ready_called','packed']);
function scheduledTime(ticket: KitchenTicket) {
  if(ticket.scheduledFor===undefined)return '';
  try{return new Intl.DateTimeFormat('en-GB',{timeZone:ticket.timezone,dateStyle:'medium',timeStyle:'short'}).format(ticket.scheduledFor);}
  catch{return new Date(ticket.scheduledFor).toISOString();}
}
function ticketTaps(state: KitchenScreenState, ticket: KitchenTicket) {
  return state.taps.filter(tap => (tap.receipt||sameKitchenSession(tap.access,state.access))&&!tap.closure && tap.action.orderId === ticket.id && tap.action.contentHash === ticket.contentHash);
}
function ticketStage(state: KitchenScreenState, ticket: KitchenTicket): Stage {
  const taps = ticketTaps(state,ticket);
  if (readyStatuses.has(ticket.status) || taps.some(tap => tap.receipt?.type === 'kitchen.ready'&&tap.receipt.revision>=ticket.revision)) return 'Ready';
  return ticket.acknowledgement || taps.some(tap => tap.action.type==='kitchen.acknowledge'&&(tap.receipt||!tap.review&&!tap.closeIntents?.length)) ? 'Cooking' : 'New';
}
function Ticket({ticket,state,now,busy,phoneHidden,onTap,onCopy}: {ticket: KitchenTicket;state: KitchenScreenState;now: number;busy: boolean;phoneHidden: boolean;onTap: (kind: KitchenActionKind) => void;onCopy: () => void}) {
  const taps = ticketTaps(state,ticket), pending = taps.filter(tap => !tap.receipt && !tap.review&&!tap.closeIntents?.length), review = taps.some(tap => tap.review);
  const closing=state.taps.some(tap=>tap.action.orderId===ticket.id&&!tap.receipt&&!tap.closure&&tap.closeIntents?.length);
  const acknowledged = Boolean(ticket.acknowledgement) || taps.some(tap => tap.action.type==='kitchen.acknowledge'&&(tap.receipt||!tap.review&&!tap.closeIntents?.length));
  const ready = ticketStage(state,ticket) === 'Ready', cancelled = ticket.status === 'cancelled';
  const late = !acknowledged && !cancelled && now >= ticket.createdAt + state.warningMinutes * 60000;
  const canReady = acknowledged && !ready && ticket.priced && Boolean(kitchenReadyPath(ticket)?.length) && state.access.permissions.includes('orders.ready');
  const expired = now >= state.access.expiresAt;
  const changed = !acknowledged && state.taps.some(tap=>tap.action.orderId===ticket.id&&tap.action.contentHash!==ticket.contentHash);
  const label = cancelled ? 'Cancelled' : changed ? 'Changed' : ready ? 'Ready' : acknowledged ? 'Cooking' : 'New';
  const seconds=Math.max(0,Math.floor((now-ticket.createdAt)/1000)),clock=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  return <article className={`kitchen-ticket${late ? ' kitchen-ticket-late' : ''}${cancelled ? ' kitchen-ticket-cancelled' : ''}${phoneHidden ? ' kitchen-ticket-phone-hidden' : ''}`} aria-labelledby={'ticket-'+ticket.id}>
    <header><div><h2 id={'ticket-'+ticket.id}>{ticket.number}</h2><span className={`kitchen-ticket-status kitchen-ticket-status-${label.toLowerCase()}`}>{label}</span></div><span className={late?'kitchen-status-warning':''}>{clock}</span></header>
    <p className="kitchen-ticket-source">{ticket.source.replaceAll('_',' ')} · {ticket.type.replaceAll('_',' ')}{ticket.table ? ` · Table ${ticket.table}` : ''}</p>
    {ticket.scheduledFor!==undefined ? <p>For {scheduledTime(ticket)}</p> : null}
    {cancelled ? <p className="kitchen-status-warning">Cancelled — stop preparation</p> : null}
    {late ? <p className="kitchen-status-warning">Waiting for acknowledgement</p> : null}
    <ul className="kitchen-lines">{ticket.lines.map(line => <li key={line.id}><div><span className="kitchen-line-qty">{line.qty}×</span><strong>{line.name}</strong>{line.unit ? <span className="kitchen-line-unit">{line.unit}</span> : null}</div>
      {line.note ? <p>{line.note}</p> : null}{line.unavailable ? <p className="kitchen-status-warning">Unavailable</p> : null}
      {line.substitution ? <p>Swap from {line.substitution.from} · {line.substitution.accepted ? 'Accepted' : 'Awaiting customer acceptance'}</p> : null}</li>)}</ul>
    <footer>
      {pending.length ? <p className="kitchen-pending">{pending.some(tap => tap.action.type === 'kitchen.ready') ? 'Ready tap' : 'Got it tap'} saved on this screen · waiting for confirmation</p> : null}
      {review ? <p role="status">The ticket changed. Your original tap is saved for review. Copy the ticket and check with the desk.</p> : null}
      {!ticket.priced ? <p>Waiting for the desk to finish pricing.</p> : null}
      <div className="kitchen-ticket-actions">
        {!acknowledged && !cancelled ? <Button disabled={busy || expired || closing || !state.access.permissions.includes('orders.acknowledge')} onClick={() => onTap('kitchen.acknowledge')}>Got it</Button> : null}
        {acknowledged && !cancelled && !ready ? <Button kind="secondary" disabled={busy || expired || closing || !canReady || pending.some(tap => tap.action.type === 'kitchen.ready')} onClick={() => onTap('kitchen.ready')}>Ready</Button> : null}
        {ready ? <span className="kitchen-status">Ready</span> : null}
        <Button kind="ghost" onClick={onCopy}>Copy ticket</Button>
      </div>
    </footer>
  </article>;
}

export function KitchenScreen({journal,source,onSignOut}: {journal: ScreenJournal; source: ScreenJournalRecord; onSignOut: () => Promise<void>}) {
  const [updateReady,applyUpdate]=useAppUpdate();
  const [state,setState] = useState<KitchenScreenState | null>(null), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [online,setOnline] = useState(navigator.onLine), [live,setLive] = useState(false), [now,setNow] = useState(Date.now()), [stage,setStage] = useState<Stage>('New');
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState<string | null>(null), [sound,setSound] = useState(false), [awake,setAwake] = useState(false);
  const [leaving,setLeaving]=useState(false),leavingNow=useRef(false),mounted=useRef(true),pause=useRef<()=>void>(()=>{});
  const board = useRef<Board | null>(null), audio = useRef<AudioContext | null>(null), wake = useRef<WakeLockSentinel | null>(null), soundOn = useRef(false), oldTickets = useRef<Set<string> | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if(leavingNow.current)return;
    let active = true, checking = false, repeat = false, denied = false, stopLive: (() => void) | undefined;
    const controller = createKitchenScreenSession(journal,source,{changed: value => {if (active) setState(value);}});
    board.current = controller;
    mounted.current=true;
    pause.current=()=>{denied=true;stopLive?.();stopLive=undefined;setLive(false);controller.dispose();board.current=null;};
    const authDenied = () => {
      denied = true; stopLive?.(); stopLive = undefined;
      if (active) {setLive(false); setState(null); setError('Sign in with your PIN again. Saved tickets and taps stay on this device.');}
    };
    const failed = (error: unknown) => {
      if (!active) return;
      if (error instanceof DeviceScreenRequestError && error.kind === 'auth') authDenied();
      else setError('Could not confirm the latest changes. Saved tickets and taps stay on this device. Try again or copy a ticket for the desk.');
    };
    const deliver = async () => {
      if (!active || denied || !navigator.onLine) return;
      try {await controller.deliver();} catch(error) {failed(error);}
    };
    const recover = async () => {
      if(!active||denied||!navigator.onLine)return;
      try{await controller.recover();}catch(error){failed(error);}
    };
    const update = async () => {
      if (!active || denied) return;
      if (checking) {repeat = true; return;}
      checking = true;
      try {
        do {
          repeat = false;
          const cached = await controller.load();
          if (active && cached) setState(cached);
          if (navigator.onLine) {await controller.pull(); void deliver();void recover();}
          if (active) setError('');
        } while (repeat && active && !denied);
      } catch (error) {
        failed(error);
      } finally {checking = false; if (active) setLoading(false);}
    };
    refresh.current = update;
    const startLive = () => {
      if (!active || denied || !navigator.onLine || stopLive) return;
      stopLive = watchKitchenLive(journal,source,{wake:() => void update(),state:value => {if(active)setLive(value);},denied:authDenied});
    };
    const changed = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {stopLive?.(); stopLive = undefined; setLive(false);} else startLive();
      void update();
    };
    window.addEventListener('online',changed); window.addEventListener('offline',changed);
    const visible = () => {if (document.visibilityState === 'visible') void update();};
    document.addEventListener('visibilitychange',visible);
    const timer = setInterval(() => {if (document.visibilityState === 'visible') void update();},10000);
    startLive(); void update();
    return () => {active = false;mounted.current=false;pause.current=()=>{}; stopLive?.(); controller.dispose(); if (board.current === controller) board.current = null; clearInterval(timer); window.removeEventListener('online',changed); window.removeEventListener('offline',changed); document.removeEventListener('visibilitychange',visible);};
  },[journal,source]);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer);},[]);
  function beep() {
    const context = audio.current;
    if (!soundOn.current || !context || context.state !== 'running') return;
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.08,context.currentTime); gain.gain.exponentialRampToValueAtTime(0.001,context.currentTime+0.25);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime+0.25);
    oscillator.onended = () => {oscillator.disconnect(); gain.disconnect();};
  }
  useEffect(() => {
    if (!state) return;
    const current = new Set(state.tickets.map(ticket => ticket.id+':'+ticket.contentHash));
    if (oldTickets.current && [...current].some(id => !oldTickets.current!.has(id))) beep();
    oldTickets.current = current;
  },[state]);
  useEffect(() => {
    if (!awake) return;
    let active = true;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || wake.current) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (!active) {await lock.release(); return;}
        wake.current = lock;
        lock.addEventListener('release',() => {if (wake.current === lock) wake.current = null;});
      } catch {if (active) {setAwake(false); setNotice('Keep this screen open and adjust the device’s sleep setting if needed.');}}
    };
    void acquire(); document.addEventListener('visibilitychange',acquire);
    return () => {active = false; document.removeEventListener('visibilitychange',acquire); const lock = wake.current; wake.current = null; void lock?.release().catch(() => {});};
  },[awake]);
  useEffect(() => () => {soundOn.current = false; void audio.current?.close().catch(() => {}); audio.current = null;},[]);
  async function toggleSound() {
    if (soundOn.current) {soundOn.current = false; setSound(false); return;}
    try {audio.current ??= new AudioContext(); await audio.current.resume(); if (audio.current.state !== 'running') throw Error(); soundOn.current = true; setSound(true); beep();}
    catch {setNotice('Sound could not start. Check new tickets on this screen.');}
  }
  async function tap(ticket: KitchenTicket, kind: KitchenActionKind) {
    const controller = board.current;
    if (!controller || busy) return;
    setBusy(ticket.id); setNotice('');
    try {await controller.tap(ticket,kind); setNotice('Tap saved on this screen.'); void refresh.current();}
    catch {setError('The tap could not be saved. Keep this ticket open, try again or copy it for the desk.');}
    finally {setBusy(null);}
  }
  async function copy(ticket: KitchenTicket) {
    const text = [ticket.number,ticket.status==='cancelled'?'Cancelled — stop preparation':'',ticket.type.replaceAll('_',' '),ticket.table?'Table '+ticket.table:'',
      ticket.scheduledFor!==undefined?'For '+scheduledTime(ticket):'',...ticket.lines.map(line=>[
        `${line.qty}× ${line.name}${line.unit?' · '+line.unit:''}`,line.unavailable?'Unavailable':'',
        line.substitution?`Swap from ${line.substitution.from} · ${line.substitution.accepted?'Accepted':'Awaiting customer acceptance'}`:'',line.note,
      ].filter(Boolean).join('\n'))].filter(Boolean).join('\n');
    try {await navigator.clipboard.writeText(text); setNotice('Ticket copied. Check the preparation with the desk.');}
    catch {setNotice('Copy is unavailable. Read the ticket to the desk or use your browser’s text selection.');}
  }
  async function reviewTap(tap:KitchenTap,close:boolean){
    const controller=board.current;if(!controller||busy)return;
    setBusy(tap.action.id);setNotice('');
    try{
      if(close){await controller.closeTap(tap);setNotice('Review saved on this screen. Waiting for confirmation.');}
      else{await controller.recoverTap(tap);setNotice('Saved tap checked. Its original ticket is kept.');}
      void refresh.current();
    }catch{setError('Could not confirm this saved tap. Its original ticket is kept. Try again or copy it for the desk.');}
    finally{setBusy(null);}
  }
  async function signOut(){
    // Stop delivery on the gesture, before native sign-out/profile work can
    // yield to a reconnect event. Already accepted outcomes remain recoverable.
    leavingNow.current=true;pause.current();setLeaving(true);setNotice('Signing out. Saved taps stay on this device.');
    try{await onSignOut();const latest=await journal.read();if(mounted.current&&latest.state.phase==='signed-in')setError('Sign-out could not be saved. Tickets are paused. Try Sign out again.');}
    catch{if(mounted.current)setError('Sign-out could not finish. Tickets are paused. Try Sign out again.');}
  }
  const tickets = state?.tickets.filter(ticket => !isOrderFinished(ticket) || ticket.status === 'cancelled') ?? [];
  const pending = state?.taps.filter(tap => !tap.receipt&&!tap.closure).length ?? 0;
  return <main className="kitchen-screen">
    <a className="app-skip" href="#kitchen-tickets">Skip to tickets</a>
    <header className="kitchen-top"><a href="#kitchen-tickets" className="wordmark">mise <span>Kitchen</span></a><p>{state?.outletName ?? 'Shared preparation screen'}</p><Button kind="ghost" disabled={busy!==null} onClick={()=>void signOut()}>Sign out</Button></header>
    {updateReady ? <div className="kitchen-notice" role="status">An update is ready. Your saved taps stay on this screen. <Button kind="secondary" disabled={busy!==null} onClick={applyUpdate}>Reload</Button></div> : null}
    <div className="kitchen-heading"><div><h1>Kitchen</h1><p>Big tickets. Got it, then Ready.</p></div><div className="kitchen-screen-controls"><Button kind="secondary" aria-pressed={sound} onClick={() => void toggleSound()}>Sound {sound ? 'on' : 'off'}</Button><Button kind="secondary" aria-pressed={awake} onClick={() => {if (!navigator.wakeLock) setNotice('Keep this screen open and adjust the device’s sleep setting if needed.'); else setAwake(value => !value);}}>Keep awake {awake ? 'on' : 'off'}</Button></div></div>
    <div className="kitchen-connection"><p>{online ? live ? 'Live updates connected' : 'Reconnecting live updates · checking saved tickets' : 'Offline · showing saved tickets'}{state ? ` · last checked ${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(state.at)}` : ''}</p><Button kind="ghost" onClick={() => void refresh.current()}>Check now</Button></div>
    {pending ? <p className="kitchen-notice">{pending} saved {pending === 1 ? 'tap needs' : 'taps need'} confirmation. Keep this browser’s saved data.</p> : null}
    {state?<KitchenTapReview state={state} now={now} online={online} busy={busy!==null||leaving} onCheck={tap=>void reviewTap(tap,false)} onClose={tap=>void reviewTap(tap,true)} onCopy={ticket=>void copy(ticket)}/>:null}
    {error ? <p className="kitchen-notice" role="alert">{error}</p> : null}{notice ? <p className="kitchen-notice" role="status">{notice}</p> : null}
    {state && now >= state.access.expiresAt ? <p className="kitchen-notice" role="alert">Your staff session ended. Sign out and enter your PIN again. Earlier saved taps remain available for review.</p> : null}
    <section id="kitchen-tickets" className="kitchen-ticket-grid" aria-label="Preparation tickets" aria-busy={loading}>
      {state ? tickets.map(ticket => <Ticket key={ticket.id} ticket={ticket} state={state} now={now} busy={busy !== null||leaving} phoneHidden={ticketStage(state,ticket)!==stage} onTap={kind=>void tap(ticket,kind)} onCopy={()=>void copy(ticket)}/>) : null}
    </section>
    {state&&!tickets.length ? <p className="kitchen-empty">No open tickets.</p> : null}
    {state&&tickets.length>0&&!tickets.some(ticket=>ticketStage(state,ticket)===stage) ? <p className="kitchen-empty kitchen-phone-empty">{stage==='New'?'No new tickets.':stage==='Cooking'?'Nothing in preparation.':'Nothing ready yet.'}</p> : null}
    {!state ? <p className="kitchen-empty">{loading ? 'Opening saved tickets…' : online ? 'No tickets loaded. Check the connection or sign in with your PIN again.' : 'Connect once to load this staff session’s tickets. Saved taps remain on this device.'}</p> : null}
    <nav className="kitchen-phone-tabs" aria-label="Preparation stage">{stages.map(column => <button key={column} type="button" aria-current={stage === column ? 'page' : undefined} onClick={() => setStage(column)}>{column} {state?tickets.filter(ticket=>ticketStage(state,ticket)===column).length:0}</button>)}</nav>
  </main>;
}
