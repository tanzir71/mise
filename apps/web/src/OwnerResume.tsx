import {useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {MiseIcon} from '@mise/ui/MiseIcon.tsx';
import {defaultMarket} from '@mise/core/packs';
import {cloudConnectionStorageKey,readCloudConnection,saveCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseOwnerResumeSession} from '@mise/core/owner-resume';
import {readCloudUpload} from '@mise/core/cloud-upload';
import {ConnectionForm,PhoneSignIn} from './CloudAuthForms';
import {db} from './data/db';
import {getPhoneAuth,forgetPhoneAuth,type PhoneAuth,type PhoneAuthState} from './data/phone-auth';
import {CloudUploadJournal} from './data/cloud-upload';
import {ownerResumeAuthScope,resumeOriginalOwner,cancelOwnerResume,ownerResumeProblem} from './data/owner-resume';
import {backupFile,downloadFile} from './data/export-files';
import './cloud-setup.css';

const emptyAuth:PhoneAuthState={phase:'checking',phone:null,userId:null,message:'',busy:false,resendAt:0,persistent:true};
const messages={auth:'Verify the original phone account and connection for this shop.',retry:'This step is unconfirmed. Your shop and original upload are kept.',review:'Your access or saved work changed. Keep your backup and check the original connection again.',integrity:'The original saved upload needs review. Keep your shop backup; no replacement upload has been started.'};
export function OwnerResume({onBack,onRestored}:{onBack:()=>void;onRestored:()=>void}){
 const [config,setConfig]=useState<CloudConnection|null>(null),[loaded,setLoaded]=useState(false),[editing,setEditing]=useState(false),[manager,setManager]=useState<PhoneAuth|null>(null),[auth,setAuth]=useState(emptyAuth),[authVersion,setAuthVersion]=useState(0),[online,setOnline]=useState(navigator.onLine),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const base=import.meta.env.BASE_URL,mounted=useRef(false),task=useRef<AbortController|null>(null);
 const view=useLiveQuery(async()=>{const binding=await db.cloudState.get('binding'),raw=await db.scopeRecoveries.get('owner:active'),session=raw?parseOwnerResumeSession(raw):null;const [business,hasBase]=await Promise.all([binding?db.businesses.get(binding.businessId):undefined,db.syncCanonical.where('id').equals('active').count()]);return {binding,session,business,hasBase:hasBase>0};});
 const businessId=view?.binding?.businessId,verified=auth.phase==='signed-in',working=busy||auth.busy,complete=!!view?.hasBase&&view.session?.phase!=='pending';
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;task.current?.abort();};},[]);
 useEffect(()=>{
  const read=()=>{try{setConfig(readCloudConnection(localStorage));}catch{setError(messages.auth);}setLoaded(true);};
  const storage=(event:StorageEvent)=>{if(event.key===null||event.key===cloudConnectionStorageKey){task.current?.abort();read();}};
  const network=()=>{setOnline(navigator.onLine);if(!navigator.onLine)task.current?.abort();};read();window.addEventListener('storage',storage);window.addEventListener('online',network);window.addEventListener('offline',network);
  return()=>{window.removeEventListener('storage',storage);window.removeEventListener('online',network);window.removeEventListener('offline',network);};
 },[]);
 useEffect(()=>{let current=true,unsubscribe:(()=>void)|undefined;setManager(null);setAuth(emptyAuth);
  if(config&&businessId)void ownerResumeAuthScope(db,config,base).then(scope=>getPhoneAuth(config,scope)).then(value=>{if(!current)return;setManager(value);const update=()=>{if(!current)return;const next=value.getSnapshot();setAuth(next);if(['signed-out','offline','closed'].includes(next.phase))task.current?.abort();};update();unsubscribe=value.subscribe(update);}).catch(()=>{if(current)setError(messages.auth);});
  return()=>{current=false;unsubscribe?.();};
 },[config,businessId,base,authVersion]);
 async function run(action:(signal:AbortSignal)=>Promise<void>){if(task.current)return;const controller=new AbortController();task.current=controller;setBusy(true);setError('');setNotice('');
  try{await action(controller.signal);}catch(problem){if(mounted.current)setError(controller.signal.aborted?'Restore stopped. Your shop and original upload are kept.':messages[ownerResumeProblem(problem)]);}
  finally{if(task.current===controller)task.current=null;if(mounted.current)setBusy(false);}
 }
 function restore(){void run(async signal=>{if(!config||!manager)throw Error('Verify the original connection.');const original=config,journal=new CloudUploadJournal('mise-cloud-uploads:'+base);
  try{await resumeOriginalOwner(db,{config:original,base,auth:manager,journal,connectionCurrent:()=>{try{return JSON.stringify(readCloudConnection(localStorage))===JSON.stringify(original);}catch{return false;}}},view?.session?.phase!=='pending',signal);if(mounted.current)onRestored();}finally{journal.close();}
 });}
 function backup(original=false){void run(async()=>{const journal=new CloudUploadJournal('mise-cloud-uploads:'+base);try{const copy=original&&view?.binding?await readCloudUpload(await journal.readSnapshot(view.binding.uploadId)):(await db.readCompleteBackup()).portable;downloadFile(backupFile(copy));if(mounted.current)setNotice(original?'The original upload copy is ready to keep.':'Your complete saved shop backup is ready.');}finally{journal.close();}});}
 async function cancel(){task.current?.abort();try{await cancelOwnerResume(db);if(mounted.current)setNotice('Restore cancelled. Your shop and original upload are kept.');}catch{if(mounted.current)setError(messages.review);}}
 async function back(){try{if(view?.session?.phase==='pending')await cancelOwnerResume(db);if(mounted.current)onBack();}catch{if(mounted.current)setError(messages.review);}}
 async function save(value:CloudConnection){try{setConfig(saveCloudConnection(localStorage,value));setEditing(false);setError('');}catch{setError(messages.auth);}}
 return <section className="cloud-setup cloud-owner-resume" aria-labelledby="owner-resume-title">
  <Card className="app-panel"><header><MiseIcon name="link" size={20}/><h2 id="owner-resume-title">Restore the original connection</h2></header>
   <p>The original upload is saved. Use the same phone account to reconnect this shop. Your saved records and unsent work stay here.</p>
   {view?.business?<p>{view.business.name}</p>:null}
   <p role="status">{busy?'Checking the original connection…':complete?'This shop already has current records. Return to the shop to review sync.':view?.session?.phase==='pending'?'Restore is unfinished. Verify the original account to resume.':'The original upload will be checked before sync resumes.'}</p>
   {!loaded?<p aria-busy="true">Reading this device’s connection…</p>:!config||editing?<ConnectionForm config={config} saving={working} onSave={save} onCancel={config?()=>setEditing(false):undefined}/>:<>
    {manager?<PhoneSignIn manager={manager} state={auth} market={view?.business?.marketCode??defaultMarket(Intl.DateTimeFormat().resolvedOptions().timeZone)} online={online} saving={working} onSignOut={async()=>{await run(async()=>{await forgetPhoneAuth();if(mounted.current)setAuthVersion(value=>value+1);});}}/>:<p aria-busy="true">Checking the original phone sign-in…</p>}
    <Button kind="ghost" disabled={working} onClick={()=>setEditing(true)}>Review connection settings</Button>
   </>}
   {error?<p role="alert" className="form-error">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
   <footer>{!complete?<Button disabled={working||!online||!verified||!config} onClick={restore}>{view?.session?.phase==='pending'?'Resume original connection':'Restore original connection'}</Button>:null}
    {busy?<Button kind="secondary" onClick={()=>task.current?.abort()}>Stop restore</Button>:null}
    {view?.session?.phase==='pending'&&!working?<Button kind="ghost" onClick={()=>void cancel()}>Cancel restore</Button>:null}
    <Button kind="secondary" disabled={working} onClick={()=>void back()}>Back to the shop</Button>
   </footer>
  </Card>
  <div className="cloud-backup-link"><Button kind="ghost" disabled={working} onClick={()=>backup()}>Download saved shop backup</Button><Button kind="ghost" disabled={working} onClick={()=>backup(true)}>Download original upload copy</Button></div>
 </section>;
}
