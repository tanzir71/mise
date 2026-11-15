import { useRef, useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import type { StockItem } from '@mise/core/models';
import type { StockAdjustment as Adjustment } from '@mise/core/stock';
import { stockAtoms, stockNumber, stockQuantityText } from '@mise/core/stock-quantity';
import { db } from './data/db';
import { quantityInput } from './stock-data';
import { errorText } from './khata-data';
export function StockAdjustment({item,reason = 'count',onDone}: {item:StockItem;reason?:Adjustment['reason'];onDone:() => void}) {
  const [snapshot] = useState(item), [action,setAction] = useState(reason), [value,setValue] = useState(reason === 'count' ? String(item.onHand) : ''), [note,setNote] = useState(''), [error,setError] = useState(''), [saving,setSaving] = useState(false), busy = useRef(false);
  const amount = (() => {try {const quantity = stockAtoms(quantityInput(value));return stockNumber(action === 'count' ? quantity : stockAtoms(snapshot.onHand)+(action === 'received' ? quantity : -quantity));}catch{return null;}})();
  async function save() {if (busy.current) return;busy.current = true;setSaving(true);setError('');try {await db.adjustStock({id:snapshot.id,revision:snapshot.revision,reason:action,quantity:quantityInput(value),note});onDone();}catch(error){setError(errorText(error));}finally{busy.current = false;setSaving(false);}}
  return <form className="stock-form" onSubmit={event => {event.preventDefault();void save();}}><p>{snapshot.name} · {stockQuantityText(snapshot.onHand)} {snapshot.unit} on hand</p><fieldset disabled={saving}><label>Action<select value={action} onChange={event => {setAction(event.target.value as Adjustment['reason']);setValue('');}}><option value="count">Physical count</option><option value="received">Received stock</option><option value="used">Used stock</option><option value="waste">Waste</option></select></label><label>{action === 'count' ? 'Counted quantity' : 'Quantity'} ({snapshot.unit})<input required autoFocus inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} /></label><label>Note (optional)<textarea rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label></fieldset><p className="stock-change-preview">{snapshot.name}: {stockQuantityText(snapshot.onHand)} → {amount === null || amount < 0 ? 'Check quantity' : stockQuantityText(amount)} {snapshot.unit}</p>{error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving || amount === null || amount < 0}>{saving ? 'Saving…' : 'Save stock change'}</Button></footer></form>;
}
