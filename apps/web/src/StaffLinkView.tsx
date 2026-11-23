import {useEffect,useMemo,useRef,useState} from 'react';
import {useLocation} from 'react-router-dom';
import {Avatar} from '@mise/ui/Avatar.tsx';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {decodeStaffViewer,type StaffHistoryCursor,type StaffHistoryEntry,type StaffViewerLink,type StaffView} from '@mise/core/staff-links';
import type {CheckInType} from '@mise/core/staff-attendance';
import {createStaffPublicSession,StaffVisitError,type SavedStaffCheckIn,type StaffPublicSession} from './data/staff-public-session';
import {staffRoleNames} from './staff-display';
import './staff-public.css';
const words={
 en:{title:'My shift',here:'I’m here',leaving:'Leaving',break:'Take a break',resume:'I’m back',in:'On duty',out:'Not on duty',onBreak:'On a break',check:'Check now',checked:'Checked',last:'Last checked',history:'Your recorded activity',more:'Show older records',empty:'No check-in recorded yet.',original:'Saved original tap',pending:'This tap is unconfirmed. Keep it and check before another tap.',applied:'This original tap was recorded. Check the current status above.',closed:'This unfinished tap was closed.',checkSaved:'Check saved tap',retry:'Retry saved tap',close:'Close unfinished tap',copy:'Copy check-in message',copyOriginal:'Copy original tap',copyLabel:'Message for manual copy',copied:'Copied. Reply to the message where you received this link, or tell the manager in person.',select:'Select and copy the text below.',manual:'Tell the manager by hand if the link cannot be used.',reference:'Original reference',missing:'This staff link is unavailable.',complete:'Open the complete current link from the shop.',readonly:'This browser could not retain a new tap. Copy your message or tell the manager by hand.',privacy:'No location or screen monitoring. You can see the check-ins recorded about you.',wrong:'Something wrong? Copy your record for the manager',recordedBy:'Logged by',usual:'Usual shift',nextDay:'ends the next day'},
 bn:{title:'আমার শিফট',here:'আমি এসেছি',leaving:'বের হচ্ছি',break:'বিরতি নিচ্ছি',resume:'ফিরে এসেছি',in:'ডিউটিতে আছেন',out:'ডিউটিতে নেই',onBreak:'বিরতিতে আছেন',check:'এখন যাচাই করুন',checked:'যাচাই হয়েছে',last:'শেষ যাচাই',history:'আপনার লেখা উপস্থিতি',more:'আগের রেকর্ড দেখুন',empty:'এখনও উপস্থিতি লেখা হয়নি।',original:'আগের সংরক্ষিত অনুরোধ',pending:'এই অনুরোধ নিশ্চিত হয়নি। আরেকটি দেওয়ার আগে এটি যাচাই করুন।',applied:'এই আগের অনুরোধ লেখা হয়েছে। উপরে বর্তমান অবস্থা যাচাই করুন।',closed:'অসমাপ্ত অনুরোধ বন্ধ হয়েছে।',checkSaved:'আগের অনুরোধ যাচাই',retry:'আগের অনুরোধ আবার পাঠান',close:'অসমাপ্ত অনুরোধ বন্ধ',copy:'উপস্থিতির বার্তা কপি',copyOriginal:'আগের অনুরোধ কপি',copyLabel:'হাতে কপির জন্য বার্তা',copied:'কপি হয়েছে। যে বার্তায় লিংকটি পেয়েছেন সেখানে উত্তর দিন বা ম্যানেজারকে জানান।',select:'নিচের লেখা বেছে কপি করুন।',manual:'লিংক কাজ না করলে ম্যানেজারকে সরাসরি জানান।',reference:'আগের রেফারেন্স',missing:'এই স্টাফ লিংক এখন পাওয়া যাচ্ছে না।',complete:'দোকান থেকে পাওয়া সম্পূর্ণ বর্তমান লিংক খুলুন।',readonly:'এই ব্রাউজারে নতুন অনুরোধ রাখা যায়নি। বার্তা কপি করে ম্যানেজারকে জানান।',privacy:'লোকেশন বা স্ক্রিন দেখা হয় না। আপনার সম্পর্কে লেখা উপস্থিতি আপনি দেখতে পান।',wrong:'ভুল আছে? ম্যানেজারের জন্য রেকর্ড কপি করুন',recordedBy:'লিখেছেন',usual:'সাধারণ শিফট',nextDay:'পরের দিন শেষ'},
};
const methods={en:{manual:'told the manager in person',link:'own staff link',order_phone:'order phone',group:'staff group'},bn:{manual:'ম্যানেজারকে সরাসরি বলেছেন',link:'নিজের স্টাফ লিংক',order_phone:'দোকানের ফোন',group:'স্টাফ গ্রুপ'}};
const clock=(at:number,zone:string,language:'en'|'bn')=>new Intl.DateTimeFormat(language==='bn'?'bn-BD':'en-GB',{timeZone:zone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(at);
const shiftClock=(value:number)=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
export function StaffLinkView(){
 const route=useLocation(),source=useMemo(()=>{try{return decodeStaffViewer(location.pathname,route.hash,import.meta.env.BASE_URL);}catch{return null;}},[route.pathname,route.hash]);
 return source?<StaffShift key={route.pathname+route.hash} source={source}/>:<main className="staff-public"><h1>{words.en.missing}</h1><p>{words.en.complete}</p></main>;
}
function StaffShift({source}:{source:StaffViewerLink}){
 const [session,setSession]=useState<StaffPublicSession|null>(null),[view,setView]=useState<StaffView|null>(null),[original,setOriginal]=useState<SavedStaffCheckIn|null>(null),[history,setHistory]=useState<StaffHistoryEntry[]>([]),[next,setNext]=useState<StaffHistoryCursor|null>(null);
 const [language,setLanguage]=useState<'en'|'bn'>('en'),[busy,setBusy]=useState(false),[connected,setConnected]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[manual,setManual]=useState(''),[storageReady,setStorageReady]=useState(true);
 const running=useRef(false),reload=useRef<()=>Promise<void>>(async()=>{}),current=useRef(session),previousHistory=useRef(history),copyField=useRef<HTMLTextAreaElement>(null),mounted=useRef(true),chosenLanguage=useRef(false),expanded=useRef(false);current.current=session;previousHistory.current=history;
 const w=words[language],unfinished=Boolean(original&&(!original.outcome||original.outcome.state==='pending'));
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(manual){copyField.current?.focus();copyField.current?.select();}},[manual]);
 useEffect(()=>{
  let active=true,value:StaffPublicSession|null=null,reading=false,retryAt=0;const controller=new AbortController();
  const read=async()=>{
   if(!active||!value||reading||running.current||document.visibilityState==='hidden'||Date.now()<retryAt)return;reading=true;
   try{const data=await value.read(null,controller.signal);if(!active)return;setView(data);setConnected(true);setStorageReady(value.storageReady);setError('');
    const previous=previousHistory.current,overlap=data.entries.some(entry=>previous.some(old=>old.checkIn.id===entry.checkIn.id));
    if(!overlap&&data.next)expanded.current=false;
    if(!expanded.current)setNext(data.next);
    setHistory(expanded.current?[...data.entries,...previous.filter(old=>!data.entries.some(entry=>entry.checkIn.id===old.checkIn.id))]:data.entries);
    if(!chosenLanguage.current)setLanguage(data.language);
   }catch(e){if(active){setConnected(false);setError(e instanceof Error?e.message:words.en.manual);if(e instanceof StaffVisitError&&e.kind==='missing'){setView(null);setHistory([]);setNext(null);}if(e instanceof StaffVisitError&&e.kind==='limited')retryAt=Date.now()+e.retryAfter*1000;}}
   finally{reading=false;}
  };
  void(async()=>{
   value=await createStaffPublicSession(source,{storage:localStorage,locks:navigator.locks});if(!active){value.stop();return;}setSession(value);
   try{const saved=value.saved();setView(saved.view);setHistory(saved.view?.entries??[]);setNext(saved.view?.next??null);setOriginal(saved.actions.at(-1)??null);}catch{setStorageReady(false);setError(words.en.readonly);}
   reload.current=read;await read();
  })().catch(()=>{if(active)setError(words.en.manual);});
  const timer=window.setInterval(()=>void read(),5000),wake=()=>void read();window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;controller.abort();value?.stop();clearInterval(timer);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
 },[source]);
 async function copy(text:string){setManual('');try{await navigator.clipboard.writeText(text);if(mounted.current)setNotice(w.copied);}catch{if(mounted.current){setManual(text);setNotice(w.select);}}}
 const description=(type:CheckInType)=>language==='bn'?type==='in'?'আমি এসেছি':type==='out'?'বের হচ্ছি':'বিরতি নিচ্ছি':type==='in'?'I’m here':type==='out'?'Leaving':'Taking a break';
 const originalText=(row:SavedStaffCheckIn)=>[language==='bn'?(row.nameLocal||row.name):row.name,description(row.intent.type),new Date(row.intent.occurredAt).toISOString(),`${w.reference}: ${row.intent.id}`].join('\n');
 async function work(run:(captured:StaffPublicSession)=>Promise<void>){if(!session||running.current)return;const captured=session;running.current=true;setBusy(true);setError('');setNotice('');
  try{await run(captured);}catch(e){if(mounted.current&&current.current===captured)setError(e instanceof Error?e.message:w.manual);}
  finally{if(mounted.current&&current.current===captured){try{setOriginal(captured.saved().actions.at(-1)??null);}catch{setStorageReady(false);}running.current=false;setBusy(false);}}
 }
 async function send(captured:StaffPublicSession,id:string,operation:'submit'|'inspect'|'close'){
  const result=await captured.call(id,operation);if(!mounted.current||current.current!==captured)return;
  setOriginal(captured.saved().actions.at(-1)??null);setNotice(result.state==='applied'?w.applied:result.state==='closed'?w.closed:w.pending);
 }
 async function tap(type:CheckInType){if(!view)return;await work(async captured=>{const intent=await captured.prepare(view,type);if(!mounted.current||current.current!==captured)return;setOriginal(captured.saved().actions.at(-1)??null);await send(captured,intent.id,'submit');});await reload.current();}
 async function more(){if(!next)return;await work(async captured=>{const page=await captured.read(next);if(!mounted.current||current.current!==captured)return;expanded.current=true;
  setHistory(previous=>[...previous,...page.entries.filter(row=>!previous.some(old=>old.checkIn.id===row.checkIn.id))]);setNext(page.next);
 });}
 const state=view?.latest?.type??'out';
 return <main className="staff-public" lang={language==='bn'?'bn':'en'}>
  <h1 className="sr-only">{w.title}</h1><header className="staff-public-heading">
   {view?<div className="staff-public-person"><Avatar name={language==='bn'?(view.nameLocal||view.name):view.name} className="staff-public-avatar"/><div><h2>{language==='bn'?(view.nameLocal||view.name):view.name} · {staffRoleNames[view.role]}</h2><p lang="en">{view.name} · {view.outletName}</p></div></div>:null}
   <div className="staff-public-languages" aria-label="Language">{(['en','bn'] as const).map(value=><button key={value} type="button" lang={value} aria-pressed={language===value} onClick={()=>{chosenLanguage.current=true;setLanguage(value);}}>{value==='en'?'EN':'বাংলা'}</button>)}</div></header>
  {view?<>
   <section className="staff-public-status" aria-label="Current presence"><h2><span className={state==='in'?'staff-public-dot in':'staff-public-dot'} aria-hidden="true">●</span>{state==='in'?w.in:state==='break'?w.onBreak:w.out}</h2><p>{view.latest?`${clock(view.latest.at,view.timeZone,language)} · ${methods[language][view.latest.method]}`:w.empty}</p></section>
   <div className="staff-public-taps">{state!=='in'?<Button disabled={busy||unfinished||!storageReady} onClick={()=>void tap('in')}>{state==='break'?w.resume:w.here}</Button>:<Button kind="secondary" disabled={busy||unfinished||!storageReady} onClick={()=>void tap('break')}>{w.break}</Button>}{state!=='out'?<Button kind="secondary" disabled={busy||unfinished||!storageReady} onClick={()=>void tap('out')}>{w.leaving}</Button>:null}</div>
   <div className="staff-public-read"><small>{connected?w.checked:w.last} {clock(view.serverAt,view.timeZone,language)}</small><Button kind="secondary" disabled={busy} onClick={()=>void reload.current()}>{w.check}</Button></div>
   {view.shift?<Card className="staff-public-card"><h2>{w.usual}</h2><p>{view.shift.days.map(day=>(language==='bn'?['রবি','সোম','মঙ্গল','বুধ','বৃহস্পতি','শুক্র','শনি']:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[day]).join(' · ')}</p><p>{shiftClock(view.shift.start)}–{shiftClock(view.shift.end)} · {view.timeZone}{view.shift.end<view.shift.start?' · '+w.nextDay:''}</p></Card>:null}
   <Button kind="secondary" onClick={()=>void copy([view.name,description(state==='in'?'out':'in'),clock(Date.now(),view.timeZone,language),view.outletName].join('\n'))}>{w.copy}</Button>
  </>:<Card className="staff-public-card"><h2>{w.missing}</h2><p>{w.complete}</p><Button kind="secondary" disabled={busy} onClick={()=>void reload.current()}>{w.check}</Button></Card>}
  {!storageReady?<p role="status">{w.readonly}</p>:null}
  {original?<Card className="staff-public-card" aria-label="Saved original tap"><h2>{w.original}</h2><p>{original.outcome?.state==='applied'?w.applied:original.outcome?.state==='closed'?w.closed:w.pending}</p><small>{w.reference}: {original.intent.id}</small><div className="staff-public-recovery"><Button kind="secondary" disabled={busy} onClick={()=>void work(captured=>send(captured,original.intent.id,'inspect'))}>{w.checkSaved}</Button>{unfinished&&!original.closeRequested?<Button kind="secondary" disabled={busy} onClick={()=>void work(captured=>send(captured,original.intent.id,'submit'))}>{w.retry}</Button>:null}{unfinished?<Button kind="secondary" disabled={busy} onClick={()=>void work(captured=>send(captured,original.intent.id,'close'))}>{w.close}</Button>:null}<Button kind="secondary" onClick={()=>void copy(originalText(original))}>{w.copyOriginal}</Button></div></Card>:null}
  {view?<section className="staff-public-history" aria-label="Your recorded activity"><h2>{w.history}</h2>{history.length?<Card className="staff-public-history-list">{history.map(row=><article key={row.checkIn.id}><div><strong>{description(row.checkIn.type)}</strong><time dateTime={new Date(row.checkIn.at).toISOString()}>{clock(row.checkIn.at,view.timeZone,language)}</time></div><small>{methods[language][row.checkIn.method]} · {w.recordedBy} {row.recordedByName}</small></article>)}</Card>:<p>{w.empty}</p>}{next?<Button kind="secondary" disabled={busy} onClick={()=>void more()}>{w.more}</Button>:null}</section>:null}
  {view?<Button kind="secondary" onClick={()=>void copy([view.name,view.outletName,...history.map(row=>`${description(row.checkIn.type)} · ${clock(row.checkIn.at,view.timeZone,language)} · ${methods[language][row.checkIn.method]} · ${row.recordedByName}`)].join('\n'))}><img src={import.meta.env.BASE_URL+'staff-assets/message.svg'} width="18" height="18" alt=""/>{w.wrong}</Button>:null}
  {error?<p role="alert">{error}</p>:null}<p role="status">{notice}</p>{manual?<label className="staff-public-copy">{w.copyLabel}<textarea ref={copyField} aria-label={w.copyLabel} readOnly rows={6} value={manual} onFocus={e=>e.target.select()}/></label>:null}<p className="staff-public-note">{w.manual}</p><p className="staff-public-note">{w.privacy}</p>
 </main>;
}
