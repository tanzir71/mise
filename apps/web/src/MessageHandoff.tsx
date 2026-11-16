import { useState } from 'react';
import { Modal } from '@mise/ui/Modal.tsx';
import { handoffParts } from '@mise/core/handoff-parts';
import type { HandoffDraft } from '@mise/core/handoff';
import { HandOff } from './HandOff';

interface Props {title:string;draft:Omit<HandoffDraft,'part'|'parts'>;onClose:()=>void;readOnly?:boolean}
export function MessageHandoff(props:Props){return <MessageSequence key={JSON.stringify(props.draft)} {...props}/>;}
function MessageSequence({title,draft,onClose,readOnly=false}:Props){
  const [split]=useState(()=>{try{return {parts:handoffParts(draft.text),error:''};}catch(error){return {parts:[],error:error instanceof Error?error.message:'Shorten this message before sharing.'};}}),[index,setIndex]=useState(0);
  return <Modal open title={title} variant="sheet" className="message-handoff" closeLabel="Close message" onClose={onClose}>{split.error?<p role="alert" className="form-error">{split.error}</p>:<>{split.parts.length>1?<p>Part {index+1} of {split.parts.length}. Review and send each part separately.</p>:null}<HandOff draft={{...draft,text:split.parts[index],part:index+1,parts:split.parts.length}} readOnly={readOnly} confirmLabel={split.parts.length>1?'I sent this part':'I sent it'} doneLabel={index+1<split.parts.length?'Next part':'Done'} onComplete={()=>{if(index+1<split.parts.length)setIndex(index+1);else onClose();}}/></>}</Modal>;
}
