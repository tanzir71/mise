import {useEffect,useRef,useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {staffViewerUrl,type StaffLinkContext,type StaffLinkMeta} from '@mise/core/staff-links';
import type {StaffOwner} from './use-staff-owner';
import type {SavedStaffLinkAction} from './data/staff-link-admin-session';

export function StaffLinkControls({owner,memberId,disabled}:{owner:StaffOwner;memberId:string;disabled:boolean}){
 const session=owner.links(memberId),[context,setContext]=useState<StaffLinkContext|null>(null),[after,setAfter]=useState<string|null>(null),[original,setOriginal]=useState<SavedStaffLinkAction|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[manual,setManual]=useState('');
 const mounted=useRef(true),running=useRef(false),copyField=useRef<HTMLTextAreaElement>(null);
 const current=()=>mounted.current&&owner.active()&&!owner.signal.aborted;
 const refresh=async(cursor=after)=>{const value=await session.read(cursor,owner.signal);if(current()){setContext(value);setAfter(cursor);}};
 useEffect(()=>{mounted.current=true;void(async()=>{try{setOriginal(session.saved().actions.at(-1)??null);await refresh(null);}catch{if(current())setError('Refresh link access with this installation’s original account.');}})();return()=>{mounted.current=false;};},[session]);
 useEffect(()=>{if(manual){copyField.current?.focus();copyField.current?.select();}},[manual]);
 async function work(run:()=>Promise<void>){if(running.current||!current())return;running.current=true;setBusy(true);setError('');setNotice('');setManual('');
  try{await run();}catch{if(current())setError('Keep the saved original. Check its result or close it before creating another link.');}
  finally{if(current()){try{setOriginal(session.saved().actions.at(-1)??null);}catch{setError('The saved link could not be read. Keep this browser’s data and copy the proposed member change.');}setBusy(false);}running.current=false;}
 }
 async function call(id:string,operation:'submit'|'inspect'|'close'){
  const outcome=await session.call(id,operation,owner.signal);if(!current())return;
  setNotice(outcome.state==='applied'?'This original change was recorded. The current link status is shown below.':outcome.state==='closed'?'This unfinished change was closed.':'This change is unconfirmed. Keep the original and check again.');
  await refresh();
 }
 async function change(kind:'issue'|'revoke',linkId?:string){await work(async()=>{
  const fresh=await session.read(after,owner.signal);if(!current())return;setContext(fresh);
  const action=await session.prepare(kind,fresh,{days:30,linkId});if(!current())return;setOriginal(session.saved().actions.at(-1)??null);await call(action.id,'submit');
 });}
 async function copy(link:StaffLinkMeta){await work(async()=>{
  const fresh=await session.read(after,owner.signal);if(!current())return;setContext(fresh);
  const found=fresh.links.find(row=>row.id===link.id),member=fresh.current;
  if(!found||found.revokedAt!==null||found.expiresAt<=fresh.serverAt||!member?.member.active||!member.profile.methods.includes('link')){setNotice('This link is not currently available.');return;}
  const token=await session.originalToken(link.id);await session.assertCurrent();if(!current())return;
  const url=staffViewerUrl(location.origin,import.meta.env.BASE_URL,{v:1,apiUrl:owner.apiUrl,token});
  try{await navigator.clipboard.writeText(url);await session.assertCurrent();if(current())setNotice('Staff link copied. Share it privately with this member.');}
  catch{await session.assertCurrent();if(current()){setManual(url);setNotice('Select and copy this staff link. Share it privately with this member.');}}
 });}
 const unfinished=Boolean(original&&(!original.outcome||original.outcome.state==='pending')),allowed=Boolean(context?.current?.member.active&&context.current.member.role!=='agent'&&context.current.profile.methods.includes('link'));
 return <section className="staff-editor-card staff-link-controls" aria-label="Staff links"><h3>Staff link</h3>
  <p className="staff-editor-note">Only this member’s shift and attendance. This installation supplies its own backend and enables its staff link service. A link does not create a sign-in account.</p>
  {!allowed?<p className="staff-editor-note">Save an active member with “Their own staff link” enabled first, then reopen this editor.</p>:null}
  <div className="staff-action-row"><Button type="button" kind="secondary" disabled={busy||disabled||unfinished||!allowed} onClick={()=>void change('issue')}>Create 30-day link</Button><Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>refresh())}>Refresh links</Button></div>
  {original?<div className="staff-link-original" aria-label="Saved staff link change"><p>{unfinished?'Unconfirmed staff link change':original.outcome?.state==='closed'?'This original was closed.':'This original was recorded.'}</p><small>Original reference: {original.action.id}</small><div className="staff-action-row">
   <Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>call(original.action.id,'inspect'))}>Check saved link change</Button>
   {unfinished&&!original.closeRequested?<Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>call(original.action.id,'submit'))}>Retry saved link change</Button>:null}
   {unfinished?<Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>call(original.action.id,'close'))}>Close unfinished link change</Button>:null}
  </div></div>:null}
  {context?<><ul className="staff-link-list">{context.links.map(link=>{
   const state=link.revokedAt!==null?'Revoked':link.expiresAt<=context.serverAt?'Expired':!allowed?'Unavailable':'Active';
   return <li key={link.id}><div><strong>{state}</strong><small>Created {new Date(link.createdAt).toLocaleDateString()} · expires {new Date(link.expiresAt).toLocaleDateString()}</small><small>Reference: {link.id}</small></div><div className="staff-action-row">
    {state==='Active'?<Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void copy(link)}>Copy staff link</Button>:null}
    {link.revokedAt===null?<Button type="button" kind="secondary" disabled={busy||disabled||unfinished} onClick={()=>void change('revoke',link.id)}>Revoke link</Button>:null}
   </div></li>;
  })}</ul>{!context.links.length?<p className="staff-editor-note">No links on this page.</p>:null}<div className="staff-action-row">{after?<Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>refresh(null))}>First links</Button>:null}{context.next?<Button type="button" kind="secondary" disabled={busy||disabled} onClick={()=>void work(()=>refresh(context.next))}>Next links</Button>:null}</div></>:null}
  <p className="staff-editor-note">The secret link stays in the browser that created it. On another device, revoke the old link and create one here.</p>
  {error?<p role="alert">{error}</p>:null}<p role="status">{notice}</p>
  {manual?<label className="staff-manual-copy">Staff link for manual copy<textarea ref={copyField} aria-label="Staff link for manual copy" value={manual} readOnly rows={4} onFocus={e=>e.target.select()}/></label>:null}
 </section>;
}
