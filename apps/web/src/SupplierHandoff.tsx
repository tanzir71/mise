import { useRef, useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { newSupplierMessageId, type SupplierDraft } from '@mise/core/supplier-drafts';
import { waLink } from '@mise/core/phone';
import { db } from './data/db';
import { errorText } from './khata-data';
export function SupplierHandoff({draft,onDone}: {draft:SupplierDraft;onDone:() => void}) {
  const [snapshot] = useState(draft), [index,setIndex] = useState(0), [text,setText] = useState(draft.parts[0]), [requestId,setRequestId] = useState(newSupplierMessageId), [channel,setChannel] = useState<'manual'|'whatsapp'>('manual');
  const [saving,setSaving] = useState(false), [error,setError] = useState(''), [manual,setManual] = useState(false), [copied,setCopied] = useState(false), busy = useRef(false);
  async function copy() {try {await navigator.clipboard.writeText(text);setCopied(true);}catch {setManual(true);}}
  async function sent() {
    if (busy.current) return;busy.current = true;setSaving(true);setError('');try {await db.recordSupplierMessage({id:requestId,supplierId:snapshot.supplierId,supplierName:snapshot.supplierName,phone:snapshot.phone,text,channel,stockItemIds:snapshot.stockItemIds,part:index+1,parts:snapshot.parts.length});if (index+1 < snapshot.parts.length) {setIndex(index+1);setText(snapshot.parts[index+1]);setRequestId(newSupplierMessageId());setChannel('manual');setCopied(false);setManual(false);}else onDone();}catch(error){setError(errorText(error));}finally{busy.current = false;setSaving(false);}
  }
  return <div className="stock-form"><p>{snapshot.supplierName}{snapshot.phone ? ` · ${snapshot.phone}` : ''}{snapshot.parts.length > 1 ? ` · part ${index+1} of ${snapshot.parts.length}` : ''}</p><label>Message preview<textarea aria-label="Supplier message preview" maxLength={4000} rows={10} value={text} onChange={event => {setText(event.target.value);setCopied(false);}} /></label>{manual ? <label>Copy by hand<textarea autoFocus aria-label="Copy by hand" rows={5} readOnly value={text} onFocus={event => event.target.select()} /></label> : null}<div className="handoff-actions">{snapshot.phone ? <a className="button button-secondary" href={waLink(snapshot.phone,text)} target="_blank" rel="noopener noreferrer" onClick={() => setChannel('whatsapp')}><MiseIcon name="send" size={16} />Open WhatsApp</a> : null}<Button kind="secondary" disabled={saving} onClick={() => void copy()}><MiseIcon name="copy" size={16} />Copy message</Button></div>{copied ? <p role="status">Copied. Mark Sent after sharing the message.</p> : null}<p className="stock-help">Opening WhatsApp or copying does not mark Sent. This draft does not change stock; record received quantities when they arrive.</p>{error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button disabled={saving || !text.trim()} onClick={() => void sent()}>{saving ? 'Saving…' : snapshot.parts.length > 1 ? 'Sent this part' : 'Sent'}</Button></footer></div>;
}
