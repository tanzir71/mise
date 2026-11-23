import { lazy,Suspense,useEffect, useMemo, useRef, useState,type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import {
  decodeCustomerViewer,
  customerWhatsAppUrl,
} from '@mise/core/customer-link-url';
import { decodeShopPayload } from '@mise/core/public-shop-decode';
import { formatMoney } from '@mise/core/money';
import { orderFlows, orderStatusLabels } from '@mise/core/orders';
import type { OrderStatus } from '@mise/core/models';
import type { CustomerLink, CustomerOrder } from '@mise/core/customer-links';
import type { PublicShop } from '@mise/core/public-shop';
import { CustomerReadError, readCustomerLink } from './data/customer-link-read';
import './customer-link-view.css';
import {CustomerOrderEstimate} from './CustomerOrderEstimate';
import {CustomerCheckoutArea} from './CustomerCheckoutArea';
import {useCustomerCheckout,useCustomerKhata} from './customer-links-context';
const words = {
  en: {
    order: 'Order',
    khata: 'Your khata',
    checking: 'Checking…',
    check: 'Check now',
    checked: 'Checked',
    items: 'Items',
    total: 'Total',
    subtotal: 'Subtotal',
    pricedSubtotal: 'Priced items subtotal',
    delivery: 'Delivery',
    discount: 'Discount',
    price: 'The shop is checking prices.',
    estimate: 'Arrival time has not been set',
    estimateHelp: 'Contact the shop for an arrival estimate.',
    scheduled: 'Scheduled for',
    updated: 'Status updated',
    pending: 'Payment pending',
    paid: 'Payment recorded',
    credited: 'Added to khata',
    cancelled: 'Contact the shop about any payment or refund.',
    unavailable: 'Unavailable',
    instead: 'Instead of',
    accepted: 'Swap marked accepted',
    waiting: 'Swap awaiting confirmation',
    call: 'Call shop',
    message: 'Message shop',
    copyPhone: 'Copy number',
    copyMessage: 'Copy message',
    done: 'Mark done',
    contactMissing:
      'Reply to the chat where you received this link to contact the shop.',
    copied: 'Copied.',
    marked: 'Contact marked done.',
    due: 'due',
    credit: 'credit',
    settled: 'Nothing due',
    entries: 'Entries',
    empty: 'No entries yet.',
    more: 'More entries',
    newer: 'Check newer entries',
    loaded:
      'You are viewing loaded entries. Check now to refresh the complete history.',
    charge: 'Added to khata',
    payment: 'Payment received',
    adjustment: 'Adjustment',
    refund: 'Money returned',
    correction: 'Correction',
    refundHelp: 'Contact the shop to arrange payment or ask about an entry.',
    loading: 'Opening your link…',
    missing: 'This link is unavailable. Ask the shop for a current link.',
    limited: 'Please wait a moment before checking again.',
    failed: 'This link could not be checked. Connect and try again.',
  },
  bn: {
    order: 'অর্ডার',
    khata: 'আপনার খাতা',
    checking: 'দেখা হচ্ছে…',
    check: 'আবার দেখুন',
    checked: 'দেখা হয়েছে',
    items: 'পণ্য',
    total: 'মোট',
    subtotal: 'পণ্যের দাম',
    pricedSubtotal: 'দাম জানা পণ্যের উপমোট',
    delivery: 'ডেলিভারি',
    discount: 'ছাড়',
    price: 'দোকান দাম যাচাই করছে।',
    estimate: 'পৌঁছানোর সময় জানানো হয়নি',
    estimateHelp: 'সময় জানতে দোকানে যোগাযোগ করুন।',
    scheduled: 'নির্ধারিত সময়',
    updated: 'অবস্থা বদলেছে',
    pending: 'পেমেন্ট বাকি',
    paid: 'পেমেন্ট লেখা হয়েছে',
    credited: 'খাতায় যোগ হয়েছে',
    cancelled: 'পেমেন্ট বা ফেরত নিয়ে দোকানে যোগাযোগ করুন।',
    unavailable: 'পাওয়া যাচ্ছে না',
    instead: 'এর বদলে',
    accepted: 'বদলি গ্রহণ করা হয়েছে',
    waiting: 'বদলি নিশ্চিত করা বাকি',
    call: 'দোকানে কল করুন',
    message: 'দোকানে মেসেজ',
    copyPhone: 'নম্বর কপি',
    copyMessage: 'মেসেজ কপি',
    done: 'করা হয়েছে',
    contactMissing:
      'দোকানে যোগাযোগ করতে যে চ্যাটে এই লিংক পেয়েছেন সেখানে উত্তর দিন।',
    copied: 'কপি হয়েছে।',
    marked: 'যোগাযোগ করা হয়েছে।',
    due: 'বাকি',
    credit: 'জমা',
    settled: 'কোনো বাকি নেই',
    entries: 'লেনদেন',
    empty: 'এখনও কোনো লেনদেন নেই।',
    more: 'আরও লেনদেন',
    newer: 'নতুন লেনদেন দেখুন',
    loaded: 'আগে দেখা লেনদেন দেখছেন। সবশেষ তথ্যের জন্য আবার দেখুন।',
    charge: 'খাতায় যোগ হয়েছে',
    payment: 'পেমেন্ট পাওয়া গেছে',
    adjustment: 'সংশোধন',
    refund: 'টাকা ফেরত',
    correction: 'সংশোধন',
    refundHelp: 'পেমেন্ট বা কোনো লেনদেন নিয়ে জানতে দোকানে যোগাযোগ করুন।',
    loading: 'আপনার লিংক খোলা হচ্ছে…',
    missing: 'এই লিংকটি কাজ করছে না। দোকানের কাছে নতুন লিংক চান।',
    limited: 'আবার দেখার আগে একটু অপেক্ষা করুন।',
    failed: 'এখন লিংকটি দেখা যাচ্ছে না। ইন্টারনেটে যুক্ত হয়ে আবার চেষ্টা করুন।',
  },
};
const banglaStatus: Record<OrderStatus, string> = {
  new: 'নতুন',
  confirmed: 'নিশ্চিত হয়েছে',
  kitchen_seen: 'রান্নাঘর পেয়েছে',
  cooking: 'রান্না হচ্ছে',
  ready: 'প্রস্তুত',
  out: 'ডেলিভারির পথে',
  delivered: 'ডেলিভারি হয়েছে',
  to_confirm: 'নিশ্চিত করা বাকি',
  packed: 'প্যাক করা হয়েছে',
  booked: 'বুক করা হয়েছে',
  with_courier: 'কুরিয়ারে দেওয়া হয়েছে',
  returning: 'ফেরত আসছে',
  returned: 'ফেরত এসেছে',
  ordered: 'অর্ডার হয়েছে',
  making: 'তৈরি হচ্ছে',
  ready_called: 'প্রস্তুত',
  collected: 'নিয়ে যাওয়া হয়েছে',
  requested: 'অনুরোধ এসেছে',
  priced: 'দাম দেওয়া হয়েছে',
  accepted: 'গ্রহণ করা হয়েছে',
  packing: 'প্যাক করা হচ্ছে',
  delivering: 'ডেলিভারির পথে',
  done: 'সম্পন্ন',
  cancelled: 'বাতিল',
};
function contact(value: string | null): PublicShop | null {
  try {
    if (!value) return null;
    const u = new URL(value);
    if (
      u.username ||
      u.password ||
      u.search ||
      !u.pathname.endsWith('/app/s/') ||
      (u.protocol !== 'https:' &&
        !(
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(u.hostname)
        ))
    )
      return null;
    return decodeShopPayload(u.hash.slice(1));
  } catch {
    return null;
  }
}
function steps(order: CustomerOrder): OrderStatus[] {
  if (order.status === 'cancelled') return ['cancelled'];
  let flow = [...orderFlows[order.businessType]];
  if (order.type !== 'delivery')
    flow = flow.filter(
      (s) =>
        ![
          'out',
          'delivering',
          'booked',
          'with_courier',
          'returning',
          'returned',
        ].includes(s),
    );
  else if (!['returning', 'returned'].includes(order.status))
    flow = flow.filter((s) => s !== 'returning' && s !== 'returned');
  else flow = flow.filter((s) => s !== 'delivered');
  return flow.includes(order.status) ? flow : [order.status];
}
interface ViewState {
  key: string;
  data: CustomerLink | null;
  error: CustomerReadError | null;
  loading: boolean;
  checked: number;
  expanded: boolean;
  lastOrder?:CustomerOrder|null;
}
function TrackingDetails({collapsed,label,children}:{collapsed:boolean;label:string;children:ReactNode}){return collapsed?<details className="customer-tracking-details"><summary>{label}</summary>{children}</details>:children;}
function LegacyCustomerLinkView() {
  const checkoutEnabled=useCustomerCheckout();
  const route = useLocation(),
    key = route.pathname + route.hash;
  const decoded = useMemo(() => {
    try {
      return decodeCustomerViewer(
        location.pathname,
        route.hash,
        import.meta.env.BASE_URL,
      );
    } catch {
      return null;
    }
  }, [route.pathname, route.hash]);
  const [language, setLanguage] = useState<'en' | 'bn'>('en'),
    [state, setState] = useState<ViewState>({
      key: '',
      data: null,
      error: null,
      loading: true,
      checked: 0,
      expanded: false,
    }),
    [notice, setNotice] = useState(''),
    [manual, setManual] = useState('');
  const readRef = useRef<{
      key: string;
      read: (more?: boolean, background?: boolean) => Promise<void>;
    } | null>(null),
    c = words[language];
  const data = state.key === key ? state.data : null,
    lastOrder=state.key===key?state.lastOrder??null:null,
    error = state.key === key ? state.error : null,
    loading = state.key !== key || state.loading;
  useEffect(() => {
    const previous = document.title;
    document.title = 'Customer link · Mise';
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    let active = true,
      inflight = false,
      currentData: CustomerLink | null = null,
      lastReadOrder:CustomerOrder|null=null,
      expanded = false,
      retryAt = 0,
      missing = false;
    const controller = new AbortController();
    setState({
      key,
      data: null,
      error: null,
      loading: true,
      checked: 0,
      expanded: false,
    });
    setNotice('');
    setManual('');
    if (!decoded) {
      setState({
        key,
        data: null,
        error: new CustomerReadError('missing'),
        loading: false,
        checked: 0,
        expanded: false,
      });
      return () => {
        active = false;
        controller.abort();
      };
    }
    const source = { ...decoded };
    const read = async (more = false, background = false) => {
      if (
        !active ||
        inflight ||
        (background && missing) ||
        Date.now() < retryAt
      )
        return;
      inflight = true;
      setState((s) =>
        s.key === key ? { ...s, loading: true, error: null } : s,
      );
      const prior = currentData,
        after =
          more && prior?.kind === 'khata' ? prior.account.nextSequence : 0;
      try {
        let next = await readCustomerLink(source, after, 50, {
          signal: controller.signal,
        });
        if (!active) return;
        if (more) {
          if (
            prior?.kind !== 'khata' ||
            next.kind !== 'khata' ||
            next.account.id !== prior.account.id
          )
            throw new CustomerReadError('unavailable');
          next = {
            ...next,
            account: {
              ...next.account,
              entries: [...prior.account.entries, ...next.account.entries],
            },
          };
          expanded = true;
        } else if (
          background &&
          expanded &&
          prior?.kind === 'khata' &&
          next.kind === 'khata'
        ) {
          if (next.account.id !== prior.account.id)
            throw new CustomerReadError('unavailable');
          next = {
            ...next,
            account: {
              ...prior.account,
              balance: next.account.balance,
              customerName: next.account.customerName,
            },
          };
        } else expanded = false;
        currentData = next;
        lastReadOrder=next.kind==='order'?next.order:null;
        missing = false;
        setState({
          key,
          data: next,
          error: null,
          loading: false,
          checked: Date.now(),
          expanded,
          lastOrder:lastReadOrder,
        });
      } catch (e) {
        if (active) {
          const failure =
            e instanceof CustomerReadError
              ? e
              : new CustomerReadError('unavailable');
          retryAt = Date.now() + failure.retryAfter * 1000;
          missing = failure.kind === 'missing';
          currentData = null;
          expanded = false;
          setState({
            key,
            data: null,
            lastOrder:lastReadOrder,
            error: failure,
            loading: false,
            checked: 0,
            expanded: false,
          });
        }
      } finally {
        inflight = false;
      }
    };
    readRef.current = { key, read };
    void read();
    const interval = setInterval(() => {
        if (!document.hidden && navigator.onLine) void read(false, true);
      }, 10000),
      wake = () => {
        if (!document.hidden && navigator.onLine) void read(false, true);
      };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      if (readRef.current?.key === key) readRef.current = null;
    };
  }, [key, decoded]);
  const publicShop = data ? contact(data.shop.url) : null;
  const when = (at: number, timezone: string) =>
    new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  const money = (amount: number, currency: string) => (
    <span className="customer-money">{formatMoney(amount, currency)}</span>
  );
  const status = (s: OrderStatus) =>
    language === 'bn' ? banglaStatus[s] : orderStatusLabels[s];
  const question =
    data?.kind === 'order'
      ? language === 'bn'
        ? `আমার ${data.order.number} অর্ডার সম্পর্কে জানতে চাই।`
        : `I have a question about order ${data.order.number}.`
      : data?.kind === 'khata'
        ? language === 'bn'
          ? `${data.account.customerName} · আমার খাতার লেনদেন সম্পর্কে জানতে চাই।`
          : `${data.account.customerName} · I have a question about my khata entries.`
        : '';
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(c.copied);
      setManual('');
    } catch {
      setManual(value);
    }
  }
  const refresh = (more = false) => {
    const value = readRef.current;
    if (value?.key === key) void value.read(more);
  };
  return (
    <main className={'customer-view'+(checkoutEnabled&&data?.kind==='order'&&data.order.businessType==='corner_shop'?' customer-view-checkout':'')} lang={language === 'bn' ? 'bn' : 'en'}>
      <header className="customer-view-header">
        <span className="customer-view-mark" aria-hidden="true">
          m
        </span>
        <div>
          <p>{data?.shop.name ?? 'Mise'}</p>
          {data ? (
            <small>{publicShop?.hours || data.shop.outletName}</small>
          ) : null}
          {publicShop?.address ? <small>{publicShop.address}</small> : null}
        </div>
        <div className="customer-language" role="group" aria-label="Language">
          <button
            aria-pressed={language === 'en'}
            onClick={() => setLanguage('en')}
          >
            EN
          </button>
          <button
            aria-pressed={language === 'bn'}
            onClick={() => setLanguage('bn')}
            lang="bn"
          >
            বাংলা
          </button>
        </div>
      </header>
      {!data ? (<>
        <Card className="customer-view-error">
          <h1>
            {loading
              ? c.loading
              : error?.kind === 'missing'
                ? c.missing
                : error?.kind === 'limited'
                  ? c.limited
                  : c.failed}
          </h1>
          {!loading && decoded ? (
            <Button kind="secondary" onClick={() => refresh()}>
              {c.check}
            </Button>
          ) : null}
        </Card>
        {decoded&&lastOrder?<CustomerCheckoutArea source={decoded} order={lastOrder} connected={false} language={language} onConfirmed={()=>refresh()}>{null}</CustomerCheckoutArea>:null}
        {!loading?<p className="customer-view-help">{c.contactMissing}</p>:null}
        </>
      ) : (
        <>
          <div className="customer-view-check">
            <span>
              {loading
                ? c.checking
                : c.checked +
                  ' ' +
                  new Intl.DateTimeFormat(
                    language === 'bn' ? 'bn-BD' : 'en-GB',
                    { hour: '2-digit', minute: '2-digit' },
                  ).format(state.checked)}
            </span>
            <Button kind="ghost" disabled={loading} onClick={() => refresh()}>
              {c.check}
            </Button>
          </div>
          {data.kind === 'order' ? (
            <>
              <Card className="customer-order-status">
                <p>
                  {c.order} {data.order.number}
                </p>
                <h1 aria-live="polite">{status(data.order.status)}</h1>
                <TrackingDetails collapsed={checkoutEnabled&&data.order.businessType==='corner_shop'} label={language==='bn'?'সময় ও বিস্তারিত':'Timing and details'}>
                {data.order.type==='dine_in'&&data.order.table?<p>{data.order.table}</p>:null}
                <p>
                  {c.updated}{' '}
                  {when(data.order.statusChangedAt, data.order.timezone)}
                </p>
                {data.order.scheduledFor !== null ? (
                  <p>
                    {c.scheduled}{' '}
                    {when(data.order.scheduledFor, data.order.timezone)}
                  </p>
                ) : null}
                <CustomerOrderEstimate order={data.order} language={language}/>
                </TrackingDetails>
                <ol
                  className="customer-order-steps"
                  aria-label={language === 'bn' ? 'অর্ডারের ধাপ' : 'Order steps'}
                >
                  {steps(data.order).map((step, index) => {
                    const at = steps(data.order).indexOf(data.order.status);
                    return (
                      <li
                        key={step}
                        className={
                          index === at ? 'current' : index < at ? 'past' : ''
                        }
                        aria-current={
                          step === data.order.status ? 'step' : undefined
                        }
                      >
                        <span>{checkoutEnabled&&data.order.businessType==='corner_shop'&&step==='requested'?(language==='bn'?'পাঠানো হয়েছে':'Sent'):status(step)}</span>
                      </li>
                    );
                  })}
                </ol>
              </Card>
              <CustomerCheckoutArea source={decoded} order={data.order} language={language} onConfirmed={()=>refresh()}><Card className="customer-order-lines">
                <h2>{c.items}</h2>
                <ul>
                  {data.order.lines.map((line) => (
                    <li
                      key={line.id}
                      className={line.unavailable ? 'unavailable' : ''}
                    >
                      <div>
                        <strong>
                          {line.qty} × {line.name}
                        </strong>
                        <small>
                          {line.unit}
                          {line.unavailable ? ' · ' + c.unavailable : ''}
                        </small>
                        {line.note ? <p>{line.note}</p> : null}
                        {line.substitution ? (
                          <p>
                            {c.instead} {line.substitution.from} ·{' '}
                            {line.substitution.accepted
                              ? c.accepted
                              : c.waiting}
                          </p>
                        ) : null}
                      </div>
                      <span>
                        {line.unitPrice === null
                          ? '—'
                          : money(line.lineTotal!, data.order.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <dl>
                  {data.order.total!==null||data.order.lines.some(line=>!line.unavailable&&line.unitPrice!==null)?<div>
                    <dt>{data.order.total===null?c.pricedSubtotal:c.subtotal}</dt>
                    <dd>{money(data.order.subtotal, data.order.currency)}</dd>
                  </div>:null}
                  {data.order.deliveryFee > 0 ? (
                    <div>
                      <dt>{c.delivery}</dt>
                      <dd>
                        {money(data.order.deliveryFee, data.order.currency)}
                      </dd>
                    </div>
                  ) : null}
                  {data.order.discount > 0 ? (
                    <div>
                      <dt>{c.discount}</dt>
                      <dd>
                        −{money(data.order.discount, data.order.currency)}
                      </dd>
                    </div>
                  ) : null}
                  <div className="customer-order-total">
                    <dt>{c.total}</dt>
                    <dd>
                      {data.order.total === null
                        ? '—'
                        : money(data.order.total, data.order.currency)}
                    </dd>
                  </div>
                </dl>
                <p>
                  {data.order.total === null
                    ? c.price
                    : data.order.paymentStatus === 'paid'
                      ? c.paid
                      : data.order.paymentStatus === 'credited'
                        ? c.credited
                        : c.pending}
                </p>
                {data.order.status === 'cancelled' ? (
                  <p>{c.cancelled}</p>
                ) : null}
              </Card></CustomerCheckoutArea>
            </>
          ) : (
            <>
              <Card className="customer-khata-balance">
                <p>{c.khata}</p>
                <h1>
                  {data.account.balance === 0 ? (
                    c.settled
                  ) : (
                    <>
                      {money(
                        Math.abs(data.account.balance),
                        data.account.currency,
                      )}{' '}
                      {data.account.balance < 0 ? c.credit : c.due}
                    </>
                  )}
                </h1>
                <p>{data.account.customerName}</p>
                <p>{c.refundHelp}</p>
              </Card>
              <section className="customer-khata-entries">
                <h2>{c.entries}</h2>
                {state.expanded ? <p>{c.loaded}</p> : null}
                <Card>
                  {!data.account.entries.length ? <p>{c.empty}</p> : null}
                  <ul>
                    {data.account.entries.map((entry) => (
                      <li key={entry.id}>
                        <div>
                          <strong>
                            {entry.type === 'payment'
                              ? c.payment
                              : entry.type === 'refund'
                                ? c.refund
                                : entry.type === 'adjustment'
                                  ? c.adjustment
                                  : c.charge}
                          </strong>
                          <small>
                            {when(entry.at, data.account.timezone)}
                            {entry.methodName ? ' · ' + entry.methodName : ''}
                            {entry.reversalOf ? ' · ' + c.correction : ''}
                          </small>
                        </div>
                        <span>
                          {entry.delta > 0 ? '+' : entry.delta < 0 ? '−' : ''}
                          {money(
                            entry.type === 'refund'
                              ? entry.amount
                              : Math.abs(entry.delta),
                            data.account.currency,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {data.account.hasMore || state.expanded ? (
                    <Button
                      kind="secondary"
                      disabled={loading}
                      onClick={() => refresh(true)}
                    >
                      {data.account.hasMore ? c.more : c.newer}
                    </Button>
                  ) : null}
                </Card>
              </section>
            </>
          )}
          {publicShop ? (
            <section
              className="customer-view-contact"
              aria-label={language === 'bn' ? 'দোকানে যোগাযোগ' : 'Contact shop'}
            >
              <div>
                <a
                  className="button button-secondary"
                  href={'tel:' + publicShop.phone}
                >
                  {checkoutEnabled?<img src={import.meta.env.BASE_URL+'checkout-assets/phone.svg'} width="16" height="16" alt=""/>:null}{c.call}
                </a>
                <Button
                  kind="secondary"
                  onClick={() => void copy(publicShop.phone)}
                >
                  {c.copyPhone}
                </Button>
              </div>
              <div>
                <a
                  className="button button-secondary"
                  href={
                    customerWhatsAppUrl(publicShop.phone, question) ??
                    'https://wa.me/' + publicShop.phone.slice(1)
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {checkoutEnabled?<img src={import.meta.env.BASE_URL+'checkout-assets/message.svg'} width="16" height="16" alt=""/>:null}{c.message}
                </a>
                <Button kind="secondary" onClick={() => void copy(question)}>
                  {c.copyMessage}
                </Button>
              </div>
              <Button kind="ghost" onClick={() => setNotice(c.marked)}>
                {c.done}
              </Button>
            </section>
          ) : (
            <p className="customer-view-help">{c.contactMissing}</p>
          )}
        </>
      )}
      {manual ? (
        <label className="customer-view-manual">
          {language === 'bn' ? 'বেছে কপি করুন' : 'Select and copy'}
          <textarea
            readOnly
            value={manual}
            rows={3}
            onFocus={(event) => event.target.select()}
          />
        </label>
      ) : null}
      <p className="customer-view-notice" role="status">
        {notice}
      </p>
      {checkoutEnabled&&data?.kind==='order'&&data.order.businessType==='corner_shop'?<div id="customer-checkout-footer"/>:null}
    </main>
  );
}

const ModernCustomerKhata=lazy(()=>import('./CustomerKhataView').then(m=>({default:m.CustomerKhataView})));
export function CustomerLinkView(){const route=useLocation(),khata=useCustomerKhata();return khata&&route.pathname.startsWith('/k/')?<Suspense fallback={<main className="customer-view" aria-busy="true"><p>Opening your khata…</p></main>}><ModernCustomerKhata key={route.pathname+route.hash}/></Suspense>:<LegacyCustomerLinkView/>;}
