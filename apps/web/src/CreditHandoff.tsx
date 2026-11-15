import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Toggle } from '@mise/ui/Toggle.tsx';
import { creditBalance, type LedgerContext } from '@mise/core/khata';
import { creditReceiptText, customerContactLinks, khataReminderText } from '@mise/core/khata-messages';
import { formatMoney, moneyInputValue, parseMoney } from '@mise/core/money';
import { marketPacks } from '@mise/core/packs';
import type { CreditEntry, Sale } from '@mise/core/models';
import { db } from './data/db';
import { displayName, errorText } from './khata-data';

export function CreditHandoff({accountId,purpose,sale,payment,onDone,onSkip,position}: {accountId:string;purpose:'reminder'|'receipt'|'call';sale?:Sale;payment?:CreditEntry;onDone:() => void;onSkip?:() => void;position?:string}) {
  const ledger = useLiveQuery(() => db.readCreditLedger(accountId),[accountId]);
  const [copied,setCopied] = useState(false), [manual,setManual] = useState(false), [opened,setOpened] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  const preview = useMemo(() => {
    if (!ledger) return {text:'',error:''};
    try { return {text:purpose === 'call' ? ledger.customer.phone || '' : purpose === 'receipt' ? creditReceiptText(ledger,sale,payment) : khataReminderText(ledger),error:''}; }
    catch (error) { return {text:'',error:errorText(error)}; }
  },[ledger,purpose,sale,payment]);
  if (!ledger) return <p role="status">Preparing…</p>;
  const links = customerContactLinks(ledger,preview.text), paid = purpose === 'reminder' && creditBalance(ledger.account,ledger.entries) <= 0;
  const unavailable = Boolean(preview.error) || paid || ledger.customer.archivedAt !== undefined;
  async function copy() { try { await navigator.clipboard.writeText(preview.text); setCopied(true); } catch { setManual(true); } }
  async function done() {
    if (busy.current || unavailable) return; busy.current = true; setSaving(true); setError('');
    try { await db.recordCommunication(accountId,purpose,purpose === 'call' ? `Called ${preview.text}` : preview.text,purpose === 'call' ? 'call' : opened ? 'whatsapp' : 'manual'); onDone(); }
    catch (error) { setError(errorText(error)); } finally { busy.current = false; setSaving(false); }
  }
  return <div className="credit-handoff"><p>{position ? `${position} · ` : ''}{displayName(ledger.customer)} · {formatMoney(creditBalance(ledger.account,ledger.entries),ledger.account.currency)} due</p>
    {paid ? <p role="status">This khata is paid up. No reminder is needed.</p> : <><label>{purpose === 'call' ? 'Phone number' : 'Message preview'}<textarea aria-label={purpose === 'call' ? 'Phone number to call' : 'Message preview'} rows={purpose === 'call' ? 2 : 8} readOnly value={preview.text} /></label>
      {!ledger.customer.phone ? <p>Add a phone number to open WhatsApp or make a call. You can still copy the message.</p> : null}<div className="handoff-actions">{!unavailable && (purpose === 'call' ? links.call : links.whatsapp) ? <a className="button button-secondary" href={purpose === 'call' ? links.call : links.whatsapp} target={purpose === 'call' ? undefined : '_blank'} rel="noreferrer" onClick={() => setOpened(true)}><MiseIcon name={purpose === 'call' ? 'phone' : 'send'} size={16} />{purpose === 'call' ? 'Call' : 'Open WhatsApp'}</a> : null}<Button kind="secondary" disabled={saving || unavailable} onClick={() => void copy()}><MiseIcon name="clipboard" size={16} />{purpose === 'call' ? 'Copy number' : 'Copy message'}</Button></div>
      {copied ? <p role="status">Copied. Mark done after you finish.</p> : null}{manual ? <label>Copy by hand<textarea aria-label="Copy by hand" readOnly value={preview.text} rows={6} autoFocus onFocus={event => event.target.select()} /></label> : null}<p>Opening another app or copying does not mark this done.</p></>}
    {preview.error || error ? <p role="alert" className="form-error">{preview.error || error}</p> : null}<footer className="sheet-actions">{onSkip ? <Button kind="secondary" disabled={saving} onClick={onSkip}>Skip</Button> : null}<Button disabled={saving || unavailable || (purpose === 'call' && !ledger.customer.phone)} onClick={() => void done()}>{saving ? 'Saving…' : purpose === 'call' ? 'I called' : 'I sent it'}</Button></footer></div>;
}
export function CreditPaymentForm({ledger,onSaved}: {ledger:LedgerContext;onSaved:(entry:CreditEntry,receipt:boolean) => void}) {
  const [amount,setAmount] = useState(() => moneyInputValue(Math.max(0,creditBalance(ledger.account,ledger.entries)),ledger.account.currency)), [method,setMethod] = useState('Cash'), [note,setNote] = useState(''), [receipt,setReceipt] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  const wallets = marketPacks[ledger.setup.business.marketCode]['pay/wallets'].filter(wallet => wallet !== 'Cash');
  return <form className="khata-form" onSubmit={async event => {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError('');
    try { const value = parseMoney(amount,ledger.account.currency); if (value === null || value <= 0) throw new Error('Enter the amount received.'); const entry = await db.recordCreditPayment(ledger.account.id,value,method === 'Cash' ? 'cash' : method === 'Card' ? 'card' : 'wallet',wallets.includes(method) ? method : undefined,note); onSaved(entry,receipt); }
    catch (error) { setError(errorText(error)); } finally { busy.current = false; setSaving(false); }
  }}><p>{displayName(ledger.customer)} · {formatMoney(creditBalance(ledger.account,ledger.entries),ledger.account.currency)} due. Record money only after you receive it.</p><fieldset className="khata-fieldset" disabled={saving}><legend className="sr-only">Payment received</legend><label>Amount received ({ledger.account.currency})<input inputMode="decimal" required value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Payment method<select value={method} onChange={event => setMethod(event.target.value)}>{['Cash',...wallets,'Card'].map(value => <option key={value}>{value}</option>)}</select></label><label>Payment note (optional)<textarea rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label><div className="khata-toggle-row"><span>Prepare receipt on WhatsApp<small>You review and send it yourself.</small></span><Toggle checked={receipt} label="Prepare receipt on WhatsApp" disabled={saving} onChange={setReceipt} /></div></fieldset>{error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Record payment'}</Button></footer></form>;
}
