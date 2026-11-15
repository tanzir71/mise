import { useRef, useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { orderContactLinks, orderQuoteText } from '@mise/core/order-views';
import type { Order, SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { errorText } from './khata-data';

function messageParts(text:string):string[] {
  const parts:string[] = [];let remaining = text;
  while (remaining.length > 3500) {const boundary = remaining.lastIndexOf('\n',3500), cut = boundary > 0 ? boundary+1 : 3500;parts.push(remaining.slice(0,cut));remaining = remaining.slice(cut);}
  if (remaining) parts.push(remaining);return parts;
}
export function OrderHandoff({order,setup,call = false,onDone}: {order:Order;setup:SetupSnapshot;call?:boolean;onDone:() => void}) {
  const [parts] = useState(() => messageParts(call ? order.customer.phone || 'Spoke to the customer in person.' : orderQuoteText(order,setup)));
  const [index,setIndex] = useState(0), [text,setText] = useState(parts[0] || ''), [revision,setRevision] = useState(order.revision), [channel,setChannel] = useState<'whatsapp'|'manual'>('manual');
  const [saving,setSaving] = useState(false), [manual,setManual] = useState(false), [copied,setCopied] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  const links = orderContactLinks(order,text);
  async function copy() {try {await navigator.clipboard.writeText(text);setCopied(true);}catch{setManual(true);}}
  async function done() {
    if (busy.current) return;busy.current = true;setSaving(true);setError('');
    try {
      await db.recordOrderCommunication(order.id,{purpose:call ? 'call' : 'quote',channel:call ? 'call' : channel,text},revision);
      if (index+1 < parts.length) {setIndex(index+1);setText(parts[index+1]);setRevision(revision+1);setCopied(false);setManual(false);setChannel('manual');}
      else onDone();
    } catch (error) {setError(errorText(error));} finally {busy.current = false;setSaving(false);}
  }
  return <div className="khata-form order-handoff"><p>{order.customer.name} · {order.number}{parts.length > 1 ? ` · part ${index+1} of ${parts.length}` : ''}</p><label>{call ? 'Number / call note' : 'Message preview'}<textarea aria-label={call ? 'Call note' : 'Message preview'} maxLength={4000} rows={call ? 3 : 10} value={text} onChange={event => {setText(event.target.value);setCopied(false);}} /></label>
    {manual ? <label>Copy by hand<textarea aria-label="Copy by hand" readOnly rows={4} value={text} autoFocus onFocus={event => event.target.select()} /></label> : null}
    {copied ? <p role="status">Copied. Mark done after contacting the customer.</p> : null}
    <div className="handoff-actions">{call ? links.call ? <a className="button button-secondary" href={links.call}><MiseIcon name="phone" size={16} />Call</a> : <p>No saved number. Log a conversation in person.</p> : links.whatsapp ? <a className="button button-secondary" href={links.whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => setChannel('whatsapp')}><MiseIcon name="send" size={16} />Open WhatsApp</a> : <p>No saved number. Copy the message and share it yourself.</p>}<Button kind="secondary" disabled={saving} onClick={() => void copy()}><MiseIcon name="copy" size={16} />{call ? 'Copy number / note' : 'Copy message'}</Button></div>
    <p>{call ? 'The call is recorded only after you mark it done.' : 'Opening WhatsApp or copying does not mark this message as sent.'}{parts.length > 1 ? ' Review and send each part separately.' : ''}</p>{error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button disabled={saving || !text.trim()} onClick={() => void done()}>{saving ? 'Saving…' : call ? 'I called / spoke to them' : parts.length > 1 ? 'I sent this part' : 'I sent it'}</Button></footer></div>;
}
