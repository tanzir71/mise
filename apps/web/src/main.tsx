import { CustomerLinksContext,PublicOrdersContext,CustomerCheckoutContext,CustomerKhataContext } from './customer-links-context';
import React, { lazy, Suspense } from 'react';
import {StaffTeamContext} from './staff-context';
import {OwnerTasksContext} from './owner-tasks-context';
import {LiveStoreContext} from './live-store-context';
import {OcrContext} from './ocr-context';
import {PaymentTextContext} from './payment-text-context';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import '@mise/ui/tokens.css';
import './style.css';
import './app-install';
import '@mise/ui/fonts.css';
import '@mise/ui/primitives.css';
import { flagEnabled } from '@mise/core/flags';
import { HandoffContext } from './handoff-context';
import changelog from '../../../CHANGELOG.md?raw';
import appCopy from '../../../handover/copy/app.en.json';

const StaffLinkView=lazy(()=>import('./StaffLinkView').then(module=>({default:module.StaffLinkView})));
const CustomerLinkView=lazy(()=>import('./CustomerLinkView').then(module=>({default:module.CustomerLinkView})));
const customerPath=location.pathname.startsWith(import.meta.env.BASE_URL)&&/^(?:[tk]|me)(?:\/|$)/i.test(location.pathname.slice(import.meta.env.BASE_URL.length));
const Gallery = lazy(() => import('./Gallery').then(module => ({ default: module.Gallery })));
const LocalApp = lazy(() => import('./LocalApp').then(module => ({ default: module.LocalApp })));
const SharedScreen=lazy(()=>import('./SharedScreen').then(module=>({default:module.SharedScreen})));
const ScreenProfileGuard=lazy(()=>import('./ScreenProfileGuard').then(module=>({default:module.ScreenProfileGuard})));
const OwnerTaskRecovery=lazy(()=>import('./OwnerTaskRecovery').then(module=>({default:module.OwnerTaskRecovery})));
const UrgentInboxCleanup=lazy(()=>import('./UrgentInboxCleanup').then(module=>({default:module.UrgentInboxCleanup})));
const DeskNotificationCleanup=lazy(()=>import('./DeskNotificationCleanup').then(module=>({default:module.DeskNotificationCleanup})));
let screenSetupHash='',screenLinkBlocked=false;
if((location.pathname===import.meta.env.BASE_URL+'screen'||location.pathname.startsWith(import.meta.env.BASE_URL+'screen/'))&&location.hash){
  const original=location.hash;try{history.replaceState(history.state,'',location.pathname+location.search);screenSetupHash=original;}catch{screenLinkBlocked=true;}
}

const base = import.meta.env.DEV ? (import.meta.env.VITE_LANDING_ORIGIN || `http://127.0.0.1:4321${import.meta.env.BASE_URL.replace(/app\/$/, '')}`) : import.meta.env.BASE_URL.replace(/app\/$/, '');
const markUrl = `${import.meta.env.BASE_URL}mise-mark.svg`;
let storedFlags = '';
try { if(!customerPath)storedFlags = localStorage.getItem('mise.flags') || ''; } catch { /* The gallery remains opt-in without storage. */ }
const showGallery = flagEnabled('uiGallery', location.search, storedFlags);
const showLocalApp = flagEnabled('localApp', location.search, storedFlags);
const showCounter = flagEnabled('counter', location.search, storedFlags);
const showKhata = flagEnabled('khata', location.search, storedFlags);
const showOrders = flagEnabled('orders', location.search, storedFlags);
const showStock = flagEnabled('stock', location.search, storedFlags);
const showToday = flagEnabled('today', location.search, storedFlags);
const showExports = flagEnabled('exports', location.search, storedFlags);
const showPwa = flagEnabled('pwa', location.search, storedFlags);
const showShopLinks = flagEnabled('shopLinks', location.search, storedFlags);
const showPasteOrders = flagEnabled('pasteOrders', location.search, storedFlags);
const showQrPosters = flagEnabled('qrPosters', location.search, storedFlags);
const showHandoffs = flagEnabled('handOffs', location.search, storedFlags);
const showShareTarget=flagEnabled('shareTarget',location.search,storedFlags);
const showOcr=flagEnabled('ocr',location.search,storedFlags);
const showPaymentText=flagEnabled('paymentText',location.search,storedFlags);
const showCustomerLinks=flagEnabled('customerLinks',location.search,storedFlags);
const showCustomerKhata=flagEnabled('customerKhata',location.search,storedFlags);
const showPublicOrders=flagEnabled('publicOrders',location.search,storedFlags);
const showStaffTeam=flagEnabled('staffTeam',location.search,storedFlags);
const showOwnerTasks=flagEnabled('ownerTasks',location.search,storedFlags);
const showLiveStore=flagEnabled('liveStore',location.search,storedFlags);
const showCloudSync=flagEnabled('cloudSync',location.search,storedFlags);
const showKitchenScreen=flagEnabled('kitchenScreen',location.search,storedFlags);
const showKitchenAlarms=flagEnabled('kitchenAlarms',location.search,storedFlags);
const showDeviceAccess=showStaffTeam||showKitchenScreen||flagEnabled('deviceAccess',location.search,storedFlags);
const showCloudSetup=(!customerPath&&(showCustomerLinks||showCustomerKhata||showPublicOrders||showStaffTeam||showLiveStore||showOwnerTasks))||showKitchenAlarms||showDeviceAccess||showCloudSync||flagEnabled('cloudSetup',location.search,storedFlags);
if(showCloudSetup&&!customerPath)try{localStorage.setItem('mise.flags',JSON.stringify({...JSON.parse(storedFlags||'{}'),cloudSetup:true,...(showCustomerLinks?{customerLinks:true}:{}),...(showPublicOrders?{publicOrders:true}:{}),...(showCustomerKhata?{customerKhata:true}:{}),...(showStaffTeam?{staffTeam:true}:{}),...(showLiveStore?{liveStore:true}:{}),...(showOwnerTasks?{ownerTasks:true}:{}),...(showDeviceAccess?{deviceAccess:true}:{}),...(showCloudSync?{cloudSync:true}:{}),...(showKitchenScreen?{kitchenScreen:true}:{}),...(showKitchenAlarms?{kitchenAlarms:true}:{})}));}catch{/* The current visit retains its explicit opt-in. */}
if(showShareTarget&&!customerPath){
  const manifest=document.querySelector<HTMLLinkElement>('link[rel=manifest]');if(manifest)manifest.href=`${import.meta.env.BASE_URL}manifest-share.webmanifest`;
  try{const flags=JSON.parse(localStorage.getItem('mise.flags')||'{}');localStorage.setItem('mise.flags',JSON.stringify({...flags,shareTarget:true}));}catch{/* The incoming share URL retains the opt-in when storage is unavailable. */}
}

if(showOcr&&!customerPath)try{localStorage.setItem('mise.flags',JSON.stringify({...JSON.parse(localStorage.getItem('mise.flags')||'{}'),ocr:true}));}catch{/* This visit keeps its explicit opt-in. */}

if(showPaymentText&&!customerPath)try{localStorage.setItem('mise.flags',JSON.stringify({...JSON.parse(localStorage.getItem('mise.flags')||'{}'),paymentText:true}));}catch{/* This visit retains its explicit opt-in. */}

function ComingSoon() {
  return <main className="coming-soon"><a href={`${base}bd/`} className="wordmark"><img src={markUrl} width="36" height="36" alt="" />mise</a><p className="eyebrow">A CALMER SHIFT IS COMING</p><h1>Your next shift,<br />a little more in order.</h1><p>The Mise app is coming soon. We’re starting with a useful, offline app for your counter, orders, stock and khata.</p><p>No account is needed yet. The product pages preview the full roadmap.</p><div className="actions"><a className="button button-primary" href={`${base}bd/`}>Explore Mise →</a><a className="button button-secondary" href={`${base}setup/`}>Setup and downloads</a></div><Link to="/whats-new">What’s new</Link></main>;
}

function WhatsNew() {
  return <main className="coming-soon"><p className="eyebrow">WHAT’S NEW</p><h1>{appCopy.whatsNew}</h1><p>{appCopy.recentChanges}</p><pre className="changelog">{changelog.replace(/^# Changelog\s*/, '')}</pre><Link to="/">Back to Mise</Link></main>;
}

function ScreenUnavailable(){return <main className="coming-soon"><h1>Shared screen setup is unavailable.</h1><p>Open the complete setup link from the owner to continue.</p><Link to="/">Back to Mise</Link></main>;}

createRoot(document.getElementById('root')!).render(<React.StrictMode><PaymentTextContext.Provider value={showPaymentText&&!customerPath}><OcrContext.Provider value={showOcr&&!customerPath}><OwnerTasksContext.Provider value={showOwnerTasks&&!customerPath}><LiveStoreContext.Provider value={showLiveStore&&!customerPath}><HandoffContext.Provider value={showHandoffs}><CustomerLinksContext.Provider value={showCustomerLinks&&!customerPath}><CustomerKhataContext.Provider value={showCustomerKhata}><PublicOrdersContext.Provider value={showPublicOrders&&!customerPath}><CustomerCheckoutContext.Provider value={showPublicOrders&&customerPath}><StaffTeamContext.Provider value={showStaffTeam&&!customerPath}><BrowserRouter basename={import.meta.env.BASE_URL}><Routes>{showOwnerTasks&&!customerPath?<Route path="/settings/tasks/recovery" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening saved task requests…</p></main>}><ScreenProfileGuard><OwnerTaskRecovery key="task"/></ScreenProfileGuard></Suspense>}/>:null}{showOwnerTasks&&!customerPath?<Route path="/settings/payments/recovery" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening saved payment requests…</p></main>}><ScreenProfileGuard><OwnerTaskRecovery key="payment" kind="payment"/></ScreenProfileGuard></Suspense>}/>:null}{showOwnerTasks&&!customerPath?<Route path="/settings/notifications/urgent-cleanup" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening original alert setups…</p></main>}><ScreenProfileGuard><UrgentInboxCleanup/></ScreenProfileGuard></Suspense>}/>:null}<Route path="/me/*" element={showStaffTeam?<Suspense fallback={<main className="staff-public" aria-busy="true"><p>Opening your shift…</p></main>}><StaffLinkView/></Suspense>:<main className="coming-soon"><h1>This staff link is unavailable.</h1><p>Ask the shop for a complete current link.</p></main>}/><Route path="/t/*" element={showCustomerLinks?<Suspense fallback={<main className="customer-view" aria-busy="true"><p>Opening your link…</p></main>}><CustomerLinkView/></Suspense>:<main className="coming-soon"><h1>This customer link is unavailable.</h1><p>Ask the shop for a complete current link.</p></main>}/><Route path="/k/*" element={showCustomerLinks?<Suspense fallback={<main className="customer-view" aria-busy="true"><p>Opening your link…</p></main>}><CustomerLinkView/></Suspense>:<main className="coming-soon"><h1>This customer link is unavailable.</h1><p>Ask the shop for a complete current link.</p></main>}/>{(showKitchenAlarms||showOwnerTasks)?<Route path="/settings/notifications/cleanup" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening saved notification setups…</p></main>}><ScreenProfileGuard><DeskNotificationCleanup/></ScreenProfileGuard></Suspense>}/>:null}<Route path="/screen/*" element={showDeviceAccess&&!screenLinkBlocked?<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening screen setup…</p></main>}><SharedScreen setupHash={screenSetupHash} kitchenEnabled={showKitchenScreen} staffEnabled={showStaffTeam}/></Suspense>:<ScreenUnavailable/>}/><Route path="/whats-new" element={<WhatsNew />} />{showGallery && <Route path="/_ui" element={<Suspense fallback={<p>Loading UI gallery…</p>}><Gallery /></Suspense>} />}<Route path="*" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening Mise…</p></main>}><ScreenProfileGuard>{showLocalApp?<LocalApp kitchenAlarmsEnabled={showKitchenAlarms} deviceAccessEnabled={showDeviceAccess} counterEnabled={showCounter} khataEnabled={showKhata} ordersEnabled={showOrders} stockEnabled={showStock} todayEnabled={showToday} exportsEnabled={showExports} pwaEnabled={showPwa} shopLinksEnabled={showShopLinks} pasteOrdersEnabled={showPasteOrders} qrPostersEnabled={showQrPosters} shareTargetEnabled={showShareTarget} cloudSetupEnabled={showCloudSetup} cloudSyncEnabled={showCloudSync}/>:<ComingSoon/>}</ScreenProfileGuard></Suspense>} /></Routes></BrowserRouter></StaffTeamContext.Provider></CustomerCheckoutContext.Provider></PublicOrdersContext.Provider></CustomerKhataContext.Provider></CustomerLinksContext.Provider></HandoffContext.Provider></LiveStoreContext.Provider></OwnerTasksContext.Provider></OcrContext.Provider></PaymentTextContext.Provider></React.StrictMode>);
