import { useState, type FormEvent } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { businessPacks, marketPacks, type BusinessType, type MarketCode, type MessageLanguage } from '@mise/core/packs';
import { formatMoney } from '@mise/core/money';
import type { SetupInput, SetupSnapshot } from '@mise/core/models';
import c from '../../../handover/copy/app.en.json';
import { db } from './data/db';

export function Settings({ setup }: { setup: SetupSnapshot }) {
  const [input, setInput] = useState<SetupInput>(() => ({ businessType: setup.business.businessType, marketCode: setup.business.marketCode, name: setup.business.name, phone: setup.owner.phone, outletName: setup.outlet.name, address: setup.outlet.address, timezone: setup.outlet.timezone, currency: setup.outlet.currency, language: setup.business.languages.length > 1 ? 'both' : setup.business.languages[0] }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  function field<K extends keyof SetupInput>(key: K, value: SetupInput[K]) { setInput(before => ({ ...before, [key]: value })); setSaved(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setSaved(false);
    try { await db.saveSetup(input); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setSaving(false); }
  }
  return <><header className="app-page-heading"><h1>{c.settings}</h1><p>{c.thisDevice}</p></header><form className="settings-form" onSubmit={save}>
    <Card className="app-panel"><h2>{c.businessSettings}</h2><div className="form-fields"><label>{c.business}<select value={input.businessType} onChange={event => field('businessType', event.target.value as BusinessType)}>{Object.entries(businessPacks).map(([key, pack]) => <option key={key} value={key}>{pack['biz/type']}</option>)}</select></label><label>{c.shopName}<input value={input.name} maxLength={80} autoComplete="organization" onChange={event => field('name', event.target.value)} required /></label><label>{c.phone}<input type="tel" value={input.phone} autoComplete="tel" onChange={event => field('phone', event.target.value)} required /></label><label>{c.outlet}<input value={input.outletName} maxLength={80} onChange={event => field('outletName', event.target.value)} required /></label><label>{c.address}<input value={input.address} autoComplete="street-address" maxLength={250} onChange={event => field('address', event.target.value)} /></label></div></Card>
    <Card className="app-panel"><h2>{c.marketSettings}</h2><div className="form-fields"><label>{c.market}<select value={input.marketCode} onChange={event => { const marketCode = event.target.value as MarketCode; const pack = marketPacks[marketCode]; setInput(before => ({ ...before, marketCode, currency: pack['currency/code'], timezone: pack.timezone })); setSaved(false); }}>{Object.entries(marketPacks).map(([key, pack]) => <option key={key} value={key}>{pack['market/name']}</option>)}</select></label><label>{c.language}<select value={input.language} onChange={event => field('language', event.target.value as MessageLanguage)}>{c.languages.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}</select></label><label>{c.currency}<select value={input.currency} onChange={event => field('currency', event.target.value)}>{['BDT', 'INR', 'IDR', 'KES', 'USD'].map(currency => <option key={currency}>{currency}</option>)}</select></label><label>{c.timezone}<input value={input.timezone} onChange={event => field('timezone', event.target.value)} required /></label></div><p className="currency-preview">{c.currencyPreview}<strong>{formatMoney(11284000, input.currency || 'USD')}</strong></p><p>{c.currencyNote}</p></Card>
    {error ? <p role="alert" className="form-error">{error}</p> : null}{saved ? <p role="status">{c.saved}</p> : null}<Button type="submit" disabled={saving}>{saving ? c.saving : c.save}</Button>
  </form></>;
}
