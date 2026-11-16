import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './data/db';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { MessageHandoff } from './MessageHandoff';
import { useHandoffs } from './handoff-context';
import { receiptText } from '@mise/core/sales';
import { formatMoney } from '@mise/core/money';
import type { Sale } from '@mise/core/models';
import copy from '../../../handover/copy/app.en.json';
const c = copy.counter;
export function Receipt({ sale: initialSale, onBack, backLabel }: { sale: Sale; onBack: () => void; backLabel?:string }) {
  const handoffs=useHandoffs(),[sharing,setSharing]=useState(false);
  const sale = useLiveQuery(() => db.sales.get(initialSale.id),[initialSale.id]) || initialSale;
  const customer=useLiveQuery(()=>sale.customerId?db.customers.get(sale.customerId):undefined,[sale.customerId]);
  const text = useMemo(() => receiptText(sale), [sale]);
  const [qr, setQr] = useState(''), [error, setError] = useState(false), [manual, setManual] = useState(false), [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true; setQr(''); setError(false);
    import('qrcode').then(module => module.toDataURL(text, { margin:4, scale:6, errorCorrectionLevel:'M', color:{dark:'#141414',light:'#ffffff'} })).then(url => { if (active) setQr(url); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [text]);
  async function copyReceipt() { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setManual(true); } }
  return <section className="counter-receipt"><header><MiseIcon name="checkCircle" size={36} /><h1>{sale.voidedAt === undefined ? `${sale.method === 'credit' ? 'Added to khata' : c.paid} ${formatMoney(sale.amount,sale.currency)} · ${sale.methodName}` : sale.voidReason === 'order-cancel' ? 'Order cancelled' : c.undone}</h1><p>{sale.items.map(item => item.name).join(', ') || c.recorded}</p></header><Card className="receipt-card">{qr ? <img className="receipt-qr" src={qr} width="176" height="176" alt={c.receiptQrAlt} /> : <p role="status">{error ? c.qrError : '…'}</p>}<h2>{c.scan}</h2><p>{c.receiptHelp}</p>{handoffs?<Button kind="secondary" onClick={()=>setSharing(true)}>Share receipt</Button>:<><Button kind="secondary" onClick={() => void copyReceipt()}><MiseIcon name="clipboard" size={18} />{c.copyReceipt}</Button>{copied ? <p role="status">{c.copied}</p> : null}{manual ? <label className="manual-receipt">{c.copyManually}<textarea aria-label={c.receiptText} readOnly value={text} rows={9} autoFocus onFocus={event => event.target.select()} /></label> : <details className="receipt-text"><summary>{c.viewText}</summary><pre>{text}</pre></details>}</>}</Card>{sharing&&handoffs?<MessageHandoff title="Share receipt" draft={{source:{kind:'sale',id:sale.id},purpose:'receipt',text,target:customer?.phone?'whatsapp':'share',phone:customer?.phone}} readOnly onClose={()=>setSharing(false)}/>:null}<Button onClick={onBack}>{backLabel || c.newSale}</Button></section>;
}
