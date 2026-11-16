import { useEffect,useRef,useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { handoffTemplateToken,type HandoffCompletion,type HandoffDraft,type HandoffSession } from '@mise/core/handoff';
import type { HandoffChoice } from '@mise/core/handoff-progress';
import { db } from './data/db';
import { errorText } from './khata-data';
import './handoff.css';

interface Props {draft:HandoffDraft;completion?:HandoffCompletion;onComplete:(fresh:boolean)=>void|Promise<void>;onSkip?:()=>void;confirmLabel?:string;doneLabel?:string;previewLabel?:string;readOnly?:boolean}
export function HandOff(props:Props){return <HandoffEditor key={JSON.stringify([handoffTemplateToken(props.draft),Boolean(props.readOnly)])} {...props} />;}
function HandoffEditor({draft,completion,onComplete,onSkip,confirmLabel='I sent it',doneLabel='Done',previewLabel='Message preview',readOnly=false}:Props){
  const [input]=useState(()=>({...draft,template:draft.template??draft.text})),[text,setText]=useState(input.text),[state,setState]=useState<HandoffSession>(),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[manual,setManual]=useState(false),[error,setError]=useState('');
  const mounted=useRef(false),currentText=useRef(text),currentState=useRef<HandoffSession>(),queue=useRef<Promise<unknown>>(Promise.resolve()),locked=useRef(false),callbacks=useRef({completion,onComplete});
  const pendingKey=`mise.handoff.pending:${import.meta.env.BASE_URL}:${handoffTemplateToken(input)}`;
  callbacks.current={completion,onComplete};
  function serial<T>(task:()=>Promise<T>):Promise<T>{const next=queue.current.then(task);queue.current=next.catch(()=>{});return next;}
  function publish(next:HandoffSession,snapshot:string){currentState.current=next;if(mounted.current&&currentText.current===snapshot)setState(next);}
  async function save(snapshot:string,fresh=false){const next=await db.prepareHandoff({...input,text:snapshot},fresh);publish(next,snapshot);try{if(sessionStorage.getItem(pendingKey)===snapshot)sessionStorage.removeItem(pendingKey);}catch{/* IndexedDB already saved the edit. */}return next;}
  useEffect(()=>{
    mounted.current=true;let active=true;
    void serial(async()=>{let pending:string|null=null;try{if(!readOnly)pending=sessionStorage.getItem(pendingKey);}catch{/* Normal IndexedDB resumption remains available. */}let next=readOnly?await db.prepareHandoff(input):await db.resumeHandoff(input);if(pending!==null&&pending.length<=4000&&pending.trim())next=await save(pending);currentState.current=next;if(active){const restored=pending!==null&&pending.length<=4000?pending:next.draft.text;currentText.current=restored;setText(restored);setState(next);setReady(true);}}).catch(cause=>{if(active)setError(errorText(cause));});
    return()=>{active=false;mounted.current=false;const snapshot=currentText.current;if(currentState.current&&snapshot.trim()&&snapshot!==currentState.current.draft.text)void serial(()=>save(snapshot)).catch(()=>{});};
  },[input]);
  useEffect(()=>{
    if(!ready||!text.trim()||text===currentState.current?.draft.text)return;
    const timer=setTimeout(()=>{void serial(()=>save(text)).catch(cause=>{if(mounted.current)setError(errorText(cause));});},350);
    return()=>clearTimeout(timer);
  },[ready,text]);
  function run(task:(snapshot:string)=>Promise<void>){
    if(!ready||locked.current||!currentText.current.trim())return;
    locked.current=true;setBusy(true);setError('');const snapshot=currentText.current;
    void serial(()=>task(snapshot)).catch(cause=>{if(mounted.current)setError(errorText(cause));}).finally(()=>{locked.current=false;if(mounted.current)setBusy(false);});
  }
  async function record(snapshot:string,choice:HandoffChoice){const before=await save(snapshot),next=await db.changeHandoff(before.id,before.progress.revision,choice,undefined,choice.type==='sent'?callbacks.current.completion:undefined);publish(next,snapshot);return next;}
  function copy(){
    if(!ready||locked.current)return;
    let result:Promise<boolean>;
    try{result=navigator.clipboard.writeText(currentText.current).then(()=>true,()=>false);}catch{result=Promise.resolve(false);}
    run(async snapshot=>{const copied=await result;if(mounted.current)setManual(!copied);await record(snapshot,{type:copied?'copy':'copy-failed'});});
  }
  function share(){
    if(!ready||locked.current)return;
    let result:Promise<boolean>;
    try{result=navigator.share({text:currentText.current}).then(()=>true,()=>false);}catch{result=Promise.resolve(false);}
    void result.then(delivered=>{if(!delivered&&mounted.current)setManual(true);});
    run(async snapshot=>{await record(snapshot,{type:'open',channel:'share'});if(!await result)await record(snapshot,{type:'failed'});});
  }
  const confirmed=state?.progress.sentAt!==undefined,disabled=!ready||busy||!text.trim(),target=input.target;
  const href=target==='whatsapp'?`https://wa.me/${input.phone!.slice(1)}?text=${encodeURIComponent(text)}`:target==='call'?`tel:${input.phone}`:undefined;
  const status=confirmed?'Marked sent. Opening or copying again does not add another confirmation.':state?.progress.status==='copied'?'Copied. Mark sent after you finish.':state?.progress.status==='opened'?'Opened. Mark sent after you finish.':state?.progress.status==='failed'?'Could not finish. Copy the message or select it below.':'Opening another app or copying does not mark this sent.';
  return <div className="shared-handoff" aria-busy={busy||!ready}>
    <label>{previewLabel}<textarea aria-label={previewLabel} rows={target==='call'?3:8} maxLength={4000} readOnly={readOnly} disabled={!ready||busy} value={text} onChange={event=>{const value=event.target.value;currentText.current=value;setText(value);setState(undefined);setManual(false);setError('');try{sessionStorage.setItem(pendingKey,value);}catch{setError('Keep this message open until the edit is saved, or copy it before leaving.');}}} /></label>
    <p className="handoff-status" role="status">{status}</p>
    <div className="shared-handoff-actions">
      {href?<a className="button button-primary" href={href} target={target==='whatsapp'?'_blank':undefined} rel="noopener noreferrer" aria-disabled={disabled} onClick={event=>{if(disabled){event.preventDefault();return;}run(async snapshot=>{await record(snapshot,{type:'open',channel:target==='call'?'call':'whatsapp'});});}}>{target==='call'?'Call':'Open WhatsApp'}</a>:target==='share'&&typeof navigator.share==='function'?<Button type="button" disabled={disabled||confirmed} onClick={share}>Share message</Button>:null}
      <Button type="button" kind={href||target==='share'&&typeof navigator.share==='function'?'secondary':'primary'} disabled={disabled} onClick={copy}>{target==='call'?'Copy number / note':'Copy message'}</Button>
      <Button type="button" kind="secondary" disabled={disabled||confirmed} onClick={()=>run(async snapshot=>{await record(snapshot,{type:'failed'});if(mounted.current)setManual(true);})}>Didn't work</Button>
    </div>
    {manual?<label>Copy by hand<textarea aria-label="Copy by hand" readOnly rows={5} value={text} autoFocus onFocus={event=>event.target.select()} /></label>:null}
    {error?<p role="alert" className="form-error">{error}</p>:null}
    {confirmed?<Button type="button" kind="secondary" disabled={disabled} onClick={()=>run(async snapshot=>{await save(snapshot,true);if(mounted.current)setManual(false);})}>Start another attempt</Button>:null}
    <footer className="sheet-actions">{onSkip?<Button type="button" kind="secondary" disabled={busy} onClick={onSkip}>Skip</Button>:null}<Button type="button" disabled={disabled} onClick={()=>run(async snapshot=>{const before=await save(snapshot),fresh=before.progress.sentAt===undefined;if(fresh)await record(snapshot,{type:'sent'});if(mounted.current&&currentText.current===snapshot)await callbacks.current.onComplete(fresh);})}>{busy?'Saving…':confirmed?doneLabel:confirmLabel}</Button></footer>
  </div>;
}
