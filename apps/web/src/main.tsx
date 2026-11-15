import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import '@mise/ui/tokens.css';
import './style.css';
import '@mise/ui/fonts.css';
import '@mise/ui/primitives.css';
import { flagEnabled } from '@mise/core/flags';
import { Gallery } from './Gallery';

const base = import.meta.env.BASE_URL.replace(/app\/$/, '');
let storedFlags = '';
try { storedFlags = localStorage.getItem('mise.flags') || ''; } catch { /* The gallery remains opt-in without storage. */ }
const showGallery = flagEnabled('uiGallery', location.search, storedFlags);

function ComingSoon() {
  return <main className="coming-soon"><a href={`${base}bd/`} className="wordmark"><img src={`${base}brand/mise-mark.svg`} width="36" height="36" alt="" />mise<span>®</span></a><p className="eyebrow">A CALMER SHIFT IS COMING</p><h1>Your next shift,<br />a little more in order.</h1><p>The Mise app is coming soon. We’re starting with a useful, offline app for your counter, orders, stock and khata.</p><p>No account is needed yet. The product pages preview the full roadmap.</p><div className="actions"><a className="button" href={`${base}bd/`}>Explore Mise →</a><a className="button secondary" href={`${base}setup/`}>Setup and downloads</a></div><Link to="/whats-new">What’s new</Link></main>;
}

function WhatsNew() {
  return <main className="coming-soon"><p className="eyebrow">WHAT’S NEW</p><h1>Mise 0.1</h1><p>The regional product pages and setup guide are here. The working app follows in Phase 1.</p><Link to="/">Back to Mise</Link></main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter basename={import.meta.env.BASE_URL}><Routes><Route path="/whats-new" element={<WhatsNew />} />{showGallery && <Route path="/_ui" element={<Gallery />} />}<Route path="*" element={<ComingSoon />} /></Routes></BrowserRouter></React.StrictMode>);
