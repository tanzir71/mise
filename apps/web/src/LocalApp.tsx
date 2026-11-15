import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card, StatusWord } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { businessPacks, phoneNav } from '@mise/core/packs';
import type { SetupSnapshot } from '@mise/core/models';
import c from '../../../handover/copy/app.en.json';
import { db } from './data/db';
import { Onboarding } from './Onboarding';
import { Settings } from './Settings';
import { Catalogue } from './Catalogue';
import { Counter, CounterDayTotal } from './Counter';
import { Khata } from './Khata';
import { dailySales } from '@mise/core/sales';
import { formatMoney } from '@mise/core/money';
import { useAppUpdate } from './app-update';
import './app.css';

class StorageBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="onboarding"><h1>{c.storageError}</h1><p>{c.storageHelp}</p><Button onClick={() => location.reload()}>{c.retry}</Button></main> : this.props.children; }
}
function ShopWorkspace({ counterEnabled, khataEnabled }: { counterEnabled: boolean; khataEnabled: boolean }) {
  const setup = useLiveQuery(() => db.setup());
  if (setup === undefined) return <main className="onboarding" aria-busy="true"><p>{c.gettingStarted}…</p></main>;
  return setup ? <Shell setup={setup} counterEnabled={counterEnabled} khataEnabled={khataEnabled} /> : <Onboarding />;
}
export function LocalApp({ counterEnabled, khataEnabled }: { counterEnabled: boolean; khataEnabled: boolean }) { return <StorageBoundary><ShopWorkspace counterEnabled={counterEnabled} khataEnabled={khataEnabled} /></StorageBoundary>; }
function Shell({ setup, counterEnabled, khataEnabled }: { setup: SetupSnapshot; counterEnabled: boolean; khataEnabled: boolean }) {
  const location = useLocation();
  const inMore = location.pathname.startsWith('/catalogue') || location.pathname.startsWith('/settings');
  const inCustomer = location.pathname.startsWith('/khata/');
  const [updateReady, update] = useAppUpdate();
  const pack = businessPacks[setup.business.businessType];
  const bottom = phoneNav(setup.business.businessType);
  const desktop = [...bottom.filter(item => item.path !== '/more'), ...(counterEnabled ? [{path:'/counter',label:'Counter',icon:'wallet'}] : []), ...(khataEnabled ? [{path:'/khata',label:'Khata',icon:'clipboard'}] : []), { path: '/stock', label: pack.nav.stock, icon: 'package' }, { path: '/catalogue', label: pack['noun/catalogue'], icon: 'database' }, { path: '/more', label: c.more, icon: 'more' }].filter((item, index, all) => all.findIndex(other => other.path === item.path) === index);
  const [online, setOnline] = useState(navigator.onLine);
  // These listeners belong to this mounted workspace, not each route.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <div className="app-shell"><a className="app-skip" href="#workspace">Skip to content</a>
    <aside className="app-sidebar"><Link to="/" className="app-wordmark"><img src={`${import.meta.env.BASE_URL}mise-mark.svg`} width="24" height="24" alt="" />mise</Link><Link to="/settings/business" className="outlet-switch"><MiseIcon name="store" size={20} /><span><strong>{setup.outlet.name}</strong><small>{pack['biz/type']}</small></span><MiseIcon name="chevronDown" size={16} /></Link><nav aria-label="Main navigation">{desktop.map(item => <NavLink key={item.path} to={item.path} end><MiseIcon name={item.icon} size={18} />{item.label}</NavLink>)}</nav><div className="sidebar-bottom"><StatusWord>{c.thisDevice}</StatusWord><p>{c.localNote}</p><Link to="/settings/business">{c.settings}</Link></div></aside>
    <div className="app-main">{updateReady ? <div className="app-update" role="status"><span>{c.updateReady}</span><Button kind="secondary" onClick={update}>{c.reload}</Button></div> : null}<div className="phone-app-header">{inCustomer ? <Link to="/khata"><MiseIcon name="chevronLeft" size={18} />Khata</Link> : inMore ? <Link to="/more"><MiseIcon name="chevronLeft" size={18} />{c.more}</Link> : <Link to="/settings/business">{setup.outlet.name}<MiseIcon name="chevronDown" size={14} /></Link>}<span className="local-pill">{counterEnabled && location.pathname === '/counter' ? <><CounterDayTotal setup={setup} />{!online ? ` · ${c.offline}` : ''}</> : online ? c.online : c.offline}</span></div><main id="workspace" tabIndex={-1}><Routes><Route path="/" element={<Today setup={setup} counterEnabled={counterEnabled} />} /><Route path="/more" element={<More setup={setup} counterEnabled={counterEnabled} khataEnabled={khataEnabled} />} /><Route path="/catalogue" element={<Catalogue setup={setup} />} /><Route path="/settings/*" element={<Settings setup={setup} />} />{counterEnabled ? <Route path="/counter" element={<Counter setup={setup} online={online} khataEnabled={khataEnabled} />} /> : null}{khataEnabled ? <><Route path="/khata" element={<Khata setup={setup} />} /><Route path="/khata/:customerId" element={<Khata setup={setup} />} /></> : null}{['counter', 'orders', 'khata', 'stock', 'inbox'].filter(path => (path !== 'counter' || !counterEnabled) && (path !== 'khata' || !khataEnabled)).map(path => <Route key={path} path={`/${path}`} element={<Unavailable title={desktop.find(item => item.path === `/${path}`)?.label || path[0].toUpperCase() + path.slice(1)} />} />)}<Route path="*" element={<Navigate to="/" replace />} /></Routes></main></div>
    <nav className="app-bottom-nav" aria-label="Phone navigation">{bottom.map(item => <NavLink key={item.path} to={item.path} end className={({ isActive }) => isActive || (item.path === "/more" && inMore) || (item.path === "/khata" && inCustomer) ? "active" : ""}><MiseIcon name={item.icon} size={22} /><span>{item.label}</span></NavLink>)}</nav>
  </div>;
}
function Today({ setup, counterEnabled }: { setup: SetupSnapshot; counterEnabled: boolean }) {
  const records = useLiveQuery(() => db.sales.where('outletId').equals(setup.outlet.id).toArray(),[setup.outlet.id],[]);
  const [now,setNow] = useState(Date.now);
  useEffect(() => { const timer=setInterval(() => setNow(Date.now()),30000); return () => clearInterval(timer); },[]);
  const today = dailySales(records,setup.outlet.timezone,now).filter(sale => sale.currency === setup.outlet.currency);
  const total = today.reduce((sum,sale) => sum+BigInt(sale.amount),0n);
  const amount = total <= BigInt(Number.MAX_SAFE_INTEGER) ? formatMoney(Number(total),setup.outlet.currency) : '—';
  const samples = useLiveQuery(() => db.items.where('outletId').equals(setup.outlet.id).filter(item => item.isSample).count(), [setup.outlet.id], 0);
  return <><header className="app-page-heading"><h1>{c.today}</h1><p>{new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: setup.outlet.timezone }).format(new Date())}</p></header><Card className="app-panel welcome-panel"><StatusWord>{c.thisDevice}</StatusWord><h2>{c.welcome}</h2><p>{c.welcomeLead}</p><Link className="button button-secondary" to="/settings/business">{c.businessSettings}<MiseIcon name="arrowRight" size={16} /></Link></Card><div className="app-metrics">{[c.sales, c.orders, c.average].map(label => <Card className="app-panel" key={label}><p>{label}</p><strong>{label === c.sales && counterEnabled ? amount : '—'}</strong><small>{label === c.sales && counterEnabled ? `${today.length} ${today.length === 1 ? c.counter.sale : c.counter.count}` : label === c.sales ? c.noSales : c.noOrders}</small></Card>)}</div><div className="today-columns"><section><h2 className="group-heading">{c.needsYou}</h2><Card className="app-panel"><h3>{c.allClear}</h3><p>{c.localLead}</p></Card></section><section><h2 className="group-heading">{c.setup}</h2><div className="app-list"><Link to="/settings/business"><MiseIcon name="checkCircle" /><span>{c.businessSettings}</span><MiseIcon name="chevronRight" size={16} /></Link><Link to="/catalogue"><MiseIcon name="database" /><span>{businessPacks[setup.business.businessType]['noun/catalogue']}<small>{samples} {c.samples}</small></span><MiseIcon name="chevronRight" size={16} /></Link></div></section></div></>;
}
function More({ setup, counterEnabled, khataEnabled }: { setup: SetupSnapshot; counterEnabled: boolean; khataEnabled: boolean }) {
  const base = import.meta.env.BASE_URL.replace(/app\/$/, '');
  const groups = [{ title: c.businessGroup, rows: [...(counterEnabled ? [{path:'/counter',icon:'wallet',title:c.counter.title,subtitle:c.counter.cash}] : []), ...(khataEnabled ? [{path:'/khata',icon:'clipboard',title:'Khata and customers',subtitle:'Balances, payments and reminders'}] : []), { path: '/catalogue', icon: 'database', title: c.businessData, subtitle: businessPacks[setup.business.businessType]['noun/catalogue'] }] }, { title: c.setup, rows: [{ path: '/settings/business', icon: 'checkCircle', title: c.businessSettings, subtitle: setup.business.name }, { path: '/settings/market', icon: 'globe', title: c.marketSettings, subtitle: `${setup.business.marketCode} · ${setup.outlet.currency}` }] }];
  return <><header className="app-page-heading"><h1>{c.more}</h1></header>{groups.map(group => <section key={group.title}><h2 className="group-heading">{group.title}</h2><div className="app-list">{group.rows.map(row => <Link key={row.path} to={row.path}><span className="list-icon"><MiseIcon name={row.icon} size={18} /></span><span>{row.title}<small>{row.subtitle}</small></span><MiseIcon name="chevronRight" size={16} /></Link>)}</div></section>)}<section><h2 className="group-heading">{c.devices}</h2><div className="app-list"><a href={`${base}setup/`}><span className="list-icon"><MiseIcon name="phone" size={18} /></span><span>{c.downloads}</span><MiseIcon name="external" size={16} /></a><Link to="/whats-new"><span className="list-icon"><MiseIcon name="history" size={18} /></span><span>{c.whatsNew}</span><MiseIcon name="chevronRight" size={16} /></Link></div></section><p className="device-note">{c.localNote}</p></>;
}
function Unavailable({ title }: { title: string }) { return <><header className="app-page-heading"><h1>{title}</h1></header><Card className="app-panel"><h2>{c.emptyFeature}</h2><p>{c.emptyLead}</p><Link to="/" className="button button-secondary">{c.backToday}</Link></Card></>; }
