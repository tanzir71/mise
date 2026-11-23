import {useEffect,useRef,useState} from 'react';
import {Link,NavLink,useLocation} from 'react-router-dom';
import {Button,Card,StatusWord} from '@mise/ui/primitives.tsx';
import {Avatar} from '@mise/ui/Avatar.tsx';
import {Modal} from '@mise/ui/Modal.tsx';
import type {SetupSnapshot} from '@mise/core/models';
import type {StaffDraft,StaffRecord} from '@mise/core/staff';
import {usualShiftExpectation,type CheckInType} from '@mise/core/staff-attendance';
import type {StaffBoardEntry,StaffOwnerContext} from '@mise/core/staff-protocol';
import {newInboxId} from '@mise/core/inbox';
import {waLink} from '@mise/core/phone';
import {StaffMemberEditor} from './StaffMemberEditor';
import {useStaffOwner,type StaffOwner} from './use-staff-owner';
import type {SavedStaffAction} from './data/staff-owner-session';
import {staffDraftText as describeDraft,staffRoleNames as roles} from './staff-display';
import './staff-team.css';
const asset=import.meta.env.BASE_URL+'staff-assets/';
const methods={manual:'told the manager in person',link:'their own staff link',order_phone:'the order phone',group:'the staff group'};
const time=(at:number,zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'}).format(at);
const shiftClock=(value:number)=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');

export function StaffTeam({setup}:{setup:SetupSnapshot}){
 const {ready:owner,error:accessError,checking,refresh}=useStaffOwner(setup),ownerRef=useRef(owner);ownerRef.current=owner;
 const [board,setBoard]=useState<{ticket:string;entries:StaffBoardEntry[];next:string|null;checked:number;connected:boolean}|null>(null),[saved,setSaved]=useState<{ticket:string;item:SavedStaffAction|null}|null>(null);
 const [editor,setEditor]=useState<{ticket:string;context:StaffOwnerContext}|null>(null),[manualMember,setManualMember]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[manual,setManual]=useState(''),[query,setQuery]=useState(''),[former,setFormer]=useState(false),[contactDone,setContactDone]=useState<string[]>([]);
 const running=useRef(false),reload=useRef<()=>Promise<void>>(async()=>{}),visiblePages=useRef(1),copyField=useRef<HTMLTextAreaElement>(null),boardRef=useRef<HTMLDivElement>(null),route=useLocation(),members=route.pathname.includes('/members');
 const valid=(captured:StaffOwner)=>ownerRef.current===captured&&captured.active();
 const visible=owner&&board?.ticket===owner.ticket?board:null,original=owner&&saved?.ticket===owner.ticket?saved.item:null,unfinished=Boolean(original&&(!original.outcome||original.outcome.state==='pending'));
 useEffect(()=>{if(manual){copyField.current?.focus();copyField.current?.select();}},[manual]);
 useEffect(()=>{
  setBusy(false);running.current=false;visiblePages.current=1;setManual('');setNotice('');setError('');setEditor(null);setManualMember(null);setQuery('');setContactDone([]);
  if(!owner){reload.current=async()=>{};return;}
  let active=true,inflight=false;
  try{setSaved({ticket:owner.ticket,item:owner.session.saved().actions.at(-1)??null});}catch{setError('Saved team changes need review. Keep this browser’s records and copy them before making another change.');}
  const read=async()=>{
   if(!active||!valid(owner)||inflight||document.visibilityState==='hidden')return;inflight=true;
   try{
    const entries:StaffBoardEntry[]=[];let next:string|null=null,checked=0;
    for(let page=0;page<visiblePages.current;page++){
     const result=await owner.session.page(next,40,owner.signal);if(!active||!valid(owner))return;
     entries.push(...result.entries);next=result.next;checked=result.serverAt;if(!next)break;
    }
    if(new Set(entries.map(row=>row.staff.member.id)).size!==entries.length)throw Error('The team changed while reading. Check it again.');
    setBoard({ticket:owner.ticket,entries,next,checked,connected:true});
   }catch{if(active&&valid(owner))setBoard(previous=>previous?.ticket===owner.ticket?{...previous,connected:false}:{ticket:owner.ticket,entries:[],next:null,checked:0,connected:false});}
   finally{inflight=false;}
  };
  reload.current=read;void read();const timer=window.setInterval(()=>void read(),1500),wake=()=>void read();
  window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
 },[owner]);
 async function copy(text:string){const captured=owner;if(!captured||!valid(captured))return;setManual('');try{await navigator.clipboard.writeText(text);if(valid(captured))setNotice('Copied. You can record or send this by hand.');}catch{if(valid(captured)){setManual(text);setNotice('Select and copy the text below.');}}}
 async function work(run:(captured:StaffOwner)=>Promise<void>){
  if(!owner||running.current)return;const captured=owner;running.current=true;setBusy(true);setError('');setNotice('');
  try{await run(captured);}catch(e){if(valid(captured)){setError(e instanceof Error?e.message:'Keep the original change and try again.');throw e;}}
  finally{if(valid(captured)){try{setSaved({ticket:captured.ticket,item:captured.session.saved().actions.at(-1)??null});}catch{setError('The saved original could not be read. Keep this browser’s records.');}running.current=false;setBusy(false);}}
 }
 async function send(captured:StaffOwner,id:string,operation:'submit'|'inspect'|'close'){
  const result=await captured.session.call(id,operation,captured.signal);if(!valid(captured))return;
  setNotice(result.state==='applied'?'The original team change was recorded.':result.state==='closed'?'The unfinished original was closed without another change.':'The original is still unconfirmed. Keep it and check again.');
  if(result.state==='applied'||result.state==='closed')setEditor(null);await reload.current();
 }
 const safely=(run:()=>Promise<void>)=>{void run().catch(()=>{});};
 function edit(memberId:string){safely(()=>work(async captured=>{const context=await captured.session.read(memberId,captured.signal);if(valid(captured))setEditor({ticket:captured.ticket,context});}));}
 async function save(draft:StaffDraft){if(!editor||!owner||editor.ticket!==owner.ticket)return;await work(async captured=>{
  const action=await captured.session.prepare({kind:'save',draft},editor.context);if(!valid(captured))return;
  setSaved({ticket:captured.ticket,item:captured.session.saved().actions.at(-1)??null});await send(captured,action.id,'submit');
 });}
 function check(row:StaffBoardEntry,type:CheckInType){const occurredAt=Date.now();safely(()=>work(async captured=>{
  const context=await captured.session.read(row.staff.member.id,captured.signal);if(!valid(captured))return;
  if(!context.current||JSON.stringify(context.current)!==JSON.stringify(row.staff)||JSON.stringify(context.latest)!==JSON.stringify(row.latest))
   throw Error('This member’s record changed. Check the board before logging another tap.');
  const action=await captured.session.prepare({kind:'check-in',type,occurredAt},context);if(!valid(captured))return;
  setSaved({ticket:captured.ticket,item:captured.session.saved().actions.at(-1)??null});await send(captured,action.id,'submit');
 }));}
 const people=(visible?.entries??[]).filter(row=>row.staff.member.role!=='agent'),active=people.filter(row=>row.staff.member.active),inCount=active.filter(row=>row.latest?.type==='in').length;
 const manualRow=active.find(row=>row.staff.member.id===manualMember);
 const matches=(record:StaffRecord)=>[record.member.name,record.profile.nameLocal,record.member.phone??'',roles[record.member.role]].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
 return <section className="staff-team" aria-label="Team">
  <header className="staff-team-heading"><h1>Team</h1><Button kind="secondary" disabled={!owner||busy||unfinished} onClick={()=>edit(newInboxId())}><img src={asset+'plus.svg'} width="14" height="14" alt=""/> Add member</Button></header>
  <nav className="staff-team-tabs" aria-label="Team views"><NavLink to="/team" end>On duty</NavLink><NavLink to="/team/members">Members</NavLink></nav>
  <div className="staff-read-state"><p>{visible?.checked?`${visible.connected?'Checked':'Last checked'} ${time(visible.checked,setup.outlet.timezone)}`:'Connect to check the current team.'}</p><Button kind="secondary" disabled={checking||busy} onClick={()=>owner?safely(()=>reload.current()):refresh()}>Refresh team</Button></div>
  {accessError?<Card className="staff-empty"><p role="status">{accessError}</p><Link to="/settings/sync" className="button button-secondary">Open Sync setup</Link></Card>:null}
  {visible&&!visible.connected?<p role="status">The current board could not be checked. These earlier records do not confirm a new arrival or departure. Copy details or reconnect to log it.</p>:null}
  {original?<Card className="staff-original" aria-label="Saved team change"><h2>{unfinished?'Unconfirmed team change':'Saved team change'}</h2><p>{original.action.kind==='save'?`${original.action.draft?.name} · ${original.action.draft?.active?'member settings':'remove from team'}`:`${original.action.expected?.member.name} · ${original.action.checkIn?.type==='in'?'check-in':original.action.checkIn?.type==='break'?'break':'leaving'}`}</p><small>Original reference {original.action.id}</small>
   {original.closeRequested&&unfinished?<p>Closure is saved on this device. Keep this original until its outcome is checked.</p>:null}{original.outcome?.state==='applied'?<p>This original was recorded. The board shows the current presence.</p>:original.outcome?.state==='closed'?<p>This original was closed.</p>:null}
   <div className="staff-action-row"><Button kind="secondary" disabled={busy} onClick={()=>safely(()=>work(captured=>send(captured,original.action.id,'inspect')))}>Check saved change</Button>{unfinished&&!original.closeRequested?<Button kind="secondary" disabled={busy} onClick={()=>safely(()=>work(captured=>send(captured,original.action.id,'submit')))}>Retry saved change</Button>:null}{unfinished?<Button kind="secondary" disabled={busy} onClick={()=>safely(()=>work(captured=>send(captured,original.action.id,'close')))}>Close unfinished change</Button>:null}<Button kind="secondary" onClick={()=>void copy(original.action.draft?describeDraft(original.action.draft):`${original.action.expected?.member.name}\n${original.action.checkIn?.type}\n${new Date(original.action.checkIn!.occurredAt).toISOString()}\nTold the manager in person\nOriginal reference ${original.action.id}`)}>Copy original change</Button></div>
  </Card>:null}
  {members?<><div className="staff-member-filters"><label>Search members<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, role or phone"/></label><div className="staff-action-row"><Button kind={former?'secondary':'primary'} onClick={()=>setFormer(false)} aria-pressed={!former}>Active</Button><Button kind={former?'primary':'secondary'} onClick={()=>setFormer(true)} aria-pressed={former}>Former</Button></div></div>
   <Card className="staff-members-list">{people.filter(row=>row.staff.member.active!==former&&matches(row.staff)).map(row=><article className="staff-person" key={row.staff.member.id}><Avatar name={row.staff.member.name}/><div><h2>{row.staff.member.name}</h2><p>{roles[row.staff.member.role]}{row.staff.profile.station?` · ${row.staff.profile.station}`:''}</p><small>{row.staff.member.phone??'No contact number'}</small></div><Button kind="secondary" disabled={busy||unfinished||!visible?.connected} onClick={()=>edit(row.staff.member.id)}>Edit<span className="sr-only"> {row.staff.member.name}</span></Button></article>)}</Card><p>Former staff keep their original records and stop appearing on the on-duty board.</p>
  </>:<><div className="staff-board-count"><h2>On duty now</h2><span>{visible?.checked?(visible.next?`${inCount} in · ${active.length} shown`:`${inCount} of ${active.length}`):'Not checked'}</span></div>
  {inCount?<Card className="staff-in-list">{active.filter(row=>row.latest?.type==='in').map(row=><article key={row.staff.member.id} className="staff-presence-card staff-presence-row"><div className="staff-person"><Avatar name={row.staff.member.name}/><div><h2><button type="button" className="staff-person-open" onClick={()=>setManualMember(row.staff.member.id)}>{row.staff.member.name} <span>· {roles[row.staff.member.role]}</span></button></h2><p>Since {time(row.latest!.at,setup.outlet.timezone)} · {methods[row.latest!.method]}</p></div><StatusWord tone="positive">In</StatusWord></div></article>)}</Card>:null}
  <div className="staff-board-grid" ref={boardRef}>{active.filter(row=>row.latest?.type!=='in').map(row=>{
   const latest=row.latest,state=latest?.type??'out',expectation=usualShiftExpectation(row.staff.profile.shift,visible?.checked??Date.now(),setup.outlet.timezone),missing=state==='out'&&expectation.state==='due',reminder=row.staff.profile.language==='bn'?`${row.staff.profile.nameLocal||row.staff.member.name}, আপনি কি দোকানে পৌঁছেছেন? আপনার স্টাফ লিংকে জানান বা ম্যানেজারকে বলুন।`:`${row.staff.member.name}, have you arrived at ${setup.outlet.name}? Check in with your staff link or tell the manager.`;
   return <Card key={row.staff.member.id} className={'staff-presence-card'+(missing?' staff-presence-missing':'')}><div className="staff-person"><Avatar name={row.staff.member.name}/><div><h2>{row.staff.member.name} <span>· {roles[row.staff.member.role]}</span></h2><p>{latest?`Since ${time(latest.at,setup.outlet.timezone)} · ${methods[latest.method]}`:row.staff.profile.shift?`Expected ${shiftClock(row.staff.profile.shift.start)} · no check-in yet`:'No check-in recorded'}</p></div><StatusWord tone={state==='in'?'positive':missing?'warning':'neutral'}>{state==='in'?'In':state==='break'?'Break':missing?'Not in':'Out'}</StatusWord></div>
    <div className="staff-action-row">{state!=='in'?<Button kind="secondary" disabled={busy||unfinished||!visible?.connected} data-staff-manual="true" onClick={()=>check(row,'in')}><img src={asset+'check.svg'} width="14" height="14" alt=""/> Told me they’re here</Button>:<Button kind="secondary" disabled={busy||unfinished||!visible?.connected} data-staff-manual="true" onClick={()=>check(row,'break')}>Log a break</Button>}{state!=='out'?<Button kind="secondary" disabled={busy||unfinished||!visible?.connected} onClick={()=>check(row,'out')}>Log leaving</Button>:null}</div>
    {row.staff.member.phone?<div className="staff-contact"><div className="staff-action-row"><a className="button button-secondary" href={'tel:'+row.staff.member.phone}><img src={asset+'call.svg'} width="14" height="14" alt=""/> Call</a><Button kind="secondary" onClick={()=>void copy(row.staff.member.phone!)}>Copy number</Button>{row.staff.profile.whatsapp?<a className="button button-secondary" href={waLink(row.staff.member.phone,reminder)} target="_blank" rel="noopener noreferrer">Open WhatsApp</a>:null}<Button kind="secondary" onClick={()=>void copy(reminder)}>Copy reminder</Button><Button kind="secondary" onClick={()=>setContactDone(current=>[...new Set([...current,row.staff.member.id])])}>Mark done</Button></div>{contactDone.includes(row.staff.member.id)?<small>Contact step marked done on this page. Their check-in is unchanged.</small>:null}</div>:<Button kind="secondary" onClick={()=>void copy(`${row.staff.member.name}\n${roles[row.staff.member.role]}\n${reminder}`)}>Copy reminder</Button>}
   </Card>;
  })}</div><Card className="staff-manual-help"><h2>Told you in person?</h2><p>Log a check-in, break or departure for anyone above. It records method Manual and your name. Opening a message does not check anyone in.</p><Button kind="secondary" disabled={!active.length||busy||unfinished||!visible?.connected} onClick={()=>setManualMember(active[0]?.staff.member.id??null)}><img src={asset+'clock.svg'} width="14" height="14" alt=""/> Choose a member to log</Button></Card></>}
  {visible?.next?<Button kind="secondary" disabled={busy} onClick={()=>{visiblePages.current++;safely(()=>reload.current());}}>Show more members</Button>:null}
  {visible?.connected&&!people.length?<Card className="staff-empty"><h2>No team members yet</h2><p>Add a member and choose how they check in. A manager can always log it by hand.</p></Card>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}<p role="status">{notice}</p>{manual?<label className="staff-manual-copy">Text for manual copy<textarea ref={copyField} aria-label="Text for manual copy" readOnly rows={6} value={manual} onFocus={e=>e.target.select()}/></label>:null}
  {owner&&editor?.ticket===owner.ticket?<StaffMemberEditor key={editor.context.memberId} setup={setup} context={editor.context} owner={owner} busy={busy||unfinished} onSave={save} onCopy={draft=>void copy(describeDraft(draft))} onClose={()=>setEditor(null)}/>:null}
  {owner&&manualMember!==null?<Modal open title="Log attendance" closeLabel="Close attendance log" onClose={()=>setManualMember(null)} variant="sheet" className="staff-member-sheet" closeIcon={<img src={asset+'close.svg'} width="20" height="20" alt=""/>} focusTitle><div className="staff-manual-form">
   <label>Member<select aria-label="Member" value={manualMember} onChange={event=>setManualMember(event.target.value)}>{active.map(row=><option key={row.staff.member.id} value={row.staff.member.id}>{row.staff.member.name} · {roles[row.staff.member.role]}</option>)}</select></label>
   <p>This records “told the manager in person”, logged by {setup.owner.name}. It keeps the original time and member if the connection fails.</p>
   {manualRow?<><p>Current record: {manualRow.latest?.type==='in'?'In':manualRow.latest?.type==='break'?'Break':'Out'}{manualRow.latest?` · ${time(manualRow.latest.at,setup.outlet.timezone)}`:''}</p><div className="staff-action-row">{(['in','break','out'] as const).filter(type=>type!==(manualRow.latest?.type??'out')&&(type!=='break'||manualRow.latest?.type==='in')).map(type=><Button key={type} kind={type==='in'?'primary':'secondary'} disabled={busy||unfinished||!visible?.connected} onClick={()=>{check(manualRow,type);setManualMember(null);}}>{type==='in'?'Told me they’re here':type==='break'?'Log a break':'Log leaving'}</Button>)}</div></>:<p>This member is no longer in the current roster. Refresh the team before recording anything.</p>}
  </div></Modal>:null}
 </section>;
}
