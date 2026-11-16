import { useRef, useState } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { moneyInputValue, formatMoney, parseMoney } from '@mise/core/money';
import { orderLineTotal, orderPricing } from '@mise/core/order-lines';
import type { Order, OrderLine } from '@mise/core/models';
import { db } from './data/db';
import { errorText } from './khata-data';
import { OrderLineForm } from './OrderLineForm';
import { orderInput } from './order-ui';

export type OrderPriceDraft=Pick<Order,'currency'|'deliveryFee'|'discount'|'sourceText'>&{customerName:string;lines:OrderLine[];reviewNotes?:string[]};
type PricingProps={onBack:()=>void}&({order:Order;draft?:never;onQuote:(order:Order)=>void;onReviewed?:never}|{order?:never;draft:OrderPriceDraft;onQuote?:never;onReviewed:(lines:OrderLine[])=>void});
export function OrderPricing(props:PricingProps) {
  const {order:liveOrder,onBack}=props,initial=props.order??props.draft!;
  const [base,setBase] = useState<Order|OrderPriceDraft>(initial), [lines,setLines] = useState(() => structuredClone(initial.lines));
  const [selected,setSelected] = useState(() => initial.lines.find(line => line.unitPrice === null && !line.unavailable)?.id || initial.lines[0]?.id || '');
  const first = lines.find(line => line.id === selected);
  const [value,setValue] = useState(() => first?.unitPrice == null ? '' : moneyInputValue(first.unitPrice,initial.currency));
  const [editor,setEditor] = useState<{id:string;swap:boolean}|null>(null), [error,setError] = useState(''), [saving,setSaving] = useState(false), busy = useRef(false);
  const currency = base.currency, active = lines.find(line => line.id === selected), editing = lines.find(line => line.id === editor?.id);
  let pricing:ReturnType<typeof orderPricing>|undefined;
  try {pricing = orderPricing(currentLines(),base.deliveryFee,base.discount);} catch { /* The editable field reports its error when applied. */ }
  function currentLines():OrderLine[] {
    if(!active)throw new Error('Add an item before pricing the request.');
    if (active.itemId || active.unavailable) return lines;
    const price = value.trim() ? parseMoney(value,currency) : null;
    if (value.trim() && price === null) throw new Error('Enter a valid unit price.');
    return lines.map(line => line.id === selected ? {...line,unitPrice:price,lineTotal:price === null ? null : orderLineTotal(price,line.qty)} : line);
  }
  function select(line:OrderLine) {
    if (line.id === selected) return;
    try {setLines(currentLines());setSelected(line.id);setValue(line.unitPrice === null ? '' : moneyInputValue(line.unitPrice,currency));setError('');} catch (error) {setError(errorText(error));}
  }
  function key(key:string) {
    if (key === 'Next') {
      try {const next = currentLines();setLines(next);const index = next.findIndex(line => line.id === selected), line = next.slice(index+1).find(line => !line.unavailable && !line.itemId) || next.find(line => !line.unavailable && !line.itemId);if (line) {setSelected(line.id);setValue(line.unitPrice === null ? '' : moneyInputValue(line.unitPrice,currency));}setError('');} catch (error) {setError(errorText(error));}return;
    }
    if (key === 'C') setValue('');else if (key === '⌫') setValue(before => before.slice(0,-1));else if (value.length < 24 && (key !== '.' || !value.includes('.'))) setValue(before => before === '0' && key !== '.' ? key : before+key);
  }
  async function save(quote = false) {
    if (busy.current) return;busy.current = true;setSaving(true);setError('');
    try {const changed = currentLines();if(!('id' in base)){props.onReviewed?.(changed);return;}const saved = await db.saveOrder({...orderInput(base),lines:changed},{id:base.id,revision:base.revision});setBase(saved);setLines(saved.lines);if (quote) props.onQuote?.(saved);else onBack();} catch (error) {setError(errorText(error));} finally {busy.current = false;setSaving(false);}
  }
  if(!active)return <Card className="app-panel"><h1>Add an item first</h1><Button onClick={onBack}>Back to request</Button></Card>;
  return <section className="order-pricing"><header className="app-page-heading"><h1>Price order</h1><p>{'customer' in base?`${base.customer.name} · ${base.number}`:`${base.customerName||'Customer request'} · Unsaved request`}</p></header><p className="order-pricing-help">Check every typed line and decide what is available. Enter prices per unit.</p>{props.draft?.reviewNotes?.length?<Card className="order-source-note" role="note" tabIndex={0} aria-label="Pasted request review">{props.draft.reviewNotes.map((note,index)=><p key={index}>{note}</p>)}</Card>:null}{base.sourceText ? <Card className="order-source-note" tabIndex={props.draft?0:undefined}><p>{base.sourceText}</p></Card> : null}
    <Card className="order-price-list">{lines.map(line => <article key={line.id} data-selected={line.id === selected}><div><strong>{line.name}</strong><small>{line.qty} {line.unit}{line.note ? ` · ${line.note}` : ''}</small>{line.unavailable ? <span className="order-warning">Out of stock</span> : line.substitution ? <span className="order-warning">Swap for {line.substitution.from} · {line.substitution.accepted ? 'accepted' : 'ask customer'}</span> : null}</div><button className="order-price-button" aria-label={`Price ${line.name}`} aria-pressed={line.id === selected} disabled={saving} onClick={() => select(line)}>{line.unitPrice === null ? 'Price' : formatMoney(line.unitPrice,currency)}</button><div className="order-line-actions"><Button kind="ghost" disabled={saving} onClick={() => {try {setLines(currentLines());setEditor({id:line.id,swap:false});setError('');} catch(error){setError(errorText(error));}}}>Edit</Button><Button kind="ghost" disabled={saving} onClick={() => {try {setLines(currentLines());setEditor({id:line.id,swap:true});setError('');} catch(error){setError(errorText(error));}}}>Offer swap</Button></div></article>)}</Card>
    {lines.some(line => line.substitution) ? <Card className="order-swap-summary">{lines.filter(line => line.substitution).map(line => <div key={line.id}><small>Swap for {line.substitution!.from}</small><p>{line.name} · {line.substitution!.accepted ? 'Customer agreed.' : 'Ask the customer to agree before adding this replacement.'}</p></div>)}</Card> : null}
    {liveOrder&&'revision' in base&&liveOrder.revision !== base.revision ? <p className="order-warning">This order changed. Reopen it before saving these prices.</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="order-price-keypad"><label>{active.name} · unit price ({currency})<input inputMode="decimal" aria-label="Selected unit price" disabled={saving || Boolean(active.itemId) || active.unavailable} value={value} onChange={event => setValue(event.target.value)} /></label>{active.itemId ? <small>This catalogue line retains its saved price. Use Edit for availability or Offer swap for a replacement.</small> : active.unavailable ? <small>Out-of-stock lines do not charge the customer.</small> : <div className="order-mini-keys" role="group" aria-label="Price keypad">{['1','2','3','⌫','4','5','6','Next','7','8','9','C','0','00','.'].map(label => <button type="button" key={label} disabled={saving} aria-label={label === '⌫' ? 'Backspace price' : label === 'C' ? 'Clear price' : label} className={label === 'Next' ? 'primary' : ['⌫','C'].includes(label) ? 'operator' : ''} onClick={() => key(label)}>{label === '⌫' ? <MiseIcon name="arrowLeft" size={18} /> : label}</button>)}</div>}
      <div className="order-price-footer"><div><strong>{pricing?.total === null || pricing?.total === undefined ? pricing?.subtotal ? `Priced items ${formatMoney(pricing.subtotal,currency)}` : 'Price pending' : `Total ${formatMoney(pricing.total,currency)}`}</strong>{pricing?.proposed ? <small>+ proposed swap {formatMoney(pricing.proposed,currency)}</small> : null}</div>{props.draft?<><Button kind="secondary" disabled={saving} onClick={onBack}>Back</Button><Button disabled={saving} onClick={()=>void save()}>Review order details</Button></>:<><Button kind="secondary" disabled={saving} onClick={() => void save()}>Save prices</Button><Button disabled={saving} onClick={() => void save(true)}><MiseIcon name="send" size={16} />Send price</Button></>}</div><small>{props.draft?'Nothing is saved yet. Check contact and fulfilment details before creating the order.':'Review the message, then send it yourself. Swaps need the customer’s agreement.'}</small></div>
    <Modal open={Boolean(editor)} variant="sheet" title={editor?.swap ? 'Offer a swap' : 'Edit order item'} closeLabel="Close" onClose={() => setEditor(null)}>{editing ? <OrderLineForm key={`${editing.id}:${editor?.swap}`} value={editing} currency={currency} swap={editor?.swap} onSaved={value => {const changed:OrderLine = {...editing,...value,id:editing.id,note:value.note || '',unavailable:Boolean(value.unavailable),lineTotal:value.unitPrice === null ? null : orderLineTotal(value.unitPrice,value.qty)};setLines(before => before.map(line => line.id === editing.id ? changed : line));if (selected === editing.id) setValue(value.unitPrice === null ? '' : moneyInputValue(value.unitPrice,currency));setEditor(null);}} /> : null}</Modal></section>;
}
