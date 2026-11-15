import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { Toggle } from '@mise/ui/Toggle.tsx';
import { defaultCreditTerms, type CreditTermsInput } from '@mise/core/khata';
import { defaultCreditMessaging } from '@mise/core/khata-messages';
import { moneyInputValue, parseMoney } from '@mise/core/money';
import type { CreditAccount, Customer, SetupSnapshot } from '@mise/core/models';
import type { CustomerInput } from '@mise/core/customers';
import { db } from './data/db';
import { errorText } from './khata-data';

export function TermsFields({value,onChange,currency,disabled}: {value:CreditTermsInput;onChange:(value:CreditTermsInput) => void;currency:string;disabled:boolean}) {
  const [limit,setLimit] = useState(() => moneyInputValue(value.limit,currency));
  return <fieldset className="khata-fieldset" disabled={disabled}><legend>Credit settings · {currency}</legend><div className="khata-toggle-row"><span>Allow credit<small>Only for people you trust.</small></span><Toggle checked={value.allowed} label="Allow credit" disabled={disabled} onChange={allowed => onChange({...value,allowed})} /></div>
    <label>Credit limit ({currency})<input inputMode="decimal" required value={limit} onChange={event => { setLimit(event.target.value); onChange({...value,limit:parseMoney(event.target.value,currency) ?? -1}); }} /></label>
    <div className="khata-toggle-row"><span>Monthly reminder<small>You review each message before sending.</small></span><Toggle checked={value.reminder.enabled} label="Monthly reminder" disabled={disabled} onChange={enabled => onChange({...value,reminder:{...value.reminder,enabled}})} /></div>
    <div className="khata-form-pair"><label>Day of month<input type="number" min="1" max="31" required value={value.reminder.dayOfMonth} onChange={event => onChange({...value,reminder:{...value.reminder,dayOfMonth:Number(event.target.value)}})} /></label><label>Reminder tone<select value={value.reminder.tone} onChange={event => onChange({...value,reminder:{...value.reminder,tone:event.target.value as 'gentle'|'direct'}})}><option value="gentle">Gentle</option><option value="direct">Direct</option></select></label></div><small>For shorter months, use the last day.</small></fieldset>;
}
export function CustomerForm({setup,customer,onSaved}: {setup:SetupSnapshot;customer?:Customer;onSaved:(customer:Customer) => void}) {
  const [value,setValue] = useState<CustomerInput>({name:customer?.name || '',nickname:customer?.nickname || '',phone:customer?.phone || '',address:customer?.address || '',notes:customer?.notes || '',tags:customer?.tags || []});
  const [terms,setTerms] = useState<CreditTermsInput>(structuredClone(defaultCreditTerms)), [opening,setOpening] = useState(''), [date,setDate] = useState(() => new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10));
  const [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  const change = (field: keyof CustomerInput, text: string) => setValue(before => ({...before,[field]:field === 'tags' ? text.split(',') : text}));
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError('');
    try {
      const amount = opening.trim() ? parseMoney(opening,setup.outlet.currency) : 0;
      if (amount === null || terms.limit < 0) throw new Error('Enter a valid credit limit and opening balance.');
      onSaved(await db.saveCustomer(value,{id:customer?.id,...(!customer ? {credit:terms,...(amount > 0 ? {opening:{amount,occurredAt:new Date(`${date}T00:00:00`).getTime()}} : {})} : {})}));
    } catch (error) { setError(errorText(error)); } finally { busy.current = false; setSaving(false); }
  }
  return <form className="khata-form" onSubmit={event => void save(event)}><fieldset disabled={saving} className="khata-fieldset"><legend className="sr-only">Customer details</legend>
    {([['name','Name',80],['nickname','Nickname (optional)',80],['phone','Phone (optional)',30],['address','Address (optional)',250]] as const).map(([field,label,max]) => <label key={field}>{label}<input name={field} type={field === 'phone' ? 'tel' : 'text'} autoComplete={field === 'phone' ? 'tel' : 'off'} value={value[field]} required={field === 'name'} maxLength={max} onChange={event => change(field,event.target.value)} /></label>)}
    <label>Tags (comma separated)<input value={value.tags.join(',')} onChange={event => change('tags',event.target.value)} /></label><label>Notes<textarea rows={3} maxLength={2000} value={value.notes} onChange={event => change('notes',event.target.value)} /></label><small>Save contact details with the customer’s permission. Records stay on this device.</small></fieldset>
    {!customer ? <><TermsFields value={terms} onChange={setTerms} currency={setup.outlet.currency} disabled={saving} /><fieldset className="khata-fieldset" disabled={saving}><legend>Existing balance (optional)</legend><label>Opening balance ({setup.outlet.currency})<input inputMode="decimal" value={opening} onChange={event => setOpening(event.target.value)} /></label>{opening.trim() ? <label>Balance since<input type="date" required value={date} max={new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)} onChange={event => setDate(event.target.value)} /></label> : null}</fieldset></> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save customer'}</Button></footer></form>;
}
export function CreditTermsForm({customer,account,setup,onSaved}: {customer:Customer;account?:CreditAccount;setup:SetupSnapshot;onSaved:() => void}) {
  const [value,setValue] = useState<CreditTermsInput>(account ? {allowed:account.allowed,limit:account.limit,reminder:{...account.reminder}} : structuredClone(defaultCreditTerms)), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  return <form className="khata-form" onSubmit={async event => { event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError(''); try { await db.saveCreditTerms(customer.id,value,account?.id); onSaved(); } catch (error) { setError(errorText(error)); } finally { busy.current = false; setSaving(false); } }}><TermsFields value={value} onChange={setValue} currency={account?.currency || setup.outlet.currency} disabled={saving} />{error ? <p className="form-error" role="alert">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save credit settings'}</Button></footer></form>;
}
export function CreditWordingForm({setup,onSaved}: {setup:SetupSnapshot;onSaved:() => void}) {
  const [value,setValue] = useState(() => structuredClone(setup.outlet.creditMessaging || defaultCreditMessaging)), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  return <form className="khata-form" onSubmit={async event => { event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError(''); try { await db.saveCreditMessaging(value); onSaved(); } catch (error) { setError(errorText(error)); } finally { busy.current = false; setSaving(false); } }}><p>Use {'{name}'}, {'{shop}'} and {'{amount}'} in each template. {'{payment}'} inserts your payment instructions.</p><fieldset disabled={saving} className="khata-fieldset"><legend className="sr-only">Message wording</legend><label>Payment instructions (optional)<textarea maxLength={250} rows={2} value={value.paymentNote} onChange={event => setValue({...value,paymentNote:event.target.value})} /></label>{(['gentle','direct'] as const).flatMap(tone => (['en','bn'] as const).map(language => <label key={`${tone}-${language}`}>{tone === 'gentle' ? 'Gentle' : 'Direct'} · {language === 'en' ? 'English' : 'বাংলা'}<textarea lang={language} maxLength={1000} rows={4} value={value.templates[tone][language]} onChange={event => setValue({...value,templates:{...value.templates,[tone]:{...value.templates[tone],[language]:event.target.value}}})} /></label>))}</fieldset>{error ? <p className="form-error" role="alert">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save wording'}</Button></footer></form>;
}
