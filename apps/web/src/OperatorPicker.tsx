import {useRef,useState} from 'react';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {db} from './data/db';
import {selectLocalOperator,type LocalWorkspace} from './data/operator-state';
import {BackupTools} from './BackupTools';
import {useNavigate} from 'react-router-dom';
import './operator-picker.css';

/** Local recovery selection is not cloud authentication or a membership change. */
export function OperatorPicker({workspace,onChoose,onBack,recoveryEnabled=false}:{workspace:LocalWorkspace;onChoose?:()=>void;onBack?:()=>void;recoveryEnabled?:boolean}){
 const [chosen,setChosen]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState(''),busy=useRef(false);
 const navigate=useNavigate();
 const key=(c:{businessId:string;outletId:string;actorId:string})=>[c.businessId,c.outletId,c.actorId].join('/'),choice=workspace.choices.find(c=>key(c)===chosen);
 async function choose(){if(!choice||busy.current)return;busy.current=true;setSaving(true);setError('');try{await selectLocalOperator(db,choice,workspace.selection?.revision??null);onChoose?.();}catch(e){setError(e instanceof Error?e.message:'This operator could not be selected. Keep local work and try again.');}finally{busy.current=false;setSaving(false);}}
 return <main className="onboarding operator-picker"><Card className="onboarding-card"><h1>Choose an outlet and member</h1><p>{workspace.message||'Choose who is working on this device. Recorded actions keep that member’s name.'}</p>{workspace.cloudBound?<p>Use the verified cloud connection to review this operator. Local records and unsent work are kept.</p>:<form onSubmit={e=>{e.preventDefault();void choose();}}><fieldset disabled={saving}><legend>Available on this device</legend>{workspace.choices.map(c=><label className="operator-choice" key={key(c)}><input type="radio" name="operator" value={key(c)} checked={chosen===key(c)} onChange={()=>{setChosen(key(c));setError('');}}/><span><strong>{c.outletName}</strong><span>{c.businessName}</span><small>{c.actorName} · {c.role==='owner'?'Owner':'Manager'}</small></span></label>)}{!workspace.choices.length?<p>No active owner or assigned manager is saved for these outlets.</p>:null}</fieldset>{error?<p role="alert" className="form-error">{error}</p>:null}<Button type="submit" disabled={!choice||saving}>{saving?'Opening…':'Continue on this device'}</Button></form>}{workspace.cloudBound&&workspace.canRecover&&recoveryEnabled?<Button kind="secondary" onClick={()=>navigate('/settings/recovery')}>Review cloud access</Button>:null}{onBack?<Button kind="secondary" onClick={onBack} disabled={saving}>Back to the shop</Button>:null}<details><summary>Backup and recovery</summary><p>You can keep a JSON backup of the saved shop records.</p><BackupTools recovery/></details></Card></main>;
}
