import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { businessPacks } from '@mise/core/packs';
import { formatMoney } from '@mise/core/money';
import type { SetupSnapshot } from '@mise/core/models';
import c from '../../../handover/copy/app.en.json';
import { db } from './data/db';
export function SampleCatalogue({ setup }: { setup: SetupSnapshot }) {
  const items = useLiveQuery(() => db.items.where('outletId').equals(setup.outlet.id).filter(item => item.isSample).toArray(), [setup.outlet.id], []);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState('');
  async function remove(id: string) {
    setRemoving(id); setError('');
    try { await db.removeSample(id); setMessage(c.removed); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setRemoving(''); }
  }
  return <><header className="app-page-heading"><h1>{businessPacks[setup.business.businessType]['noun/catalogue']}</h1><p>{c.sampleLead}</p></header><Card className="app-panel sample-list">{items.length ? items.map(item => <article key={item.id}><div><h2>{item.name}</h2>{item.nameLocal ? <p lang={setup.business.marketCode === 'BD' ? 'bn' : undefined}>{item.nameLocal}</p> : null}<small>{c.sample} · <span className="money">{formatMoney(item.price, setup.outlet.currency)}</span></small></div><Button kind="secondary" disabled={Boolean(removing)} onClick={() => void remove(item.id)} aria-label={`${c.removeSample}: ${item.name}`}>{c.removeSample}</Button></article>) : <p>{c.noSamples}</p>}</Card>{error ? <p role="alert" className="form-error">{error}</p> : null}<p role="status">{message}</p></>;
}
