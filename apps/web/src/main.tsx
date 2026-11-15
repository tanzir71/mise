import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import '@mise/ui/tokens.css';
import './style.css';
import '@mise/ui/fonts.css';
import '@mise/ui/primitives.css';
import { flagEnabled } from '@mise/core/flags';
import changelog from '../../../CHANGELOG.md?raw';
import appCopy from '../../../handover/copy/app.en.json';

const Gallery = lazy(() => import('./Gallery').then(module => ({ default: module.Gallery })));
const LocalApp = lazy(() => import('./LocalApp').then(module => ({ default: module.LocalApp })));

const base = import.meta.env.DEV ? (import.meta.env.VITE_LANDING_ORIGIN || `http://127.0.0.1:4321${import.meta.env.BASE_URL.replace(/app\/$/, '')}`) : import.meta.env.BASE_URL.replace(/app\/$/, '');
const markUrl = `${import.meta.env.BASE_URL}mise-mark.svg`;
let storedFlags = '';
try { storedFlags = localStorage.getItem('mise.flags') || ''; } catch { /* The gallery remains opt-in without storage. */ }
const showGallery = flagEnabled('uiGallery', location.search, storedFlags);
const showLocalApp = flagEnabled('localApp', location.search, storedFlags);
const showCounter = flagEnabled('counter', location.search, storedFlags);
const showKhata = flagEnabled('khata', location.search, storedFlags);

function ComingSoon() {
  return <main className="coming-soon"><a href={`${base}bd/`} className="wordmark"><img src={markUrl} width="36" height="36" alt="" />mise</a><p className="eyebrow">A CALMER SHIFT IS COMING</p><h1>Your next shift,<br />a little more in order.</h1><p>The Mise app is coming soon. We’re starting with a useful, offline app for your counter, orders, stock and khata.</p><p>No account is needed yet. The product pages preview the full roadmap.</p><div className="actions"><a className="button button-primary" href={`${base}bd/`}>Explore Mise →</a><a className="button button-secondary" href={`${base}setup/`}>Setup and downloads</a></div><Link to="/whats-new">What’s new</Link></main>;
}

function WhatsNew() {
  return <main className="coming-soon"><p className="eyebrow">WHAT’S NEW</p><h1>{appCopy.whatsNew}</h1><p>{appCopy.recentChanges}</p><pre className="changelog">{changelog.replace(/^# Changelog\s*/, '')}</pre><Link to="/">Back to Mise</Link></main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter basename={import.meta.env.BASE_URL}><Routes><Route path="/whats-new" element={<WhatsNew />} />{showGallery && <Route path="/_ui" element={<Suspense fallback={<p>Loading UI gallery…</p>}><Gallery /></Suspense>} />}<Route path="*" element={showLocalApp ? <Suspense fallback={<main className="coming-soon" aria-busy="true"><p>Opening Mise…</p></main>}><LocalApp counterEnabled={showCounter} khataEnabled={showKhata} /></Suspense> : <ComingSoon />} /></Routes></BrowserRouter></React.StrictMode>);
