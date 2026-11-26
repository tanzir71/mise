import {useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {MiseIcon} from '@mise/ui/MiseIcon.tsx';
import {defaultMarket} from '@mise/core/packs';
import {backupTableNames} from '@mise/core/backup-tables';
import {cloudConnectionStorageKey,readCloudConnection,saveCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseScopeRecoverySession} from '@mise/core/scope-recovery';
import {ConnectionForm,PhoneSignIn} from './CloudAuthForms';
import {db} from './data/db';
import {getPhoneAuth,forgetPhoneAuth,type PhoneAuth,type PhoneAuthState} from './data/phone-auth';
import {scopeRecoveryAuthScope,reviewScopeRecovery,applyReviewedScopeRecovery,activateScopeRecovery,pauseScopeRecovery,continueRecoveryOffline,scopeRecoveryProblem,type ScopeRecoveryOptions} from './data/cloud-scope-recovery';
import {readCanonicalState} from './data/cloud-canonical-state';
import type {ScopeRecoveryReview} from './data/cloud-scope-apply';
import {backupFile,downloadFile} from './data/export-files';
import './cloud-setup.css';

const initialAuth:PhoneAuthState={phase:'checking',phone:null,userId:null,message:'',busy:false,resendAt:0,persistent:true};
const labels:Record<string,string>={businesses:'Businesses',outlets:'Outlets',members:'Members',categories:'Categories',items:'Items',events:'History',sales:'Sales',customers:'Customers',creditAccounts:'Credit accounts',creditEntries:'Credit history',orders:'Orders',orderNotes:'Order notes',orderCommunications:'Order messages',orderRefunds:'Order refunds',stockItems:'Stock items',stockMoves:'Stock history',suppliers:'Suppliers',supplierMessages:'Supplier messages',dayClosings:'Day closings',purchases:'Purchases',inboxItems:'Inbox sources'};
const messages={auth:'Verify the original phone account and connection for this outlet.',retry:'This step is unconfirmed. Your saved shop and downloaded changes are kept.',review:'Access or saved work changed. Review the current records again before continuing.',integrity:'The saved recovery evidence needs review. Keep your original shop copy and backup.'};

/** Shared by the normal sync controls and the locked-operator recovery screen. */
export function CloudRecovery({onBack,onRecovered}:{onBack?:()=>void;onRecovered?:()=>void}){
 const [config,setConfig]=useState<CloudConnection|null>(null),[loaded,setLoaded]=useState(false),[editing,setEditing]=useState(false),[manager,setManager]=useState<PhoneAuth|null>(null),[auth,setAuth]=useState(initialAuth),[online,setOnline]=useState(navigator.onLine),[working,setWorking]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[review,setReview]=useState<ScopeRecoveryReview|null>(null);
 const [authVersion,setAuthVersion]=useState(0);
 const mounted=useRef(false),task=useRef<AbortController|null>(null),base=import.meta.env.BASE_URL;
 const view=useLiveQuery(async()=>{
  const raw=await db.scopeRecoveries.get('active'),session=raw?parseScopeRecoverySession(raw):null,binding=await db.cloudState.get('binding');
  const [business,outlet,read,images]=await Promise.all([binding?db.businesses.get(binding.businessId):undefined,binding?db.outlets.get(binding.outletId):undefined,session?db.syncReads.get(session.readId):undefined,session?db.syncImages.where('readId').equals(session.readId).count():0]);
  return {session,binding,business,outlet,read,images};
 });
 const session=view?.session,busy=working!==null||auth.busy,verified=auth.phase==='signed-in',admitted=session?.phase==='admitted',businessId=view?.binding?.businessId;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;task.current?.abort();};},[]);
 useEffect(()=>{
  const read=()=>{try{setConfig(readCloudConnection(localStorage));}catch{setError(messages.auth);}setLoaded(true);};
  const storage=(event:StorageEvent)=>{if(event.key===null||event.key===cloudConnectionStorageKey){task.current?.abort();setReview(null);read();}};
  const network=()=>{setOnline(navigator.onLine);if(!navigator.onLine)task.current?.abort();};
  read();window.addEventListener('storage',storage);window.addEventListener('online',network);window.addEventListener('offline',network);
  return()=>{window.removeEventListener('storage',storage);window.removeEventListener('online',network);window.removeEventListener('offline',network);};
 },[]);
 useEffect(()=>{
  let current=true,unsubscribe:(()=>void)|undefined;setManager(null);setAuth(initialAuth);
  if(config&&businessId)void scopeRecoveryAuthScope(db,config,base).then(scope=>getPhoneAuth(config,scope)).then(value=>{
   if(!current)return;setManager(value);const update=()=>{if(!current)return;const state=value.getSnapshot();setAuth(state);if(['signed-out','offline','closed'].includes(state.phase)){task.current?.abort();setReview(null);}};update();unsubscribe=value.subscribe(update);
  }).catch(()=>{if(current)setError(messages.auth);});
  return()=>{current=false;unsubscribe?.();};
 },[config,businessId,base,authVersion]);
 function options():ScopeRecoveryOptions {
  if(!config||!manager)throw Error('Verify the original connection.');const original=config;
  return {config:original,base,auth:manager,connectionCurrent:()=>{try{return JSON.stringify(readCloudConnection(localStorage))===JSON.stringify(original);}catch{return false;}}};
 }
 async function run(name:string,action:(signal:AbortSignal)=>Promise<void>){
  if(task.current)return;const controller=new AbortController();task.current=controller;setWorking(name);setError('');setNotice('');
  try{await action(controller.signal);}catch(problem){if(mounted.current){setReview(null);setError(controller.signal.aborted?'Transfer stopped. Your saved shop and downloaded changes are kept.':messages[scopeRecoveryProblem(problem)]);}}
  finally{if(task.current===controller)task.current=null;if(mounted.current)setWorking(null);}
 }
 function check(forceNew=false){setReview(null);void run('review',async signal=>{const next=await reviewScopeRecovery(db,options(),forceNew,signal);if(mounted.current)setReview(next);});}
 function apply(){if(!review)return;void run('apply',async signal=>{await applyReviewedScopeRecovery(db,review,options(),signal);if(mounted.current){setNotice('The connection is restored. Saved actions will sync with this outlet.');onRecovered?.();}});}
 function resume(){void run('activate',async signal=>{await activateScopeRecovery(db,options(),signal);if(mounted.current)onRecovered?.();});}
 async function pause(cancel=false){task.current?.abort();try{await pauseScopeRecovery(db,cancel);if(mounted.current){setReview(null);setNotice(cancel?'Review cancelled. Your saved shop and download are kept.':'Review paused. You can resume the saved download.');}}catch{if(mounted.current)setError(messages.review);}}
 function offline(){void run('offline',async()=>{await continueRecoveryOffline(db);if(mounted.current)onRecovered?.();});}
 function backup(original=false){void run('backup',async()=>{const canonical=original?await readCanonicalState(db):null,copy=canonical?.recoveries[0]?.admission.source.working??(await db.readCompleteBackup()).portable;downloadFile(backupFile(copy));if(mounted.current)setNotice(original?'The original saved shop copy is ready to keep.':'Your complete saved shop backup is ready.');});}
 async function save(value:CloudConnection){try{const saved=saveCloudConnection(localStorage,value);setConfig(saved);setEditing(false);setReview(null);setError('');}catch{setError('Check the project URL and publishable key. Your saved shop is kept.');}}
 const status=working==='review'?'Checking access and downloading current records…':working==='apply'?'Applying reviewed changes…':working==='activate'?'Resuming sync…':admitted?'The reviewed records are saved. Resume sync or continue offline.':session?.phase==='paused'?'Review paused. Your shop and download are kept.':session?.phase==='ready'?'The reviewed connection is saved.':view?.read?`${view.read.pages} downloaded pages · ${view.images} original images verified`:'Check the current access for this outlet before applying changes.';
 return <section className="cloud-setup cloud-recovery" aria-labelledby="scope-recovery-title">
  <Card className="app-panel">
   <header><MiseIcon name="link" size={20}/><h2 id="scope-recovery-title">Review this outlet’s access</h2></header>
   <p>Your saved shop stays here while you check the connection. A complete original copy is kept when reviewed changes are applied.</p>
   {view?.outlet?<p>{view.business?.name}{view.outlet.name!==view.business?.name?' · '+view.outlet.name:''}</p>:null}
   <p role="status" aria-live="polite">{status}</p>
   {!loaded?<p aria-busy="true">Reading this device’s connection…</p>:!config||editing?<ConnectionForm config={config} saving={busy} onSave={save} onCancel={config?()=>setEditing(false):undefined}/>:<>
    <p className="cloud-preview-note">Use the original phone account for this outlet. Connection settings stay on this device.</p>
    {manager?<PhoneSignIn manager={manager} state={auth} market={view?.business?.marketCode??defaultMarket(Intl.DateTimeFormat().resolvedOptions().timeZone)} online={online} saving={busy} onSignOut={async()=>{setReview(null);await run('sign-out',async()=>{await forgetPhoneAuth();if(mounted.current)setAuthVersion(value=>value+1);});}}/>:<p aria-busy="true">Checking the original phone sign-in…</p>}
    <Button kind="ghost" disabled={busy} onClick={()=>setEditing(true)}>Review connection settings</Button>
   </>}
   {review?<>
    <h3>Saved here → After review</h3>
    <dl className="cloud-review-counts">{backupTableNames.map(table=><div key={table}><dt>{labels[table]}</dt><dd>{review.before[table].toLocaleString('en')} → {review.after[table].toLocaleString('en')}</dd></div>)}</dl>
    <p>{review.pending} saved {review.pending===1?'action stays':'actions stay'} pending until confirmed by this outlet. History and complete original images are kept.</p>
   </>:null}
   {error?<p role="alert" className="form-error">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
   <footer>
    {admitted?<><Button disabled={busy||!online||!verified} onClick={resume}>Resume sync</Button><Button kind="secondary" disabled={busy} onClick={offline}>Continue offline</Button></>:review?<><Button disabled={busy||!online||!verified} onClick={apply}>Apply reviewed changes</Button><Button kind="secondary" disabled={busy||!online||!verified} onClick={()=>check()}>Review current records again</Button></>:<Button disabled={busy||!online||!verified||!config} onClick={()=>check(session?.phase==='ready'||session?.phase==='cancelled')}>{session&&['pending','paused'].includes(session.phase)?'Resume review':'Check current access'}</Button>}
    {working==='review'?<Button kind="secondary" onClick={()=>void pause()}>Stop download</Button>:null}
    {session&&['pending','paused'].includes(session.phase)&&!busy?<><Button kind="ghost" onClick={()=>check(true)} disabled={!online||!verified}>Start a fresh review</Button><Button kind="ghost" onClick={()=>void pause(true)}>Cancel review</Button></>:null}
    {onBack&&!admitted?<Button kind="secondary" disabled={busy} onClick={onBack}>Back to the shop</Button>:null}
   </footer>
  </Card>
  <div className="cloud-backup-link"><Button kind="ghost" disabled={busy} onClick={()=>backup()}>Download saved shop backup</Button>{view?.binding?.recovery?<Button kind="ghost" disabled={busy} onClick={()=>backup(true)}>Download original shop copy</Button>:null}</div>
 </section>;
}
