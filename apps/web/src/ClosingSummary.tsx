import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, StatusWord } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { canUndoClosing, daySummaryText } from '@mise/core/closing';
import { formatMoney } from '@mise/core/money';
import type { DayClosing, SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { errorText } from './khata-data';
import { cashMovementHelp, closingTime, paymentName, signedMoney } from './today-data';
import { MessageHandoff } from './MessageHandoff';
import { useHandoffs } from './handoff-context';
import './today.css';

function SummaryContent({record}: {record:DayClosing}) {
  const s = record.summary, money = (amount:number) => formatMoney(amount,record.currency);
  const values = [['Sales',money(s.sales)],['Number of sales',String(s.saleCount)],['Orders',String(s.orderCount)],...s.split.map(row => [paymentName(row.method),money(row.amount)]),['Credit given',money(s.creditGiven)],['Credit collected (net)',money(s.creditCollected)],['Retained cash receipts',money(s.cashSales)],['Cash khata collections',money(s.cashCollections)],['Cash refunds',money(s.cashRefunds)],['Recorded cash before closing',money(record.expectedCash)],['Counted cash',money(record.countedCash)],['Difference',signedMoney(record.difference,record.currency)]];
  return <article className="day-summary-content"><header><h1 className="print-only">Day summary</h1><p className="closing-day">{record.day} · {record.currency}</p><h2>{s.shopName}</h2>{s.outletName !== s.shopName ? <p>{s.outletName}</p> : null}<StatusWord>{record.voidedAt === undefined ? 'Saved closing' : 'Closing undone'}</StatusWord></header><p>Totals at {closingTime(record.createdAt,record.timezone)} · {record.timezone}. This is a saved snapshot.</p><dl className="closing-facts">{values.map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{record.addedWalkIn > 0 ? <p>{money(record.addedWalkIn)} {record.voidedAt === undefined ? 'added' : 'was added'} as one walk-in sale.{record.voidedAt !== undefined ? ' That sale was reversed with this closing.' : ''}</p> : null}{record.note ? <section className="closing-note"><h3>Closing note</h3><p>{record.note}</p></section> : null}<footer><p>{cashMovementHelp}</p><p>Recorded by {record.createdByName} · {closingTime(record.createdAt,record.timezone)} · {record.timezone}</p></footer></article>;
}
export function ClosingSummary({id,outletId,now}: {id:string;outletId:string;now:number}) {
  const handoffs=useHandoffs(),[sharing,setSharing]=useState(false);
  const record = useLiveQuery(async () => (await db.dayClosings.get(id)) || null,[id]), [manual,setManual] = useState(false), [message,setMessage] = useState(''), [error,setError] = useState(''), [saving,setSaving] = useState(false), busy = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {panel.current?.focus();},[record?.id]);
  if (record === undefined) return <p aria-busy="true">Loading saved summary…</p>;
  if (!record || record.outletId !== outletId) return <p>Day summary not found for this shop.</p>;
  const text = daySummaryText(record);
  async function copy() {try {await navigator.clipboard.writeText(text);setMessage('Day summary copied.');}catch {setManual(true);setMessage('Select and copy the summary below.');}}
  async function share() {try {await navigator.share({title:`Day summary · ${record!.day}`,text});setMessage('Share sheet opened.');}catch(error){if (error instanceof Error && error.name === 'AbortError') return;setManual(true);setMessage('Sharing is unavailable. Copy the summary below.');}}
  async function undo() {if (busy.current) return;busy.current = true;setSaving(true);setError('');try {await db.undoDayClosing(id);setMessage('Closing undone. Other sales and records are unchanged.');}catch(error){setError(errorText(error));}finally{busy.current = false;setSaving(false);}}
  return <div ref={panel} tabIndex={-1} className="closing-summary"><SummaryContent record={record} /><div className="closing-actions">{handoffs?<Button kind="secondary" onClick={()=>setSharing(true)}>Share summary</Button>:<><Button kind="secondary" onClick={() => void copy()}><MiseIcon name="copy" size={16} />Copy summary</Button>{typeof navigator.share === 'function' ? <Button kind="secondary" onClick={() => void share()}><MiseIcon name="share" size={16} />Share summary</Button> : null}</>}<Link className="button button-secondary" to={`/closing/${record.id}/print`}><MiseIcon name="download" size={16} />Print / Save PDF</Link></div>{sharing&&handoffs?<MessageHandoff title="Share day summary" draft={{source:{kind:'closing',id:record.id},purpose:'summary',text,target:'share'}} readOnly onClose={()=>setSharing(false)}/>:null}{manual ? <label className="closing-manual">Copy by hand<textarea aria-label="Copy by hand" autoFocus rows={7} readOnly value={text} onFocus={event => event.target.select()} /></label> : null}{message ? <p role="status">{message}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<footer className="sheet-actions">{canUndoClosing(record,now) ? <Button kind="secondary" disabled={saving} onClick={() => void undo()}>{saving ? 'Undoing…' : 'Undo this closing'}</Button> : <p className="today-help">{record.voidedAt !== undefined ? 'This closing has been undone.' : 'Undo is available on the same shop day only.'}</p>}</footer></div>;
}
export function ClosingPrint({setup}: {setup:SetupSnapshot}) {
  const {id} = useParams(), result = useLiveQuery(async () => (id ? await db.dayClosings.get(id) : undefined) || null,[id]), [error,setError] = useState('');
  useEffect(() => {if (!result || result.outletId !== setup.outlet.id) return;const before = document.title;document.title = `Day summary - ${result.day} - ${result.summary.shopName}`;return () => {document.title = before;};},[result,setup.outlet.id]);
  async function print() {try {await document.fonts.ready;window.print();}catch {setError('Printing is unavailable here. Return to Today to copy the day summary.');}}
  return <div className="closing-print"><header className="app-page-heading no-print"><h1>Day summary</h1><p>Choose Save as PDF in your browser’s print options to keep or share this summary.</p><div className="closing-actions"><Button disabled={!result || result.outletId !== setup.outlet.id} onClick={() => void print()}><MiseIcon name="download" size={16} />Print / Save PDF</Button><Link className="button button-secondary" to="/">Back to Today</Link></div>{error ? <p role="alert">{error}</p> : null}</header>{result === undefined ? <p aria-busy="true">Loading saved summary…</p> : result && result.outletId === setup.outlet.id ? <SummaryContent record={result} /> : <p>Day summary not found for this shop.</p>}</div>;
}
