import { useState, type FormEvent } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { Toggle } from '@mise/ui/Toggle.tsx';
import { moneyInputValue, parseMoney } from '@mise/core/money';
import { orderLineTotal, type OrderLineInput } from '@mise/core/order-lines';
import { errorText } from './khata-data';

export function OrderLineForm({value,currency,swap = false,notesOnly = false,onSaved}: {value?:OrderLineInput;currency:string;swap?:boolean;notesOnly?:boolean;onSaved:(line:OrderLineInput) => void}) {
  const [name,setName] = useState(swap ? '' : value?.name || ''), [unit,setUnit] = useState(value?.unit || 'pcs'), [qty,setQty] = useState(String(value?.qty || 1));
  const [price,setPrice] = useState(swap || value?.unitPrice == null ? '' : moneyInputValue(value.unitPrice,currency)), [note,setNote] = useState(value?.note || '');
  const [unavailable,setUnavailable] = useState(!swap && Boolean(value?.unavailable)), [accepted,setAccepted] = useState(!swap && Boolean(value?.substitution?.accepted)), [error,setError] = useState('');
  const linked = Boolean(value?.itemId && !swap), from = swap ? value?.substitution?.from || value?.name : value?.substitution?.from;
  function save(event:FormEvent) {
    event.preventDefault();setError('');
    try {
      const amount = price.trim() ? parseMoney(price,currency) : null, quantity = Number(qty);
      if (price.trim() && amount === null) throw new Error('Enter a valid unit price, or leave it blank for pricing later.');
      orderLineTotal(amount || 0,quantity);
      if (!name.trim() || !unit.trim()) throw new Error('Enter the item name and unit.');
      onSaved({...value,itemId:linked ? value?.itemId : undefined,name:name.trim(),unit:unit.trim(),qty:quantity,unitPrice:amount,note,unavailable:from ? false : unavailable,substitution:from ? {from,accepted} : undefined});
    } catch (error) { setError(errorText(error)); }
  }
  return <form className="khata-form order-line-form" onSubmit={save}><fieldset className="khata-fieldset"><legend className="sr-only">Order line</legend>
    {from ? <p>Swap for {from}. Enter the replacement yourself, then confirm only after the customer agrees.</p> : null}
    <label>Item name<input autoFocus={!notesOnly && !linked} required maxLength={120} value={name} disabled={linked || notesOnly} onChange={event => setName(event.target.value)} /></label>
    <div className="khata-form-pair"><label>Quantity<input required inputMode="decimal" value={qty} disabled={notesOnly} onChange={event => setQty(event.target.value)} /></label><label>Unit<input required maxLength={24} value={unit} disabled={linked || notesOnly} onChange={event => setUnit(event.target.value)} /></label></div>
    <label>Unit price ({currency})<input inputMode="decimal" value={price} disabled={linked || notesOnly} placeholder="Price later" onChange={event => setPrice(event.target.value)} /></label>
    {linked ? <small>This line retains its catalogue price. Choose a new catalogue item to use a changed price.</small> : <small>Leave the price blank when it still needs checking.</small>}
    <label>Item note (optional)<textarea autoFocus={notesOnly || linked} rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
    {!notesOnly ? from ? <div className="khata-toggle-row"><span>Customer accepted the swap<small>Ask them before turning this on.</small></span><Toggle checked={accepted} label="Customer accepted the swap" onChange={setAccepted} /></div> : <div className="khata-toggle-row"><span>Out of stock<small>Keep the line visible without charging for it.</small></span><Toggle checked={unavailable} label="Out of stock" onChange={setUnavailable} /></div> : null}
    </fieldset>{error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit">{swap ? 'Save swap proposal' : 'Save item'}</Button></footer></form>;
}
