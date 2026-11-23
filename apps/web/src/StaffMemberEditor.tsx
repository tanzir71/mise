import {useEffect,useRef,useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {Modal} from '@mise/ui/Modal.tsx';
import {Toggle} from '@mise/ui/Toggle.tsx';
import {normalisePhone} from '@mise/core/phone';
import {emptyStaffProfile,parseStaffDraft,staffMethods,type StaffDraft,type StaffMethod,type StaffPermissions,type UsualShift} from '@mise/core/staff';
import type {StaffOwnerContext} from '@mise/core/staff-protocol';
import type {SetupSnapshot} from '@mise/core/models';
import {staffDraftText,staffRoleNames as roleNames} from './staff-display';
import {StaffLinkControls} from './StaffLinkControls';
import type {StaffOwner} from './use-staff-owner';
const asset=import.meta.env.BASE_URL+'staff-assets/';
const days=[['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]] as const;
const clock=(minutes:number)=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
const minutes=(value:string)=>/^\d{2}:\d{2}$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;

export function StaffMemberEditor({setup,context,owner,busy,onSave,onCopy,onClose}:{setup:SetupSnapshot;context:StaffOwnerContext;owner:StaffOwner;busy:boolean;onSave:(draft:StaffDraft)=>Promise<void>;onCopy:(draft:StaffDraft)=>void;onClose:()=>void}){
 const [draft,setDraft]=useState<StaffDraft>(()=>context.current?{...context.current.profile,name:context.current.member.name,phone:context.current.member.phone??null,role:context.current.member.role,active:context.current.member.active}:
  {...emptyStaffProfile(),name:'',phone:null,role:'staff',active:true});
 const [error,setError]=useState(''),[manual,setManual]=useState(''),copyField=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{if(manual){copyField.current?.focus();copyField.current?.select();}},[manual]);
 const set=<K extends keyof StaffDraft>(key:K,value:StaffDraft[K])=>setDraft(current=>({...current,[key]:value}));
 const method=(key:StaffMethod,enabled:boolean)=>set('methods',staffMethods.filter(value=>value===key?enabled:draft.methods.includes(value)));
 const permission=(key:keyof StaffPermissions,enabled:boolean)=>set('permissions',{...draft.permissions,[key]:enabled});
 const shift=(change:Partial<UsualShift>)=>set('shift',{days:[],start:660,end:1140,...draft.shift,...change});
 async function save(value:StaffDraft){
  setError('');try{
   const phone=value.phone===null||value.phone===''?null:normalisePhone(value.phone,setup.business.marketCode);
   if(value.phone&&phone===null)throw Error('Enter the complete member phone number, including its country code.');
   await onSave(parseStaffDraft({...value,phone}));
  }catch(e){setError(e instanceof Error?e.message:'Keep the original change and try again.');}
 }
 const allowedRoles=context.current?.member.role==='owner'?['owner'] as const:context.actorRole==='owner'?['kitchen','staff','rider','manager'] as const:['kitchen','staff','rider'] as const;
 const wide=context.actorRole==='manager'&&Boolean(context.current&&(context.current.member.outletIds.some(id=>id!==context.outletId)||['owner','manager','agent'].includes(context.current.member.role)));
 return <Modal open title={context.current?'Edit member':'Add member'} closeLabel="Close member editor" onClose={onClose} variant="sheet" className="staff-member-sheet" focusTitle
  closeIcon={<img src={asset+'close.svg'} width="20" height="20" alt=""/>}>
  <p className="staff-editor-intro">Changes reach connected screens and this member’s staff link. Their recorded history is kept.</p>
  {wide?<p role="status">The owner manages this member’s wider access. You can copy your proposed change.</p>:null}
  <form onSubmit={e=>{e.preventDefault();void save(draft);}} className="staff-member-form">
   <fieldset disabled={busy||wide} className="staff-editor-fields">
    <label>Name<input autoComplete="name" value={draft.name} maxLength={80} onChange={e=>set('name',e.target.value)} required/></label>
    <label>Name in Bangla<input lang="bn" className="staff-bangla" value={draft.nameLocal} maxLength={160} onChange={e=>set('nameLocal',e.target.value)}/></label>
    <fieldset className="staff-role-choices"><legend>Role</legend>{allowedRoles.map(role=><label key={role} className={draft.role===role?'selected':''}><input type="radio" name="staff-role" value={role} checked={draft.role===role} onChange={()=>set('role',role)}/>{roleNames[role]}</label>)}</fieldset>
    <label>Station<input value={draft.station} maxLength={60} onChange={e=>set('station',e.target.value)} placeholder="For example, kitchen or order desk"/></label>
    <label>Phone for contact and reminders<input type="tel" autoComplete="tel" value={draft.phone??''} onChange={e=>set('phone',e.target.value||null)}/></label>
    <div className="staff-switch-row"><span>WhatsApp on the same number<small>For reminders and sharing the staff link</small></span><Toggle label="WhatsApp on the same number" checked={draft.whatsapp} onChange={value=>set('whatsapp',value)}/></div>
    <p className="staff-editor-note">Phone contact and staff links do not create a sign-in account. Shared-screen access uses an enrolled device and staff PIN.</p>
    <fieldset className="staff-language-choices"><legend>Messages in</legend>{(['en','bn'] as const).map(language=><label key={language} className={draft.language===language?'selected':''}><input type="radio" name="staff-language" value={language} checked={draft.language===language} onChange={()=>set('language',language)}/><span lang={language}>{language==='en'?'English':'বাংলা'}</span></label>)}</fieldset>
    <section className="staff-editor-card" aria-label="Usual shift"><div className="staff-switch-row"><span>Usual shift<small>Expected time; it does not check anyone in</small></span><Toggle label="Set a usual shift" checked={draft.shift!==null} onChange={value=>set('shift',value?{days:[],start:660,end:1140}:null)}/></div>
     {draft.shift?<><fieldset className="staff-day-choices"><legend>Shift days</legend>{days.map(([name,day])=><label key={day} className={draft.shift!.days.includes(day)?'selected':''}><input type="checkbox" checked={draft.shift!.days.includes(day)} onChange={e=>shift({days:e.target.checked?[...draft.shift!.days,day].sort((a,b)=>a-b):draft.shift!.days.filter(value=>value!==day)})}/>{name}</label>)}</fieldset>
      <div className="staff-shift-times"><label>Start<input type="time" required value={Number.isFinite(draft.shift.start)?clock(draft.shift.start):''} onChange={e=>shift({start:minutes(e.target.value)})}/></label><label>End<input type="time" required value={Number.isFinite(draft.shift.end)?clock(draft.shift.end):''} onChange={e=>shift({end:minutes(e.target.value)})}/></label></div><small>{setup.outlet.timezone}{draft.shift.end<draft.shift.start?' · Ends the following day':''}</small></>:null}
    </section>
    <section className="staff-editor-card" aria-label="Check-in methods"><h3>How this member checks in</h3>
     <div className="staff-switch-row"><span>Tap on the order phone</span><Toggle label="Tap on the order phone" checked={draft.methods.includes('order_phone')} onChange={value=>method('order_phone',value)}/></div>
     <div className="staff-switch-row"><span>Their own staff link</span><Toggle label="Their own staff link" checked={draft.methods.includes('link')} onChange={value=>method('link',value)}/></div>
     <div className="staff-switch-row"><span>Message in the staff group<small>Requires the shop’s connected group capture</small></span><Toggle label="Message in the staff group" disabled={!draft.methods.includes('group')} checked={draft.methods.includes('group')} onChange={value=>method('group',value)}/></div>
     <p className="staff-editor-note">A manager can always log “told me in person” with their own name recorded.</p>
    </section>
    <section className="staff-editor-card" aria-label="Staff permissions"><h3>What this member can do</h3>{([['confirmOrders','Confirm orders'],['updateStock','Update stock'],['viewOwnPerformance','See their own performance']] as const).map(([key,label])=><div className="staff-switch-row" key={key}><span>{label}</span><Toggle label={label} checked={draft.permissions[key]} onChange={value=>permission(key,value)}/></div>)}<p className="staff-editor-note">These choices do not grant owner or manager sign-in.</p></section>
   </fieldset>
   {error?<p role="alert" className="form-error">{error}</p>:null}
   <div className="staff-editor-actions"><Button type="submit" disabled={busy||wide}><img src={asset+'check-inverse.svg'} width="16" height="16" alt=""/> Save changes</Button><Button type="button" kind="secondary" onClick={()=>{setManual(staffDraftText(draft));onCopy(draft);}}>Copy proposed change</Button>
    {context.current?.member.role!=='owner'&&context.current?.member.id!==context.actorId&&context.current?.member.active?<Button type="button" kind="ghost" disabled={busy||wide} onClick={()=>void save({...draft,active:false})}>Remove from team</Button>:null}
    {context.current&&!context.current.member.active?<Button type="button" kind="secondary" disabled={busy||wide} onClick={()=>void save({...draft,active:true})}>Restore to team</Button>:null}
   </div>
   {manual?<label className="staff-manual-copy">Proposed change for manual copy<textarea ref={copyField} aria-label="Proposed change for manual copy" readOnly rows={6} value={manual} onFocus={e=>e.target.select()}/></label>:null}
  </form>
  {context.current?<StaffLinkControls owner={owner} memberId={context.memberId} disabled={busy||wide}/>:null}
 </Modal>;
}
