import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Toggle } from '@mise/ui/Toggle.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { businessPacks, marketPacks } from '@mise/core/packs';
import { formatMoney, moneyInputValue, parseMoney } from '@mise/core/money';
import { parseCataloguePaste, searchItems, type ItemInput, type PasteRow } from '@mise/core/catalogue';
import type { Category, Item, SetupSnapshot } from '@mise/core/models';
import c from '../../../handover/copy/app.en.json';
import { db } from './data/db';
import './catalogue.css';

interface EditValues { name: string; nameLocal: string; price: string; unit: string; category: string; available: boolean; oftenBought: boolean }
interface EditorState { item: Item | null; values: EditValues }
function useDesktop() {
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width:1024px)').matches);
  useEffect(() => { const media = matchMedia('(min-width:1024px)'), update = () => setDesktop(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  return desktop;
}
export function Catalogue({ setup }: { setup: SetupSnapshot }) {
  const data = useLiveQuery(async () => ({ items: await db.items.where('outletId').equals(setup.outlet.id).toArray(), categories: await db.categories.where('outletId').equals(setup.outlet.id).toArray() }), [setup.outlet.id]);
  const [query, setQuery] = useState(''), [editor, setEditor] = useState<EditorState | null>(null), [paste, setPaste] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const desktop = useDesktop();
  const items = data?.items || [], categories = data?.categories || [];
  const filtered = useMemo(() => searchItems(data?.items || [], query), [data?.items, query]);
  const catalogue = businessPacks[setup.business.businessType]['noun/catalogue'];
  const grouped = useMemo(() => categories.map(category => ({ category, items: filtered.filter(item => item.categoryId === category.id) })).filter(group => group.items.length).sort((a, b) => a.category.sort - b.category.sort), [categories, filtered]);
  function edit(item: Item | null) {
    setError(''); setEditor({ item, values: { name: item?.name || '', nameLocal: item?.nameLocal || '', price: item ? moneyInputValue(item.price, setup.outlet.currency) : '', unit: item?.unit || 'pc', category: categories.find(category => category.id === item?.categoryId)?.name || '', available: item?.available ?? true, oftenBought: item?.oftenBought ?? false } });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editor) return;
    const price = parseMoney(editor.values.price, setup.outlet.currency);
    if (price === null) { setError(c.catalogue.invalidPrice); return; }
    setSaving(true); setError('');
    try { await db.saveItem({ ...editor.values, price }, editor.item?.id); setEditor(null); setMessage(c.catalogue.saved); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!editor?.item || !confirm(c.catalogue.deleteConfirm.replace('{name}', editor.item.name))) return;
    setSaving(true); setError('');
    try { await db.deleteItem(editor.item.id); setEditor(null); setMessage(c.catalogue.deleted); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setSaving(false); }
  }
  async function availability(item: Item, available: boolean) {
    setError('');
    try { await db.setItemAvailable(item.id, available); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
  }
  const editorContent = editor ? <ItemEditor values={editor.values} categories={categories} currency={setup.outlet.currency} saving={saving} error={error} canDelete={Boolean(editor.item)} onChange={values => setEditor(before => before ? { ...before, values } : null)} onSave={save} onDelete={() => void remove()} /> : <p>{c.catalogue.selectItem}</p>;
  return <div className="catalogue-page" aria-busy={!data}><header className="app-page-heading catalogue-heading"><div><h1>{c.businessData}</h1><p className="desktop-catalogue-lead">{c.catalogue.lead}</p></div><Button onClick={() => edit(null)}><MiseIcon name="plus" size={14} />{c.catalogue.add}</Button></header>
    <div className="catalogue-overview"><Card className="app-panel selected"><h2><MiseIcon name="database" size={18} />{catalogue}</h2><p>{items.length} {c.catalogue.items} · {items.filter(item => item.available).length} {c.catalogue.available.toLowerCase()}</p><small>{c.catalogue.editingBelow}</small></Card><Card className="app-panel"><h2><MiseIcon name="layers" size={18} />{c.catalogue.categories}</h2><p>{categories.length}</p><small>{c.catalogue.categoriesHelp}</small></Card><Card className="app-panel"><h2><MiseIcon name="store" size={18} />{c.outlet}</h2><p>{setup.outlet.name}</p><small>{setup.outlet.currency}</small></Card><Card className="app-panel"><h2><MiseIcon name="globe" size={18} />{c.market}</h2><p>{marketPacks[setup.business.marketCode]['market/name']}</p><small>{setup.business.languages.join(' + ')}</small></Card></div>
    <p className="catalogue-tab chip selected">{catalogue} {items.length}</p><label className="catalogue-search"><MiseIcon name="search" size={16} /><span className="sr-only">{c.catalogue.search}</span><input type="search" value={query} placeholder={`${c.catalogue.search} ${catalogue.toLowerCase()}`} onChange={event => setQuery(event.target.value)} /></label>
    {error && !editor ? <p className="form-error" role="alert">{error}</p> : null}<p className="catalogue-status" role="status">{message}</p>
    <div className="catalogue-columns"><div><div className="catalogue-groups">{grouped.map(group => <section key={group.category.id}><h2 className="group-heading">{group.category.name}</h2><div className="catalogue-items">{group.items.map(item => <article key={item.id} className={!item.available ? 'unavailable' : ''}><button type="button" className="item-open" aria-label={`${c.catalogue.edit}: ${item.name}`} onClick={() => edit(item)}><span><strong>{item.name}</strong>{item.nameLocal ? <small lang={setup.business.marketCode === 'BD' ? 'bn' : undefined}>{item.nameLocal}</small> : null}<small>{formatMoney(item.price, setup.outlet.currency)} / {item.unit}{item.isSample ? ` · ${c.sample}` : ''}{!item.available ? ` · ${c.catalogue.unavailable}` : ''}</small></span></button><Toggle checked={item.available} label={`${c.catalogue.available}: ${item.name}`} onChange={available => void availability(item, available)} /><button type="button" className="item-chevron" aria-label={`${c.catalogue.details}: ${item.name}`} onClick={() => edit(item)}><MiseIcon name="chevronRight" size={16} /></button></article>)}</div></section>)}</div>
      {data && !filtered.length ? <Card className="app-panel"><p>{query ? c.catalogue.noResults : c.catalogue.empty}</p></Card> : null}<p className="catalogue-help">{c.catalogue.availabilityHelp}</p><Card className="app-panel paste-card"><h2>{c.catalogue.addMany}</h2><Button kind="secondary" onClick={() => setPaste(true)}><MiseIcon name="clipboard" size={16} />{c.catalogue.paste}</Button></Card></div>
      {desktop ? <Card className="app-panel catalogue-editor"><header><h2>{editor?.item ? c.catalogue.edit : c.catalogue.newItem}</h2>{editor ? <Button kind="secondary" onClick={() => setEditor(null)}>{c.catalogue.close}</Button> : null}</header>{editorContent}</Card> : null}
    </div>
    {!desktop ? <Modal open={Boolean(editor)} title={editor?.item ? c.catalogue.edit : c.catalogue.newItem} closeLabel={c.catalogue.close} onClose={() => setEditor(null)}>{editorContent}</Modal> : null}
    <PasteImport open={paste} currency={setup.outlet.currency} onClose={() => setPaste(false)} onAdded={() => { setPaste(false); setMessage(c.catalogue.saved); }} />
  </div>;
}
function ItemEditor({ values, categories, currency, saving, error, canDelete, onChange, onSave, onDelete }: { values: EditValues; categories: Category[]; currency: string; saving: boolean; error: string; canDelete: boolean; onChange: (values: EditValues) => void; onSave: (event: FormEvent) => void; onDelete: () => void }) {
  const id = useId();
  const field = <K extends keyof EditValues>(key: K, value: EditValues[K]) => onChange({ ...values, [key]: value });
  return <form className="item-editor-form" onSubmit={onSave}><div className="form-fields"><label>{c.catalogue.name}<input name="itemName" value={values.name} onChange={event => field('name', event.target.value)} maxLength={120} required autoFocus /></label><label>{c.catalogue.localName}<input name="itemNameLocal" value={values.nameLocal} maxLength={120} onChange={event => field('nameLocal', event.target.value)} /></label><label>{c.catalogue.price} ({currency})<input name="itemPrice" inputMode="decimal" value={values.price} onChange={event => field('price', event.target.value)} placeholder="0.00" required /></label><label>{c.catalogue.unit}<input name="itemUnit" value={values.unit} maxLength={16} onChange={event => field('unit', event.target.value)} required /></label><label>{c.catalogue.category}<input name="itemCategory" value={values.category} list={`${id}-categories`} maxLength={80} onChange={event => field('category', event.target.value)} /><datalist id={`${id}-categories`}>{categories.map(category => <option key={category.id} value={category.name} />)}</datalist></label></div><label className="checkbox-field"><input type="checkbox" checked={values.available} onChange={event => field('available', event.target.checked)} />{c.catalogue.available}</label><label className="checkbox-field"><input type="checkbox" checked={values.oftenBought} onChange={event => field('oftenBought', event.target.checked)} />{c.catalogue.oftenBought}</label>{error ? <p role="alert" className="form-error">{error}</p> : null}<div className="item-editor-actions"><Button type="submit" disabled={saving}>{saving ? c.saving : c.save}</Button>{canDelete ? <Button type="button" kind="secondary" disabled={saving} onClick={onDelete}>{c.catalogue.delete}</Button> : null}</div></form>;
}
function PasteImport({ open, currency, onClose, onAdded }: { open: boolean; currency: string; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = useState(''), [rows, setRows] = useState<PasteRow[] | null>(null), [category, setCategory] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const invalid = rows?.some(row => row.error) || (rows?.length || 0) > 1000;
  async function add() {
    if (!rows?.length || invalid) return;
    setSaving(true); setError('');
    try { await db.addItems(rows.map(row => ({ name: row.name, nameLocal: '', price: row.price!, unit: 'pc', category, available: true, oftenBought: false } satisfies ItemInput))); setText(''); setRows(null); onAdded(); }
    catch (error) { setError(error instanceof Error ? error.message : c.storageHelp); }
    finally { setSaving(false); }
  }
  return <Modal open={open} title={c.catalogue.addMany} closeLabel={c.catalogue.close} onClose={onClose}><p>{c.catalogue.pasteHelp}</p><label className="paste-input">{c.catalogue.paste}<textarea rows={7} value={text} onChange={event => { setText(event.target.value); setRows(null); }} placeholder="Tea, 20&#10;Rice, 75" /></label><label className="paste-category">{c.catalogue.category}<input value={category} maxLength={80} onChange={event => setCategory(event.target.value)} /></label><Button kind="secondary" onClick={() => setRows(parseCataloguePaste(text, currency))} disabled={!text.trim() || saving}>{c.catalogue.preview}</Button>{rows ? <><p>{rows.length} {c.catalogue.items}</p>{invalid ? <p className="form-error" role="alert">{c.catalogue.fixRows}</p> : null}<div className="paste-preview" tabIndex={0} role="region" aria-label={c.catalogue.preview}><table><thead><tr><th>#</th><th>{c.catalogue.name}</th><th>{c.catalogue.price}</th><th>{c.catalogue.check}</th></tr></thead><tbody>{rows.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.name}</td><td>{row.price === null ? '—' : formatMoney(row.price, currency)}</td><td>{row.error || c.catalogue.ready}</td></tr>)}</tbody></table></div><Button onClick={() => void add()} disabled={saving || !rows.length || Boolean(invalid)}>{saving ? c.saving : `${c.catalogue.add} ${rows.length} ${c.catalogue.items}`}</Button></> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}</Modal>;
}
