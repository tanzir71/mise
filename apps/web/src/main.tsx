import React, { lazy, Suspense } from 'react';
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

const Gallery = lazy(() => import('./Gallery').then(module => ({ default: module.Gallery })));
const LocalApp = lazy(() => import('./LocalApp').then(module => ({ default: module.LocalApp })));
const SharedScreen=lazy(()=>import('./SharedScreen').then(module=>({default:module.SharedScreen})));
const ScreenProfileGuard=lazy(()=>import('./ScreenProfileGuard').then(module=>({default:module.ScreenProfileGuard})));
const DeskNotificationCleanup=lazy(()=>import('./DeskNotificationCleanup').then(module=>({default:module.DeskNotificationCleanup})));
let screenSetupHash='',screenLinkBlocked=false;
if((location.pathname===import.meta.env.BASE_URL+'screen'||location.pathname.startsWith(import.meta.env.BASE_URL+'screen/'))&&location.hash){
  const original=location.hash;try{history.replaceState(history.state,'',location.pathname+location.search);screenSetupHash=original;}catch{screenLinkBlocked=true;}
}

const base = import.meta.env.DEV ? (import.meta.env.VITE_LANDING_ORIGIN || `http://127.0.0.1:4321${import.meta.env.BASE_URL.replace(/app\/$/, '')}`) : import.meta.env.BASE_URL.replace(/app\/$/, '');
const markUrl = `${import.meta.env.BASE_URL}mise-mark.svg`;
let storedFlags = '';
try { storedFlags = localStorage.getItem('mise.flags') || ''; } catch { /* The gallery remains opt-in without storage. */ }
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
const showCloudSync=flagEnabled('cloudSync',location.search,storedFlags);
const showKitchenScreen=flagEnabled('kitchenScreen',location.search,storedFlags);
const showKitchenAlarms=flagEnabled('kitchenAlarms',location.search,storedFlags);
const showDeviceAccess=showKitchenScreen||flagEnabled('deviceAccess',location.search,storedFlags);
const showCloudSetup=showKitchenAlarms||showDeviceAccess||showCloudSync||flagEnabled('cloudSetup',location.search,storedFlags);
if(showCloudSetup)try{localStorage.setItem('mise.flags',JSON.stringify({...JSON.parse(storedFlags||'{}'),cloudSetup:true,...(showDeviceAccess?{deviceAccess:true}:{}),...(showCloudSync?{cloudSync:true}:{}),...(showKitchenScreen?{kitchenScreen:true}:{}),...(showKitchenAlarms?{kitchenAlarms:true}:{})}));}catch{/* The current visit retains its explicit opt-in. */}
if(showShareTarget){
  const manifest=document.querySelector<HTMLLinkElement>('link[rel=manifest]');if(manifest)manifest.href=`${import.meta.env.BASE_URL}manifest-share.webmanifest`;
  try{const flags=JSON.parse(localStorage.getItem('mise.flags')||'{}');localStorage.setItem('mise.flags',JSON.stringify({...flags,shareTarget:true}));}catch{/* The incoming share URL retains the opt-in when storage is unavailable. */}
}

function ComingSoon() {
  return <main className="coming-soon"><a href={`${base}bd/`} className="wordmark"><img src={markUrl} width="36" height="36" alt="" />mise</a><p className="eyebrow">A CALMER SHIFT IS COMING</p><h1>Your next shift,<br />a little more in order.</h1><p>The Mise app is coming soon. We’re starting with a useful, offline app for your counter, orders, stock and khata.</p><p>No account is needed yet. The product pages preview the full roadmap.</p><div className="actions"><a className="button button-primary" href={`${base}bd/`}>Explore Mise →</a><a className="button button-secondary" href={`${base}setup/`}>Setup and downloads</a></div><Link to="/whats-new">What’s new</Link></main>;
}

function WhatsNew() {
  return <main className="coming-soon"><p className="eyebrow">WHAT’S NEW</p><h1>{appCopy.whatsNew}</h1><p>{appCopy.recentChanges}</p><pre className="changelog">{changelog.replace(/^# Changelog\s*/, '')}</pre><Link to="/">Back to Mise</Link></main>;
}

function ScreenUnavailable(){return <main className="coming-soon"><h1>Shared screen setup is unavailable.</h1><p>Open the complete setup link from the owner to continue.</p><Link to="/">Back to Mise</Link></main>;}

createRoot(document.getElementById('root')!).render(<React.StrictMode><HandoffContext.Provider value={showHandoffs}><BrowserRouter basename={import.meta.env.BASE_URL}><Routes>{showKitchenAlarms?<Route path="/settings/notifications/cleanup" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening saved notification setups…</p></main>}><ScreenProfileGuard><DeskNotificationCleanup/></ScreenProfileGuard></Suspense>}/>:null}<Route path="/screen/*" element={showDeviceAccess&&!screenLinkBlocked?<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening screen setup…</p></main>}><SharedScreen setupHash={screenSetupHash} kitchenEnabled={showKitchenScreen}/></Suspense>:<ScreenUnavailable/>}/><Route path="/whats-new" element={<WhatsNew />} />{showGallery && <Route path="/_ui" element={<Suspense fallback={<p>Loading UI gallery…</p>}><Gallery /></Suspense>} />}<Route path="*" element={<Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening Mise…</p></main>}><ScreenProfileGuard>{showLocalApp?<LocalApp kitchenAlarmsEnabled={showKitchenAlarms} deviceAccessEnabled={showDeviceAccess} counterEnabled={showCounter} khataEnabled={showKhata} ordersEnabled={showOrders} stockEnabled={showStock} todayEnabled={showToday} exportsEnabled={showExports} pwaEnabled={showPwa} shopLinksEnabled={showShopLinks} pasteOrdersEnabled={showPasteOrders} qrPostersEnabled={showQrPosters} shareTargetEnabled={showShareTarget} cloudSetupEnabled={showCloudSetup} cloudSyncEnabled={showCloudSync}/>:<ComingSoon/>}</ScreenProfileGuard></Suspense>} /></Routes></BrowserRouter></HandoffContext.Provider></React.StrictMode>);
