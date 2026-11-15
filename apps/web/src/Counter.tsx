import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { calculateAmount } from '@mise/core/calc';
import { orderableItems, searchItems } from '@mise/core/catalogue';
import { formatMoney, moneyInputValue, parseMoney } from '@mise/core/money';
import { canUndoSale, dailySales, givenSuggestions, saleTotals, type SaleInput } from '@mise/core/sales';
import { marketPacks } from '@mise/core/packs';
import type { Item, Sale, PaymentMethod, SetupSnapshot } from '@mise/core/models';
import copy from '../../../handover/copy/app.en.json';
import { db } from './data/db';
import { Receipt } from './Receipt';
import { CreditSheet } from './CreditSheet';
import type { CreditSaleInput } from '@mise/core/credit-sales';
import { useCounterSpeech } from './useCounterSpeech';
import './counter.css';
const c = copy.counter, keys = ['C','⌫','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','00','0','.','='];
const saleCount = (count: number) => `${count} ${count === 1 ? c.sale : c.count}`;
export function CounterDayTotal({ setup }: { setup: SetupSnapshot }) {
  const sales = useLiveQuery(() => db.sales.where('outletId').equals(setup.outlet.id).toArray(),[setup.outlet.id],[]);
  const [now,setNow] = useState(Date.now);
  useEffect(() => { const timer=setInterval(() => setNow(Date.now()),30000); return () => clearInterval(timer); },[]);
  const amount = dailySales(sales,setup.outlet.timezone,now).filter(sale => sale.currency === setup.outlet.currency).reduce((sum,sale) => sum+BigInt(sale.amount),0n);
  return <>{copy.today} {amount <= BigInt(Number.MAX_SAFE_INTEGER) ? formatMoney(Number(amount),setup.outlet.currency) : '—'}</>;
}
type Sheet = 'who' | 'items' | 'given' | 'payment' | null;
export function Counter({ setup, online, khataEnabled }: { setup: SetupSnapshot; online: boolean; khataEnabled: boolean }) {
  const data = useLiveQuery(async () => { const [items,sales] = await Promise.all([db.items.where('outletId').equals(setup.outlet.id).toArray(),db.sales.where('outletId').equals(setup.outlet.id).toArray()]); return { items,sales:sales.sort((a,b) => b.createdAt-a.createdAt) }; },[setup.outlet.id]);
  const [expression,setExpression] = useState(''), [finished,setFinished] = useState(false), [given,setGiven] = useState<number>(), [who,setWho] = useState('');
  const [attached,setAttached] = useState<NonNullable<SaleInput['items']>>([]), [sheet,setSheet] = useState<Sheet>(null), [search,setSearch] = useState('');
  const [name,setName] = useState(''), [givenInput,setGivenInput] = useState(''), [error,setError] = useState(''), [message,setMessage] = useState(''), [saving,setSaving] = useState(false);
  const [creditDraft,setCreditDraft] = useState<Pick<CreditSaleInput,'expression'|'items'>|null>(null);
  const [last,setLast] = useState<Sale | null>(null), [receipt,setReceipt] = useState<Sale | null>(null), [now,setNow] = useState(Date.now), [limit,setLimit] = useState(50);
  const [desktop,setDesktop] = useState(() => matchMedia('(min-width:1024px)').matches);
  const busy = useRef(false), submitted = useRef<string | null>(null), currency = setup.outlet.currency;
  const wallets = marketPacks[setup.business.marketCode]['pay/wallets'].filter(wallet => wallet !== 'Cash');
  const [payment,setPayment] = useState(wallets[0] || c.card);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()),30000), media = matchMedia('(min-width:1024px)'), change = () => setDesktop(media.matches); media.addEventListener('change',change); return () => { clearInterval(timer); media.removeEventListener('change',change); }; },[]);
  const sales = data?.sales || [], items = data?.items || [];
  const today = useMemo(() => dailySales(data?.sales || [],setup.outlet.timezone,now),[data?.sales,setup.outlet.timezone,now]);
  const total = today.filter(sale => sale.currency === currency).reduce((sum,sale) => sum+BigInt(sale.amount),0n);
  const todayAmount = total <= BigInt(Number.MAX_SAFE_INTEGER) ? formatMoney(Number(total),currency) : '—';
  const amount = calculateAmount(expression,currency), displayed = amount ?? calculateAmount(expression.replace(/[+\-*/.]+$/,''),currency) ?? 0;
  const currentLast = last ? sales.find(sale => sale.id === last.id) || last : null;
  const suggestions = givenSuggestions(amount || 0,currency);
  const recent = [...new Set(sales.filter(sale => !sale.voidedAt && sale.who).map(sale => sale.who))].slice(0,3);
  const available = useMemo(() => searchItems(orderableItems(data?.items || []),search),[data?.items,search]);
  function change(value: string) { if (busy.current) return; setExpression(value.slice(0,160)); setFinished(false); setError(''); submitted.current = null; }
  const speech = useCounterSpeech(currency,online,change,() => setError(c.speechFailed));
  function key(value: string) {
    if (saving) return;
    if (value === 'C') { change(''); setAttached([]); setGiven(undefined); return; }
    if (value === '⌫') { change(expression.slice(0,-1)); return; }
    if (value === '=') { if (amount === null) setError(c.invalid); else setFinished(true); return; }
    const operator = ({'×':'*','÷':'/','−':'-'} as Record<string,string>)[value] || value;
    if (finished) {
      change(/[+\-*/%]/.test(operator) ? `${moneyInputValue(amount || 0,currency).replace(',','.')}${operator}` : operator);
      if (!/[+\-*/%]/.test(operator)) setAttached([]);
    } else if (/[+*/]/.test(operator) && /[+\-*/]$/.test(expression)) change(expression.slice(0,-1)+operator);
    else change(expression+operator);
  }
  function attach(item: Item) { setAttached(before => before.some(line => line.itemId === item.id) ? before.filter(line => line.itemId !== item.id) : [...before,{itemId:item.id,unitPrice:item.price,qty:1}]); }
  async function record(method: PaymentMethod, wallet?: string) {
    if (busy.current || submitted.current === expression || amount === null || amount <= 0) return;
    speech.cancel();
    busy.current = true; submitted.current = expression; setSaving(true); setError('');
    try {
      const sale = await db.recordSale({ expression,method,wallet,given:method === 'cash' ? given : undefined,who,items:attached });
      setLast(sale); setExpression(''); setAttached([]); setGiven(undefined); setWho(''); setFinished(false); setSheet(null); setMessage(''); setNow(Date.now());
    } catch (error) { submitted.current = null; setError(error instanceof Error ? error.message : copy.storageHelp); }
    finally { busy.current = false; setSaving(false); }
  }
  async function undo(sale: Sale) {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    try { await db.undoSale(sale.id); setMessage(c.undone); if (last?.id === sale.id) setLast(null); setNow(Date.now()); }
    catch (error) { setError(error instanceof Error ? error.message : copy.storageHelp); }
    finally { busy.current = false; setSaving(false); }
  }
  if (receipt) return <Receipt sale={receipt} onBack={() => setReceipt(null)} />;
  return <div className="counter-page" aria-busy={!data}><header className="counter-heading"><h1>{c.title}</h1><p>{copy.today} {todayAmount}</p></header>
    <div className="counter-columns"><section className="counter-workspace" aria-label={c.title}>
      <div className="counter-who"><button className={`chip ${!who ? 'selected' : ''}`} disabled={saving} onClick={() => setWho('')}>{c.walkIn}</button>{recent.map(person => <button key={person} className={`chip ${who === person ? 'selected' : ''}`} disabled={saving} onClick={() => setWho(person)}>{person}</button>)}{who && !recent.includes(who) ? <span className="chip selected">{who}</span> : null}<button className="chip" disabled={saving} onClick={() => { setName(who); setSheet('who'); }}><MiseIcon name="plus" size={14} />{c.who}</button></div>
      {currentLast ? <div className="counter-success" role="status"><p><MiseIcon name="checkCircle" size={18} />{currentLast.method === 'credit' ? 'Added to khata' : c.paid} {formatMoney(currentLast.amount,currentLast.currency)} · {currentLast.methodName}</p><div><Button kind="secondary" onClick={() => setReceipt(currentLast)}>{c.showQr}</Button>{canUndoSale(currentLast,now) ? <Button kind="ghost" disabled={saving} onClick={() => void undo(currentLast)}>{c.undo}</Button> : null}</div></div> : null}
      <div className="counter-display"><label className="sr-only" htmlFor="counter-expression">{c.calculation}</label><input id="counter-expression" name="calculation" value={expression} placeholder="0" maxLength={160} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={saving} onChange={event => change(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); key('='); } }} /><output aria-label={c.total} className={formatMoney(displayed,currency).length > 12 ? 'long-total' : ''}>{formatMoney(displayed,currency)}</output></div>
      {attached.length ? <div className="counter-named"><small>{c.receiptPrices}</small>{attached.map(line => <button key={line.itemId} disabled={saving} aria-label={`${c.removeItem}: ${items.find(item => item.id === line.itemId)?.name || line.itemId}`} onClick={() => setAttached(before => before.filter(item => item.itemId !== line.itemId))}>{items.find(item => item.id === line.itemId)?.name}<MiseIcon name="x" size={14} /></button>)}</div> : null}
      <div className="counter-tools"><Button kind="ghost" disabled={saving} onClick={() => { setSearch(''); setSheet('items'); }}><MiseIcon name="plus" size={14} />{c.nameItems}</Button>{speech.supported ? <Button kind="ghost" disabled={saving || speech.listening} onClick={speech.start}><MiseIcon name="mic" size={14} />{speech.listening ? c.listening : c.sayIt}</Button> : null}</div>
      <div className="counter-keypad" role="group" aria-label={c.keypad}>{keys.map(value => <button key={value} type="button" data-key={value} className={value === '=' ? 'equals' : /[C⌫%÷×−+]/.test(value) ? 'operator' : ''} disabled={saving} aria-label={value === 'C' ? c.clear : value === '⌫' ? c.backspace : value === '=' ? c.equals : value} onClick={() => key(value)}>{value === '⌫' ? <MiseIcon name="arrowLeft" size={22} /> : value}</button>)}</div>
      <div className="counter-given"><button className="given-entry" disabled={saving} onClick={() => { setGivenInput(given === undefined ? '' : moneyInputValue(given,currency)); setSheet('given'); }}>{c.given}</button>{suggestions.map(value => <button className={`chip ${given === value ? 'selected' : ''}`} disabled={saving} key={value} aria-pressed={given === value} onClick={() => setGiven(before => before === value ? undefined : value)}>{formatMoney(value,currency)}</button>)}{given !== undefined && !suggestions.includes(given) ? <button className="chip selected" onClick={() => setGiven(undefined)}>{formatMoney(given,currency)}</button> : null}<strong>{c.change} {formatMoney(given !== undefined && amount !== null ? Math.max(0,given-amount) : 0,currency)}</strong></div>
      {given !== undefined && amount !== null && given < amount ? <p role="alert" className="form-error">{c.invalidGiven}</p> : null}
      <Button className="counter-cash" disabled={saving || amount === null || amount <= 0 || (given !== undefined && given < amount)} onClick={() => void record('cash')}><MiseIcon name="wallet" size={16} />{saving ? copy.saving : `${c.cash} ${formatMoney(amount || 0,currency)}`}</Button>
      <div className="counter-payments"><Button kind="secondary" disabled={saving || amount === null || amount <= 0} onClick={() => setSheet('payment')}>{wallets[0] || c.card}</Button><Button kind="secondary" disabled={!khataEnabled || saving || amount === null || amount <= 0} aria-describedby="baki-help" onClick={() => { speech.cancel(); setCreditDraft({expression,items:attached}); }}><MiseIcon name="clipboard" size={14} />{setup.business.marketCode === 'BD' ? c.baki : 'Credit'}</Button></div>
      <p id="baki-help" className="counter-help">{khataEnabled ? 'Credit checks the customer’s limit before saving.' : c.bakiHelp}</p><p className="counter-help">{c.percentHelp}</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}<p role="status" className="counter-message">{message}</p>
    </section><details className="counter-log" open={desktop}><summary>{c.salesLog} · {saleCount(today.length)}</summary><SalesLog sales={sales} today={today} now={now} limit={limit} saving={saving} onMore={() => setLimit(value => value+50)} onReceipt={setReceipt} onUndo={sale => void undo(sale)} /></details></div>
    {creditDraft ? <CreditSheet setup={setup} draft={creditDraft} onClose={() => setCreditDraft(null)} onRecorded={sale => { submitted.current = creditDraft.expression; setLast(sale); setExpression(''); setAttached([]); setGiven(undefined); setWho(''); setFinished(false); setMessage(''); setNow(Date.now()); }} /> : null}
    <Modal open={sheet === 'who'} title={c.who} closeLabel={copy.catalogue.close} onClose={() => setSheet(null)}><form onSubmit={event => { event.preventDefault(); setWho(name.trim()); setSheet(null); }}><div className="form-fields"><label>{c.name}<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label></div><Button type="submit">{c.useName}</Button></form></Modal>
    <Modal open={sheet === 'given'} title={c.given} closeLabel={copy.catalogue.close} onClose={() => setSheet(null)}><form onSubmit={event => { event.preventDefault(); const value = parseMoney(givenInput,currency); if (value === null || value < (amount || 0)) { setError(c.invalidGiven); return; } setGiven(value); setError(''); setSheet(null); }}><div className="form-fields"><label>{c.givenAmount}<input value={givenInput} inputMode="decimal" required onChange={event => setGivenInput(event.target.value)} /></label></div>{error ? <p className="form-error" role="alert">{error}</p> : null}<Button type="submit">{c.useAmount}</Button></form></Modal>
    <Modal open={sheet === 'items'} title={c.nameItems} closeLabel={c.done} onClose={() => setSheet(null)}><p>{c.itemsHelp}</p><label className="catalogue-search"><span className="sr-only">{c.searchItems}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={c.searchItems} /></label><div className="counter-item-list">{available.map(item => <button key={item.id} type="button" aria-pressed={attached.some(line => line.itemId === item.id)} onClick={() => attach(item)}><span>{item.name}<small>{formatMoney(item.price,currency)} / {item.unit}</small></span>{attached.some(line => line.itemId === item.id) ? <MiseIcon name="checkCircle" size={18} /> : <MiseIcon name="plus" size={18} />}</button>)}{!available.length ? <p>{copy.catalogue.noResults}</p> : null}</div></Modal>
    <Modal open={sheet === 'payment'} title={c.walletTitle} closeLabel={copy.catalogue.close} onClose={() => { if (!saving) setSheet(null); }}><p>{c.walletHelp}</p><div className="form-fields"><label>{c.paymentMethod}<select value={payment} disabled={saving} onChange={event => setPayment(event.target.value)}>{[...wallets,c.card].map(method => <option key={method}>{method}</option>)}</select></label></div>{error ? <p role="alert" className="form-error">{error}</p> : null}<Button disabled={saving} onClick={() => void record(payment === c.card ? 'card' : 'wallet',payment === c.card ? undefined : payment)}>{saving ? copy.saving : c.recordPayment}</Button></Modal>
  </div>;
}
function SalesLog({ sales,today,now,limit,saving,onMore,onReceipt,onUndo }: { sales: Sale[]; today: Sale[]; now: number; limit: number; saving: boolean; onMore: () => void; onReceipt: (sale: Sale) => void; onUndo: (sale: Sale) => void }) {
  let totals: ReturnType<typeof saleTotals> = [], error = '';
  try { totals = saleTotals(today); } catch { error = c.totalTooLarge; }
  return <div className="counter-log-content"><Card className="app-panel"><h2>{c.dayTotals}</h2>{totals.map(total => <p className="sale-total" key={`${total.currency}:${total.method}`}><span>{total.method} · {saleCount(total.count)}</span><strong>{formatMoney(total.amount,total.currency)}</strong></p>)}{!totals.length ? <p>{c.emptyLog}</p> : null}{error ? <p role="alert" className="form-error">{error}</p> : null}</Card><p className="counter-help">{c.undoHelp}</p><div className="sale-rows">{sales.slice(0,limit).map(sale => <article key={sale.id} data-voided={sale.voidedAt !== undefined}><div><strong>{formatMoney(sale.amount,sale.currency)} · {sale.methodName}</strong><small>{new Intl.DateTimeFormat('en-GB',{timeZone:sale.timezone,dateStyle:'medium',timeStyle:'short'}).format(sale.createdAt)} · {sale.who || c.walkIn}</small>{sale.voidedAt !== undefined ? <small>{c.undone}</small> : null}</div><Button kind="secondary" aria-label={`${c.receipt} ${sale.id.slice(-6)}`} onClick={() => onReceipt(sale)}><MiseIcon name="receipt" size={18} /></Button>{canUndoSale(sale,now) ? <Button kind="ghost" disabled={saving} onClick={() => onUndo(sale)}>{c.undo}</Button> : null}</article>)}</div>{sales.length > limit ? <Button kind="secondary" onClick={onMore}>{c.showMore}</Button> : null}</div>;
}
