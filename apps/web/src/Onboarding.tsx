import { useState, type FormEvent } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { businessPacks, marketPacks, defaultMarket, type BusinessType, type MarketCode } from '@mise/core/packs';
import c from '../../../handover/copy/app.en.json';
import { db } from './data/db';

export function Onboarding({onRestore}:{onRestore?:()=>void}) {
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState<BusinessType>('corner_shop');
  const [market, setMarket] = useState<MarketCode>(() => defaultMarket(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (step < 2) { setStep(value => value + 1); return; }
    setSaving(true);
    try { await db.saveSetup({ businessType: business, marketCode: market, name, phone }); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setSaving(false); }
  }
  return <main id="main" className="onboarding">
    <a className="app-wordmark" href={import.meta.env.BASE_URL}><img src={`${import.meta.env.BASE_URL}mise-mark.svg`} width="24" height="24" alt="" />mise</a>
    <header><h1>{c.gettingStarted}</h1><p>{c.step} {step + 1} {c.of} 3 · {c.minute}</p></header>
    <progress max="3" value={step + 1} aria-label={`${c.step} ${step + 1} ${c.of} 3`} />
    <form onSubmit={submit} aria-label={c.gettingStarted}>
      <Card className="onboarding-card"><h2 tabIndex={-1} key={step}>{c.onboarding[step].title}</h2><p>{c.onboarding[step].lead}</p>
        {step === 0 ? <fieldset className="business-choices"><legend className="sr-only">{c.business}</legend>{Object.entries(businessPacks).map(([key, pack]) => <label className={`choice-card ${business === key ? 'selected' : ''}`} key={key}><input type="radio" name="business" value={key} checked={business === key} onChange={() => setBusiness(key as BusinessType)} /><span><strong>{pack['biz/type']}</strong><small>{c.businessHints[key as BusinessType]}</small></span></label>)}</fieldset> : null}
        {step === 1 ? <fieldset className="market-choices"><legend className="sr-only">{c.market}</legend>{Object.entries(marketPacks).map(([key, pack]) => <label className={`choice-card ${market === key ? 'selected' : ''}`} key={key}><input type="radio" name="market" value={key} checked={market === key} onChange={() => setMarket(key as MarketCode)} /><span><strong>{pack['market/name']}</strong><small>{pack['currency/code']} · {pack['currency/symbol']}</small></span></label>)}</fieldset> : null}
        {step === 2 ? <div className="form-fields"><label>{c.shopName}<input name="shopName" autoComplete="organization" value={name} maxLength={80} onChange={event => setName(event.target.value)} required autoFocus /></label><label>{c.phone}<input type="tel" name="phone" autoComplete="tel" placeholder={marketPacks[market]['phone/format']} value={phone} onChange={event => setPhone(event.target.value)} required /></label></div> : null}
      </Card>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="onboarding-actions">{step > 0 ? <Button kind="secondary" type="button" onClick={() => { setStep(value => value - 1); setError(''); }} disabled={saving}>{c.back}</Button> : null}<Button type="submit" disabled={saving}>{saving ? c.saving : step === 2 ? c.open : c.next}</Button></div>
    </form>
    {onRestore ? <Button type="button" kind="ghost" onClick={onRestore}>Restore a backup</Button> : null}
  </main>;
}
