import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {Avatar} from '@mise/ui/Avatar.tsx';
import {usualShiftExpectation} from '@mise/core/staff-attendance';
import type {StaffDeviceAccess} from '@mise/core/device-access';
import type {StaffDeviceBoard,StaffDeviceBoardMember} from '@mise/core/staff-device-board';
import type {ScreenJournalRecord} from '@mise/core/device-screen-state';
import type {ScreenJournal} from './data/device-screen-journal';
import {createStaffDeviceSession,type StaffDeviceSession} from './data/staff-device-session';
import {DeviceScreenRequestError} from './data/device-screen-remote';
import {StaffShift} from './StaffShift';
import {staffRoleNames} from './staff-display';
import {useAppUpdate} from './app-update';
import './staff-device.css';
const KitchenScreen=lazy(()=>import('./KitchenScreen').then(m=>({default:m.KitchenScreen})));
const KitchenSavedTaps=lazy(()=>import('./KitchenSavedTaps').then(m=>({default:m.KitchenSavedTaps})));
const StaffStockScreen=lazy(()=>import('./StaffStockScreen').then(m=>({default:m.StaffStockScreen})));
const time=(at:number,zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'}).format(at);
const method={manual:'told the manager',order_phone:'tapped here',link:'staff link',group:'staff group'};
export function StaffDeviceScreen({journal,source,kitchenEnabled,onSignOut,onSwitchMember}:{journal:ScreenJournal;source:ScreenJournalRecord;kitchenEnabled:boolean;onSignOut:()=>Promise<void>;onSwitchMember:(id:string)=>Promise<void>}){
 const [updateReady,applyUpdate]=useAppUpdate();
 const [page,setPage]=useState<'board'|'mine'|'kitchen'|'saved'|'stock'>('board'),[stockAvailable,setStockAvailable]=useState(false),[stockOriginals,setStockOriginals]=useState(false),[board,setBoard]=useState<StaffDeviceBoard|null>(null),[members,setMembers]=useState<StaffDeviceBoardMember[]>([]),[access,setAccess]=useState<StaffDeviceAccess|null>(null),[busy,setBusy]=useState(false),[denied,setDenied]=useState(false),[connected,setConnected]=useState(false),[error,setError]=useState(''),[copyText,setCopyText]=useState(''),[notice,setNotice]=useState('');
 const actor=useRef<StaffDeviceSession|null>(null),mounted=useRef(true),working=useRef(false),expanded=useRef(false),retryAt=useRef(0),reload=useRef<()=>Promise<void>>(async()=>{}),field=useRef<HTMLTextAreaElement>(null);
 const createSession=useCallback(()=>createStaffDeviceSession(journal,source),[journal,source]);
 useEffect(()=>{if(copyText){field.current?.focus();field.current?.select();}},[copyText]);
 useEffect(()=>{
  mounted.current=true;let active=true,reader:StaffDeviceSession|null=null;
  const read=async(more=false)=>{
   if(!active||!reader||working.current||Date.now()<retryAt.current||document.visibilityState==='hidden')return;working.current=true;setBusy(true);
   try{const result=await reader.board(more?boardCursor.current:null);if(!active)return;setBoard(result);setAccess(result.access);setStockAvailable(result.access.permissions.includes('stock.read'));setDenied(false);setConnected(true);setError('');if(more)setMembers(old=>[...old,...result.members.filter(m=>!old.some(r=>r.id===m.id))]);else setMembers(result.members);boardCursor.current=result.next;}
   catch(e){if(active){setConnected(false);setError(e instanceof Error?e.message:'Ask the manager to log attendance by hand.');if(e instanceof DeviceScreenRequestError&&e.kind==='auth'){setBoard(null);setMembers([]);setDenied(true);setAccess(null);}if(e instanceof DeviceScreenRequestError&&e.kind==='backoff')retryAt.current=e.retryAt??Date.now()+60000;}}
   finally{working.current=false;if(active)setBusy(false);}
  };
  void(async()=>{reader=await createSession();if(!active){reader.stop();return;}actor.current=reader;
   try{const value=await reader.access();if(active){setAccess(value);setStockAvailable(value.permissions.includes('stock.read'));}}catch{/* Attendance and stock have their own live access checks. */}
   try{const saved=await journal.readStock(source);if(active)setStockOriginals(present=>present||Boolean(saved?.actions.length));}catch{/* A damaged journal stays intact; current stock still checks native storage before work. */}
   reload.current=()=>{expanded.current=false;return read();};moreRows.current=()=>read(true);await read();
  })().catch(e=>{if(active)setError(e instanceof Error?e.message:'Use your own PIN on this screen.');});
  const interval=setInterval(()=>{if(!expanded.current)void read();},5000),wake=()=>{if(!expanded.current)void read();};window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;mounted.current=false;reader?.stop();actor.current=null;clearInterval(interval);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
 },[createSession]);
 const boardCursor=useRef<string|null>(null),moreRows=useRef<()=>Promise<void>>(async()=>{});
 async function copy(text:string){setCopyText('');try{await navigator.clipboard.writeText(text);if(mounted.current)setNotice('Copied. Pass this note to the manager.');}catch{if(mounted.current){setCopyText(text);setNotice('Select and copy the note below.');}}}
 async function switchMember(row:StaffDeviceBoardMember){if(busy)return;if(row.id===access?.memberId){setPage('mine');return;}setBusy(true);try{await onSwitchMember(row.id);}catch{if(mounted.current)setError('Keep this sign-out and try again before entering another PIN.');}finally{if(mounted.current)setBusy(false);}}
 const missing=board?members.find(row=>row.latest?.type!=='in'&&usualShiftExpectation(row.shift,board.serverAt,board.timeZone).state==='due'):null;
 return <div className="staff-device-workspace"><nav className="staff-device-nav" aria-label="Shared screen"><Button kind={page==='board'?'primary':'secondary'} onClick={()=>setPage('board')}>Who’s here</Button><Button kind={page==='mine'?'primary':'secondary'} onClick={()=>setPage('mine')}>My shift</Button>{kitchenEnabled&&!denied&&access?.permissions.includes('orders.read')?<Button kind={page==='kitchen'?'primary':'secondary'} onClick={()=>setPage('kitchen')}>Kitchen</Button>:null}{kitchenEnabled?<Button kind={page==='saved'?'primary':'secondary'} onClick={()=>setPage('saved')}>My saved taps</Button>:null}<Button kind={page==='stock'?'primary':'secondary'} onClick={()=>setPage('stock')}>{stockAvailable||stockOriginals?'Stock':'Stock requests'}</Button>{page!=='kitchen'?<Button kind="secondary" onClick={()=>void onSignOut()}>Sign out</Button>:null}</nav>
  {updateReady?<Button kind="secondary" onClick={applyUpdate}>Reload for update</Button>:null}
  {page==='stock'?<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening stock…</p></main>}><StaffStockScreen journal={journal} source={source} onOriginals={setStockOriginals}/></Suspense>:page==='saved'?<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening your saved taps…</p></main>}><KitchenSavedTaps journal={journal} source={source}/></Suspense>:page==='mine'?<StaffShift createSession={createSession} mode="device"/>:page==='kitchen'?<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening kitchen tickets…</p></main>}><KitchenScreen journal={journal} source={source} onSignOut={onSignOut}/></Suspense>:<main className="staff-device-board">
   <header><h1>Who’s here</h1><p>{board?.outletName??'Use your own PIN on this enrolled screen.'}</p><p>Tap your photo to open your shift. Another member signs in with their own PIN.</p></header>
   <div className="staff-device-read"><small>{connected?'Checked':'Last checked'} {board?time(board.serverAt,board.timeZone):'—'}</small><Button kind="secondary" disabled={busy} onClick={()=>void reload.current()}>Refresh board</Button></div>
   <section className="staff-device-grid" aria-label="Outlet attendance">{members.map(row=>{
    const state=row.latest?.type??'out',expectation=board?usualShiftExpectation(row.shift,board.serverAt,board.timeZone):null;
    return <Card key={row.id} className="staff-device-person"><button className="staff-device-person-action" disabled={busy||!row.canSignIn} aria-label={row.id===access?.memberId?'Open my shift':row.canSignIn?'Sign in as '+row.name:row.name+' · manager records attendance'} onClick={()=>void switchMember(row)}><Avatar name={row.name} className="staff-device-avatar"/><strong>{row.name}</strong><span>{row.station||staffRoleNames[row.role]}</span><span className={state==='in'?'staff-device-presence in':expectation?.state==='due'?'staff-device-presence due':'staff-device-presence'}>{state==='in'?<><img src={import.meta.env.BASE_URL+'staff-device-assets/check.svg'} width="12" height="12" alt=""/>On duty</>:state==='break'?'On a break':expectation?.state==='due'?'Not in yet':row.latest?'Left':expectation?.state==='upcoming'?'Starts '+String(Math.floor(expectation.start!/60)).padStart(2,'0')+':'+String(expectation.start!%60).padStart(2,'0'):'No check-in'}</span><small>{row.latest&&board?method[row.latest.method]+' · '+time(row.latest.at,board.timeZone):row.canSignIn?'Use your own PIN':'Ask the manager'}</small></button></Card>;
   })}</section>
   {!members.length?<Card><h2>{denied?'Attendance needs the manager’s setup':'No attendance loaded'}</h2><p>The manager enables order-phone attendance and sets a PIN in their own Team setup. They can log your arrival by hand.</p><Button kind="secondary" onClick={()=>void copy('Please log my arrival or departure by hand. This screen could not confirm attendance.')}>Copy message for manager</Button></Card>:null}
   {board?.next?<Button kind="secondary" disabled={busy} onClick={()=>{expanded.current=true;void moreRows.current();}}>Show more people</Button>:null}
   <Button kind="secondary" className="staff-device-extra" onClick={()=>void copy('Extra help today — please add their name and contact number in Team.')}><img src={import.meta.env.BASE_URL+'staff-device-assets/plus.svg'} width="16" height="16" alt=""/>Extra help today? Ask the manager to add them</Button>
   {missing?<Card className="staff-device-missing"><h2>{missing.name} isn’t in yet.</h2><p>Copy a note for the manager.</p><div>{['Late','Absent','Swapped…'].map(label=><Button key={label} kind="secondary" onClick={()=>void copy(missing.name+' · '+label+'\nPlease review attendance in Team.')}>{label}</Button>)}{missing.canSignIn?<Button onClick={()=>void switchMember(missing)}>Here · use own PIN</Button>:null}</div></Card>:null}
   {error?<p role="alert">{error}</p>:null}<p role="status">{notice}</p>{notice?<Button kind="secondary" onClick={()=>setNotice('You passed the note on. The manager can record attendance in Team.')}>I told the manager</Button>:null}{copyText?<label>Note for manual copy<textarea aria-label="Note for manual copy" ref={field} rows={5} readOnly value={copyText} onFocus={e=>e.target.select()}/></label>:null}
  </main>}
 </div>;
}
