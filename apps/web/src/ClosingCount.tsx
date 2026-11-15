import { useRef, useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { closingPreview, denominationTotal, safeTotal, type TodayContext } from '@mise/core/today';
import { newClosingId } from '@mise/core/closing';
import type { DayClosing } from '@mise/core/models';
import { formatMoney, moneyInputValue, parseMoney } from '@mise/core/money';
import { db } from './data/db';
import { errorText } from './khata-data';
import { cashMovementHelp, signedMoney } from './today-data';

export function ClosingCount({data,onDone,onBusy}: {data:TodayContext;onDone:(record:DayClosing) => void;onBusy:(value:boolean) => void}) {
  const [snapshot,setSnapshot] = useState(() => closingPreview(data,Date.now())), [requestId,setRequestId] = useState(newClosingId), [value,setValue] = useState(''), [note,setNote] = useState(''), [add,setAdd] = useState(false);
  const [denoms,setDenoms] = useState([{key:0,value:'',count:''},{key:1,value:'',count:''}]), nextKey = useRef(2), [denomError,setDenomError] = useState('');
  const [error,setError] = useState(''), [saving,setSaving] = useState(false), busy = useRef(false), currency = snapshot.summary.currency, amount = parseMoney(value,currency);
  let latest:ReturnType<typeof closingPreview>|undefined, latestError = '';
  try {latest = closingPreview(data,Date.now());}catch(error){latestError = errorText(error);}
  const stale = !latest || latest.fingerprint !== snapshot.fingerprint, dayChanged = latest?.summary.day !== snapshot.summary.day, currencyChanged = latest?.summary.currency !== currency;
  let difference:number|null = null;try {if (amount !== null) difference = safeTotal([amount,-snapshot.summary.expectedCash]);}catch { /* The form keeps the unsupported amount editable. */ }
  const money = (amount:number) => formatMoney(amount,currency);
  async function save() {
    if (busy.current || stale || amount === null || difference === null) return;busy.current = true;setSaving(true);onBusy(true);setError('');
    try {const record = await db.closeDay({id:requestId,day:snapshot.summary.day,fingerprint:snapshot.fingerprint,countedCash:amount,addDifference:add && difference > 0,note});onDone(record);}catch(error){setError(errorText(error));}finally{busy.current = false;setSaving(false);onBusy(false);}
  }
  function review() {if (!latest) return;setSnapshot(latest);setRequestId(newClosingId());setAdd(false);setError('');if (dayChanged || currencyChanged) {setValue('');setDenoms([{key:nextKey.current++,value:'',count:''}]);}}
  function useDenominations() {
    try {
      const lines = denoms.filter(line => line.value.trim() || line.count.trim()).map(line => {
        const denomination = parseMoney(line.value,currency), normal = line.count.trim().replace(/[০-৯]/g,digit => String(digit.charCodeAt(0)-0x09e6));
        if (denomination === null || !/^\d+$/.test(normal)) throw new Error('Enter a value and a whole number of notes or coins on each used row.');
        return {value:denomination,count:Number(normal)};
      });
      if (!lines.length) throw new Error('Enter at least one denomination.');
      setValue(moneyInputValue(denominationTotal(lines),currency));setAdd(false);setDenomError('');
    }catch(error){setDenomError(errorText(error));}
  }
  return <form className="closing-form" onSubmit={event => {event.preventDefault();void save();}}>
    <p className="closing-day">{snapshot.summary.day} · {currency} · {snapshot.summary.timezone}</p><p>{cashMovementHelp} Count the cash you are reconciling, or explain any opening float in the note.</p>
    <dl className="closing-facts"><div><dt>Retained cash receipts</dt><dd>{money(snapshot.summary.cashSales)}</dd></div><div><dt>Cash khata collections</dt><dd>{money(snapshot.summary.cashCollections)}</dd></div><div><dt>Cash refunds</dt><dd>−{money(snapshot.summary.cashRefunds)}</dd></div><div className="closing-fact-total"><dt>Recorded cash</dt><dd>{money(snapshot.summary.expectedCash)}</dd></div></dl>
    <fieldset disabled={saving}><label className="closing-count-label">Counted cash ({currency})<input required autoFocus inputMode="decimal" autoComplete="off" value={value} onChange={event => {setValue(event.target.value);setAdd(false);}} /></label>
    <details className="closing-denominations"><summary>Count by denomination</summary><p>Enter the value of each note or coin and how many you counted. Blank rows are ignored.</p><div className="denomination-list">{denoms.map((line,index) => <div key={line.key}><label>Value {index+1} ({currency})<input inputMode="decimal" autoComplete="off" value={line.value} onChange={event => setDenoms(rows => rows.map(row => row.key === line.key ? {...row,value:event.target.value} : row))} /></label><label>Count {index+1}<input inputMode="numeric" autoComplete="off" value={line.count} onChange={event => setDenoms(rows => rows.map(row => row.key === line.key ? {...row,count:event.target.value} : row))} /></label><Button type="button" kind="ghost" aria-label={`Remove denomination ${index+1}`} onClick={() => setDenoms(rows => rows.filter(row => row.key !== line.key))}><MiseIcon name="x" size={16} /></Button></div>)}</div><div className="closing-actions"><Button type="button" kind="secondary" disabled={denoms.length >= 30} onClick={() => setDenoms(rows => [...rows,{key:nextKey.current++,value:'',count:''}])}>Add denomination</Button><Button type="button" kind="secondary" onClick={useDenominations}>Use this count</Button></div>{denomError ? <p role="alert" className="form-error">{denomError}</p> : null}</details>
    {difference !== null ? <div className="closing-difference"><span>Difference</span><strong>{signedMoney(difference,currency)}</strong><small>{difference === 0 ? 'The count matches recorded cash.' : difference > 0 ? 'More cash counted than recorded.' : 'Less cash counted than recorded.'}</small></div> : value ? <p className="form-error">Enter a valid amount within the supported range.</p> : null}
    {difference !== null && difference > 0 ? <label className="closing-overage"><input type="checkbox" checked={add} onChange={event => setAdd(event.target.checked)} /><span>Add {money(difference)} as walk-in sales<small>Choose this only for sales you have not recorded. Opening float is not a sale.</small></span></label> : null}
    <label>Closing note{difference !== null && difference !== 0 && !add ? ' (required)' : ' (optional)'}<textarea rows={3} maxLength={1000} required={difference !== null && difference !== 0 && !add} value={note} onChange={event => setNote(event.target.value)} placeholder="Explain a shortfall, float or other difference." /></label></fieldset>
    {stale ? <div className="closing-stale" role="alert"><p>{latestError || (dayChanged || currencyChanged ? 'The shop day or currency changed. Start a fresh cash count.' : 'Today changed while you counted. Review the latest totals before saving.')}</p><Button type="button" kind="secondary" disabled={saving || !latest} onClick={review}>{dayChanged || currencyChanged ? 'Start fresh count' : 'Review latest totals'}</Button></div> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving || stale || amount === null || difference === null}>{saving ? 'Saving…' : 'Save day summary'}</Button></footer>
  </form>;
}
