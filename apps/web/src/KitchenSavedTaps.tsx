import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import type {ScreenJournalRecord} from '@mise/core/device-screen-state';
import type {KitchenTap} from '@mise/core/kitchen-screen';
import type {ScreenJournal} from './data/device-screen-journal';
import {createKitchenSavedSession} from './data/kitchen-saved-session';
import {DeviceScreenRequestError} from './data/device-screen-remote';
import './kitchen-screen.css';
import './staff-device.css';
const KitchenScreen=lazy(()=>import('./KitchenScreen').then(module=>({default:module.KitchenScreen})));

export function KitchenWorkspace({journal,source,onSignOut}:{journal:ScreenJournal;source:ScreenJournalRecord;onSignOut:()=>Promise<void>}){
  const [saved,setSaved]=useState(false);
  return saved?<><nav className="staff-device-nav" aria-label="Preparation screen"><Button kind="secondary" onClick={()=>setSaved(false)}>Back to Kitchen</Button><Button kind="secondary" onClick={()=>void onSignOut()}>Sign out</Button></nav><KitchenSavedTaps journal={journal} source={source}/></>:<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening kitchen tickets…</p></main>}><KitchenScreen journal={journal} source={source} onSignOut={onSignOut} onSavedTaps={()=>setSaved(true)}/></Suspense>;
}

export function KitchenSavedTaps({journal,source}:{journal:ScreenJournal;source:ScreenJournalRecord}){
  const [taps,setTaps]=useState<KitchenTap[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[online,setOnline]=useState(navigator.onLine),[error,setError]=useState(''),[notice,setNotice]=useState(''),[manual,setManual]=useState(''),[limit,setLimit]=useState(20),[blocked,setBlocked]=useState(false);
  const actor=useRef<ReturnType<typeof createKitchenSavedSession>|null>(null),active=useRef(false),working=useRef(false),readEpoch=useRef(0),field=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{
    let mounted=true,reading=false;readEpoch.current++;active.current=true;working.current=false;setBusy(false);setBlocked(false);setLoading(true);setTaps([]);setError('');setNotice('');setManual('');const reader=createKitchenSavedSession(journal,source);actor.current=reader;
    async function read(){if(reading||working.current)return;reading=true;const epoch=readEpoch.current;try{const rows=await reader.load();if(mounted&&epoch===readEpoch.current)setTaps(rows);}catch(e){if(mounted&&epoch===readEpoch.current){setTaps([]);setManual('');setBlocked(true);setError(e instanceof Error?e.message:'Reopen this screen with your PIN.');}}finally{reading=false;if(mounted&&epoch===readEpoch.current)setLoading(false);}}
    const wake=()=>{setOnline(navigator.onLine);if(!working.current)void read();};
    void read();window.addEventListener('online',wake);window.addEventListener('offline',wake);window.addEventListener('storage',wake);
    const timer=setInterval(()=>{if(!working.current&&document.visibilityState==='visible')void read();},5000);
    return()=>{mounted=false;active.current=false;reader.dispose();actor.current=null;clearInterval(timer);window.removeEventListener('online',wake);window.removeEventListener('offline',wake);window.removeEventListener('storage',wake);};
  },[journal,source]);
  useEffect(()=>{if(manual){field.current?.focus();field.current?.select();}},[manual]);
  async function run(tap:KitchenTap,close=false){
    const reader=actor.current;if(!reader||working.current||blocked)return;working.current=true;readEpoch.current++;setBusy(true);setError('');setNotice('');
    try{
      let rows=close?await reader.close(tap):await reader.load();if(active.current&&actor.current===reader)setTaps(rows);
      if(navigator.onLine){const current=rows.find(row=>row.action.id===tap.action.id);if(current)rows=await reader.check(current);if(active.current&&actor.current===reader)setTaps(rows);}
      if(active.current&&actor.current===reader)setNotice(close?'Close request saved. A confirmation keeps the original outcome.':navigator.onLine?'Original confirmation checked.':'Offline. Your original tap stays on this screen.');
    }catch(e){if(active.current&&actor.current===reader){if(e instanceof DeviceScreenRequestError&&e.kind==='auth'){reader.dispose();setBlocked(true);setTaps([]);setManual('');}setError(e instanceof Error?e.message:'Could not check the original. Keep this screen’s saved data.');}}
    finally{if(actor.current===reader){working.current=false;if(active.current)setBusy(false);}}
  }
  async function copy(tap:KitchenTap){
    const reader=actor.current;if(!reader||blocked)return;
    let own:KitchenTap|undefined;
    try{own=(await reader.load()).find(row=>row.action.id===tap.action.id);if(!own)throw Error('Reopen this screen with your own PIN.');}
    catch(e){if(active.current&&actor.current===reader){setTaps([]);setManual('');setBlocked(true);setError(e instanceof Error?e.message:'Reopen this screen with your own PIN.');}return;}
    if(!active.current||actor.current!==reader)return;
    const text=[own.source.number,...own.source.lines.map(line=>`${line.qty}× ${line.name}${line.unit?' · '+line.unit:''}${line.note?' · '+line.note:''}`)].join('\n');
    setManual('');try{await navigator.clipboard.writeText(text);if(active.current&&actor.current===reader)setNotice('Original ticket copied.');}catch{if(active.current&&actor.current===reader){setManual(text);setNotice('Select and copy the original below.');}}
  }
  return <main className="kitchen-screen">
    <div className="kitchen-heading"><div><h1>My saved taps</h1><p>Your original preparation taps on this screen, including earlier PIN sessions.</p></div></div>
    <p>{online?'Check a confirmation before recording new work.':'Offline · original taps kept on this screen.'} Closing a saved tap does not undo accepted preparation.</p>
    {error?<p className="kitchen-notice" role="alert">{error}</p>:null}{notice?<p className="kitchen-notice" role="status">{notice}</p>:null}
    <section className="kitchen-saved-taps" aria-label="My saved preparation taps" aria-busy={loading||busy}>
      <ul className="kitchen-review-list">{taps.slice(0,limit).map(tap=>{
        const kind=tap.action.type==='kitchen.ready'?'Ready':tap.source.status==='cancelled'?'Understood':'Got it';
        return <li key={tap.action.id} className="kitchen-review-item"><h2>{tap.source.number} · {kind}</h2>
          <p>{new Intl.DateTimeFormat('en-GB',{timeZone:tap.source.timezone,dateStyle:'medium',timeStyle:'short'}).format(tap.action.occurredAt)}</p>
          <p>{tap.receipt?`${kind} was accepted. The original confirmation is saved.`:tap.closure?'Closed after review. The original ticket is kept.':tap.closeIntents?.length?'Close request saved on this screen · waiting for confirmation.':'Confirmation is still needed. The original tap is kept.'}</p>
          <details><summary>Original ticket</summary><p>{tap.source.type.replaceAll('_',' ')}{tap.source.table?' · Table '+tap.source.table:''}</p><ul>{tap.source.lines.map(line=><li key={line.id}><strong>{line.qty}× {line.name}</strong>{line.unit?' · '+line.unit:''}{line.note?<p>{line.note}</p>:null}{line.unavailable?<p>Unavailable</p>:null}{line.substitution?<p>Swap from {line.substitution.from} · {line.substitution.accepted?'Accepted':'Awaiting customer acceptance'}</p>:null}</li>)}</ul></details>
          <div className="kitchen-review-actions"><Button kind="ghost" onClick={()=>void copy(tap)}>Copy original ticket</Button>{!tap.receipt&&!tap.closure?<><Button kind="ghost" disabled={busy||!online||blocked} onClick={()=>void run(tap)}>Check confirmation</Button><Button kind="secondary" disabled={busy||blocked} onClick={()=>void run(tap,true)}>Close saved tap</Button></>:null}</div>
        </li>;
      })}</ul>
      {limit<taps.length?<Button kind="ghost" onClick={()=>setLimit(value=>value+20)}>Show more saved taps</Button>:null}
      {!loading&&!taps.length?<p>{blocked?'Sign out and use your own PIN again. Originals stay on this device.':'No saved preparation taps for your PIN on this screen.'}</p>:null}
    </section>
    {manual?<label>Original ticket for manual copy<textarea ref={field} readOnly rows={6} value={manual} onFocus={event=>event.target.select()}/></label>:null}
  </main>;
}
