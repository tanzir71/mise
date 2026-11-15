import { useMemo, useRef, useState } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { Toggle } from '@mise/ui/Toggle.tsx';
import { searchCustomers } from '@mise/core/customers';
import { calculateAmount } from '@mise/core/calc';
import { CreditLimitError, type OverLimitConfirmation } from '@mise/core/khata';
import { formatMoney } from '@mise/core/money';
import type { CreditSaleInput } from '@mise/core/credit-sales';
import type { CreditAccount, Customer, Sale, SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { Avatar, CreditMeter, displayName, errorText, useKhata } from './khata-data';
import { CreditTermsForm, CustomerForm } from './KhataForms';
import { CreditHandoff } from './CreditHandoff';
import './khata.css';

export function CreditSheet({setup,draft,onRecorded,onClose}: {setup:SetupSnapshot;draft:Pick<CreditSaleInput,'expression'|'items'>;onRecorded:(sale:Sale) => void;onClose:() => void}) {
  const {data,rows,byAccount} = useKhata(setup), [query,setQuery] = useState(''), [selected,setSelected] = useState(''), [created,setCreated] = useState('');
  const [editor,setEditor] = useState<'new'|{customer:Customer;account:CreditAccount}|null>(null), [receipt,setReceipt] = useState(true), [saved,setSaved] = useState<Sale|null>(null);
  const [confirmation,setConfirmation] = useState<OverLimitConfirmation|null>(null), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false), completed = useRef(false);
  const amount = calculateAmount(draft.expression,setup.outlet.currency) || 0;
  const people = useMemo(() => searchCustomers(data?.customers || [],query),[data?.customers,query]);
  const recent = useMemo(() => new Map(rows.map(row => [row.account.id,(byAccount.get(row.account.id) || []).reduce((at,entry) => Math.max(at,entry.createdAt),row.account.updatedAt)])),[rows,byAccount]);
  const current = rows.filter(row => row.account.currency === setup.outlet.currency && people.some(person => person.id === row.account.customerId)).sort((a,b) => recent.get(b.account.id)!-recent.get(a.account.id)!);
  const chosen = current.find(row => row.account.id === selected || row.account.customerId === created) || current[0];
  const customer = data?.customers.find(person => person.id === chosen?.account.customerId);
  const proposed = chosen ? BigInt(chosen.balance)+BigInt(amount) : 0n, supported = proposed <= BigInt(Number.MAX_SAFE_INTEGER);
  const over = chosen && proposed > BigInt(chosen.account.limit);
  async function record(giveAnyway = false) {
    if (busy.current || completed.current || !chosen || !customer) return; busy.current = true; setSaving(true); setError('');
    try {
      const sale = await db.recordCreditSale({...draft,customerId:customer.id,accountId:chosen.account.id,...(giveAnyway && confirmation ? {confirmation} : {})});
      completed.current = true; setSaved(sale); onRecorded(sale); if (!receipt) onClose();
    } catch (error) {
      if (error instanceof CreditLimitError) { setConfirmation({balance:error.balance,limit:error.limit}); setError(`New balance ${formatMoney(error.proposed,setup.outlet.currency)} exceeds the limit ${formatMoney(error.limit,setup.outlet.currency)}. Give credit only if you agree.`); }
      else { setError(errorText(error)); setConfirmation(null); }
    } finally { busy.current = false; setSaving(false); }
  }
  return <Modal open variant="sheet" title={saved ? 'Share receipt' : editor === 'new' ? 'New customer' : editor ? 'Credit settings' : `Put ${formatMoney(amount,setup.outlet.currency)} on whose khata?`} closeLabel="Close" onClose={() => { if (!busy.current) onClose(); }}>
    {saved ? <CreditHandoff accountId={saved.creditAccountId!} purpose="receipt" sale={saved} onDone={onClose} /> : editor === 'new' ? <CustomerForm setup={setup} onSaved={person => { setCreated(person.id); setSelected(''); setQuery(''); setEditor(null); }} /> : editor ? <CreditTermsForm setup={setup} customer={editor.customer} account={editor.account} onSaved={() => setEditor(null)} /> : <div className="put-on-khata"><p>{setup.business.marketCode === 'BD' ? 'Baki' : 'Credit'} is only for people you trust. Mise checks the limit you set before saving.</p>
      <label className="catalogue-search"><MiseIcon name="search" size={16} /><span className="sr-only">Name or phone number</span><input type="search" value={query} placeholder="Name or phone number" disabled={saving} onChange={event => { setQuery(event.target.value); setSelected(''); setCreated(''); setConfirmation(null); setError(''); }} /></label>
      <fieldset className="credit-choices" disabled={saving}><legend>{query ? 'Search results' : 'Recent'}</legend>{current.map(row => { const person = people.find(person => person.id === row.account.customerId)!; return <label key={row.account.id} className="credit-choice"><Avatar name={displayName(person)} /><span><strong>{displayName(person)}</strong><small>{formatMoney(row.balance,row.account.currency)} due · limit {formatMoney(row.account.limit,row.account.currency)}</small><CreditMeter account={row.account} balance={row.balance} />{!row.account.allowed ? <small>Credit is off</small> : row.overLimit ? <small className="khata-warning">Over limit · ask before giving more</small> : null}</span><input type="radio" name="credit-customer" aria-label={displayName(person)} checked={chosen?.account.id === row.account.id} onChange={() => { setSelected(row.account.id); setCreated(''); setConfirmation(null); setError(''); }} /></label>; })}{data && !current.length ? <p>No customers match. Add someone new below.</p> : null}</fieldset>
      <Card className="app-panel credit-new-person"><h3>Someone new?</h3><p>Type their name and phone, then set a credit limit.</p><Button kind="secondary" disabled={saving} onClick={() => setEditor('new')}><MiseIcon name="plus" size={16} />Type name</Button></Card>
      {chosen && customer && !chosen.account.allowed ? <Button kind="secondary" disabled={saving} onClick={() => setEditor({customer,account:chosen.account})}>Set credit for {displayName(customer)}</Button> : null}
      <div className="khata-toggle-row"><span>Send the receipt on WhatsApp<small>Review it after saving. You send it yourself.</small></span><Toggle checked={receipt} label="Send the receipt on WhatsApp" disabled={saving} onChange={setReceipt} /></div>
      {error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions credit-confirm"><p>{chosen ? `New balance ${supported ? formatMoney(Number(proposed),setup.outlet.currency) : 'exceeds the supported amount'} of ${formatMoney(chosen.account.limit,setup.outlet.currency)}` : 'Choose a customer first.'}</p>{confirmation && chosen && (confirmation.balance !== chosen.balance || confirmation.limit !== chosen.account.limit) ? <p className="khata-warning">This khata changed. Check the balance again.</p> : null}
        <Button disabled={saving || !chosen?.account.allowed || !supported || amount <= 0} onClick={() => void record(Boolean(confirmation && chosen && confirmation.balance === chosen.balance && confirmation.limit === chosen.account.limit))}><MiseIcon name="checkCircle" size={16} />{saving ? 'Saving…' : confirmation && chosen && confirmation.balance === chosen.balance && confirmation.limit === chosen.account.limit ? 'Give anyway' : customer ? `${over ? 'Review credit for' : 'Add to'} ${displayName(customer)}${over ? '' : '’s khata'}` : 'Add to khata'}</Button>
      </footer></div>}
  </Modal>;
}
