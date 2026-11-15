import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card, StatusWord } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { businessPacks } from '@mise/core/packs';
import { editableOrderPrices, isOrderFinished, nextOrderStatuses, orderFlows, orderSourceLabels, orderStatusLabels } from '@mise/core/orders';
import { orderAgeMinutes, orderIsLate, searchOrders } from '@mise/core/order-views';
import type { Order, OrderStatus, SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { errorText } from './khata-data';
import { advanceLabel, fulfilmentLabel, orderColumn, orderTone, paymentLabel } from './order-ui';
import { OrderDetail } from './OrderDetail';
import { OrderForm } from './OrderForm';
import { OrderPricing } from './OrderPricing';
import { OrderHandoff } from './OrderHandoff';
import './orders.css';

type View = 'live'|'scheduled'|'history';
export function Orders({setup}: {setup:SetupSnapshot}) {
  const {'*':path = ''} = useParams(), navigate = useNavigate(), [id,action] = path.split('/');
  const [query,setQuery] = useState(''), [view,setView] = useState<View>('live'), [status,setStatus] = useState<OrderStatus|'all'|'to-price'>('all');
  const [now,setNow] = useState(Date.now), [saving,setSaving] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState(''), [warning,setWarning] = useState(false), [minutes,setMinutes] = useState(String(setup.outlet.orderWarningMinutes || 15)), [contact,setContact] = useState<Order|null>(null), busy = useRef(false);
  const data = useLiveQuery(async () => {const [orders,members] = await Promise.all([db.orders.where('outletId').equals(setup.outlet.id).toArray(),db.members.where('businessId').equals(setup.business.id).toArray()]);return {orders,members};},[setup.outlet.id,setup.business.id]);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),15000);return () => clearInterval(timer);},[]);
  const records = data?.orders || [], open = records.filter(order => !isOrderFinished(order) || Boolean(order.payment.cancellation?.refundDue));
  const scheduled = open.filter(order => Boolean(order.scheduledFor && order.scheduledFor > now));
  const pool = view === 'history' ? records.filter(isOrderFinished) : view === 'scheduled' ? scheduled : open.filter(order => !order.scheduledFor || order.scheduledFor <= now);
  const searched = searchOrders(pool,query), visible = status === 'to-price' ? searched.filter(order => order.total === null) : status === 'all' ? searched : searched.filter(order => order.status === status);
  const statuses = [...new Set([...orderFlows[setup.business.businessType],...pool.map(order => order.status)])];
  const selected = id && id !== 'new' ? records.find(order => order.id === id) : visible[0];
  const owner = (order:Order) => data?.members.find(member => member.id === order.handledBy)?.name || setup.owner.name;
  const columns = setup.business.businessType === 'restaurant' ? ['New · confirm','Kitchen has it','Ready','Out / returns'] : setup.business.businessType === 'corner_shop' ? ['Requested · price','Accepted · packing','Ready','Delivering / returns'] : setup.business.businessType === 'food_stall' ? ['Ordered','Making','Ready · call out','Finished / refunds'] : ['New · confirm','Preparing','Packed · booked','With courier / returns'];
  async function write(operation:() => Promise<unknown>,success:string,after?:() => void) {
    if (busy.current) return;busy.current = true;setSaving(true);setError('');
    try {await operation();setMessage(success);after?.();}catch(error){setError(errorText(error));}finally{busy.current = false;setSaving(false);}
  }
  if (id === 'new') return <OrderForm setup={setup} onSaved={order => navigate(`/orders/${order.id}`)} onCancel={() => navigate('/orders')} />;
  if (id && !data) return <p aria-busy="true">Loading order…</p>;
  if (id && !selected) return <Card className="app-panel"><h1>Order not found</h1><Link to="/orders">Back to orders</Link></Card>;
  if (selected && action === 'edit') return <OrderForm key={selected.id} setup={setup} order={selected} onSaved={order => navigate(`/orders/${order.id}`)} onCancel={() => navigate(`/orders/${selected.id}`)} />;
  if (selected && action === 'price') return editableOrderPrices(selected) ? <><OrderPricing key={selected.id} order={selected} onBack={() => navigate(`/orders/${selected.id}`)} onQuote={order => {setContact(order);navigate(`/orders/${order.id}`);}} /><Modal open={Boolean(contact)} variant="sheet" title="Share order / price" closeLabel="Close" onClose={() => setContact(null)}>{contact ? <OrderHandoff key={contact.id} order={contact} setup={setup} onDone={() => setContact(null)} /> : null}</Modal></> : <Card className="app-panel"><p>Prices cannot be changed at this stage.</p><Link to={`/orders/${selected.id}`}>Back to order</Link></Card>;
  function card(order:Order) {
    const late = orderIsLate(order,setup.outlet.orderWarningMinutes || 15,now), next = nextOrderStatuses(order)[0], corner = order.businessType === 'corner_shop';
    return <article key={order.id} className={`order-card${late ? ' late' : ''}${selected?.id === order.id ? ' selected' : ''}${corner ? ' corner' : ''}`} aria-label={`Queue order ${order.number}`} data-order-id={order.id} data-status={order.status}><header><Link to={`/orders/${order.id}`}><strong>{corner ? order.customer.name : order.number}</strong>{corner ? <small>{order.number}</small> : <span>{orderSourceLabels[order.source]} · {fulfilmentLabel(order)}</span>}</Link><span className="order-age">{orderAgeMinutes(order,now)} min</span></header>
      <p className={corner && order.sourceText ? 'order-original-text' : ''}>{corner && order.sourceText ? order.sourceText : order.lines.map(line => `${line.qty}× ${line.name}${line.unavailable ? ' (out of stock)' : ''}`).join(', ')}</p>{corner ? <small>{orderSourceLabels[order.source]} · {fulfilmentLabel(order)}{order.address ? ` · ${order.address}` : ''}</small> : null}<div className="order-card-status"><StatusWord tone={orderTone(order.status)}>{orderStatusLabels[order.status]}</StatusWord><small>Handled by {owner(order)}</small></div><small>{paymentLabel(order)}</small>
      <footer>{order.total === null && editableOrderPrices(order) ? <Link className="button button-primary" to={`/orders/${order.id}/price`}><MiseIcon name="calculator" size={14} />Price it</Link> : next ? <Button kind="secondary" disabled={saving} onClick={() => void write(() => db.changeOrderStatus(order.id,next,order.revision),`${order.number}: ${orderStatusLabels[next]}.`)}>{advanceLabel(next)}</Button> : null}<Button kind="ghost" onClick={() => setContact(order)}><MiseIcon name="message" size={14} />Message</Button><Link className="order-open" to={`/orders/${order.id}`} aria-label={`Open ${order.number}`}><MiseIcon name="chevronRight" size={18} /></Link></footer></article>;
  }
  return <div className={`orders-page${id ? ' has-selection' : ''}`} aria-busy={!data}><div className="orders-queue-heading"><header className="app-page-heading"><div><h1>Orders</h1><p>{open.length} open · {businessPacks[setup.business.businessType]['biz/type']} · this device</p></div><Link className="button button-primary" to="/orders/new"><MiseIcon name="plus" size={16} />New order</Link></header><div className="order-view-tabs" role="group" aria-label="Order views">{([{id:'live',label:'Live queue'},{id:'scheduled',label:`Scheduled · ${scheduled.length}`},{id:'history',label:'History'}] as {id:View;label:string}[]).map(item => <button type="button" key={item.id} aria-pressed={view === item.id} className={view === item.id ? 'selected' : ''} onClick={() => {setView(item.id);setStatus('all');}}>{item.label}</button>)}<Button kind="ghost" onClick={() => {setMinutes(String(setup.outlet.orderWarningMinutes || 15));setWarning(true);}}><MiseIcon name="clock" size={16} /><span className="order-warning-label">Warning time</span></Button></div>
    {setup.business.businessType !== 'corner_shop' ? <p className="order-desk"><MiseIcon name="eye" size={14} />{setup.owner.name} on the desk · statuses recorded on this device</p> : null}
    <div className="order-filters" role="group" aria-label="Order status filters"><button type="button" className={`chip${status === 'all' ? ' selected' : ''}`} aria-pressed={status === 'all'} onClick={() => setStatus('all')}>All {searched.length}</button>{setup.business.businessType === 'corner_shop' || searched.some(order => order.total === null) ? <button type="button" className={`chip${status === 'to-price' ? ' selected' : ''}`} aria-pressed={status === 'to-price'} onClick={() => setStatus('to-price')}>To price {searched.filter(order => order.total === null).length}</button> : null}{statuses.map(value => <button type="button" key={value} className={`chip${status === value ? ' selected' : ''}`} aria-pressed={status === value} onClick={() => setStatus(value)}>{orderStatusLabels[value]} {searched.filter(order => order.status === value).length}</button>)}</div>
    <label className="order-input-icon order-queue-search"><MiseIcon name="search" size={16} /><span className="sr-only">Search orders</span><input type="search" placeholder="Search order, name or phone" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    <div className="orders-workspace"><div className="order-board">{[0,1,2,3].map(index => {const group = visible.filter(order => orderColumn(order) === index);return <section className="order-column" key={index}><header><h2>{view === 'history' ? index === 3 ? 'Finished orders' : columns[index] : columns[index]}</h2><span>{group.length}</span></header>{group.map(card)}</section>;})}{data && !visible.length ? <Card className="order-empty"><h2>{query ? 'No matching orders' : view === 'history' ? 'No finished orders yet' : view === 'scheduled' ? 'Nothing scheduled' : 'No orders here yet'}</h2><p>{query ? 'Try a name, phone number, order number or item.' : 'Record a call or walk-in with New order.'}</p></Card> : null}</div><aside className="order-detail-panel">{selected ? <OrderDetail key={selected.id} order={selected} setup={setup} panel /> : <Card className="order-empty"><p>Select an order to see its details.</p></Card>}</aside></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}<p className="order-write-status" role="status">{message}</p>
    <Modal open={warning} variant="sheet" title="Waiting order warning" closeLabel="Close" onClose={() => {if (!busy.current) setWarning(false);}}><form className="khata-form" onSubmit={event => {event.preventDefault();void write(() => db.saveOrderWarning(Number(minutes)),'Warning time saved.',() => setWarning(false));}}><label>Highlight after (minutes)<input required type="number" min="1" max="1440" value={minutes} onChange={event => setMinutes(event.target.value)} /></label><p>Waiting orders show a coloured left bar after this time. Future scheduled orders wait until they are due.</p>{error ? <p role="alert" className="form-error">{error}</p> : null}<Button type="submit" disabled={saving}>Save warning time</Button></form></Modal>
    <Modal open={Boolean(contact)} variant="sheet" title="Share order / price" closeLabel="Close" onClose={() => setContact(null)}>{contact ? <OrderHandoff key={contact.id} order={contact} setup={setup} onDone={() => {setContact(null);setMessage('Contact recorded.');}} /> : null}</Modal>
  </div>;
}
