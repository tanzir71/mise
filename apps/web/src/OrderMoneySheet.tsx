import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { marketPacks } from '@mise/core/packs';
import { CreditLimitError, type OverLimitConfirmation } from '@mise/core/khata';
import { formatMoney, moneyInputValue, parseMoney } from '@mise/core/money';
import type { Order, PaymentMethod, SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { errorText, useKhata } from './khata-data';
import { CreditTermsForm } from './KhataForms';

export function OrderMoneySheet({order,setup,refund = false,onDone}: {order:Order;setup:SetupSnapshot;refund?:boolean;onDone:() => void}) {
  const {data,rows,byAccount} = useKhata(setup), account = rows.find(row => row.account.customerId === order.customer.id && row.account.currency === order.currency), customer = data?.customers.find(person => person.id === order.customer.id);
  const [method,setMethod] = useState(order.payment.method === 'wallet' ? order.payment.wallet || 'cash' : refund ? 'cash' : order.payment.method);
  const [amount,setAmount] = useState(() => moneyInputValue(refund ? order.payment.cancellation?.refundDue || 0 : order.total || 0,order.currency)), [given,setGiven] = useState(''), [note,setNote] = useState('');
  const [confirmation,setConfirmation] = useState<OverLimitConfirmation|null>(null), [editing,setEditing] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState(''), busy = useRef(false);
  const historic = (account ? byAccount.get(account.account.id) || [] : []).filter(entry => entry.type === 'payment' && entry.methodName && !['Cash','Card'].includes(entry.methodName)).map(entry => entry.methodName!);
  const wallets = [...new Set([...marketPacks[setup.business.marketCode]['pay/wallets'].filter(wallet => wallet !== 'Cash'),...(order.payment.wallet ? [order.payment.wallet] : []),...historic])];
  const kind = ['cash','card','credit'].includes(method) ? method as PaymentMethod|'credit' : 'wallet';
  async function save(event:FormEvent) {
    event.preventDefault();if (busy.current) return;busy.current = true;setSaving(true);setError('');
    try {
      if (refund) {
        const value = parseMoney(amount,order.currency);if (value === null) throw new Error('Enter a valid refund amount.');
        if (kind === 'credit') throw new Error('Choose how the money was actually returned.');
        await db.refundOrder(order.id,{amount:value,method:kind,wallet:kind === 'wallet' ? method : undefined,note},order.revision);
      } else {
        const value = given.trim() ? parseMoney(given,order.currency) : undefined;if (value === null) throw new Error('Enter a valid cash amount given.');
        await db.settleOrder(order.id,{method:kind,wallet:kind === 'wallet' ? method : undefined,accountId:account?.account.id,confirmation:confirmation || undefined,...(kind === 'cash' && value !== undefined ? {given:value} : {})},order.revision);
      }
      onDone();
    } catch (error) {
      if (error instanceof CreditLimitError) {setConfirmation({balance:error.balance,limit:error.limit});setError(`New balance ${formatMoney(error.proposed,order.currency)} exceeds the limit ${formatMoney(error.limit,order.currency)}. Confirm Give anyway only if you agree.`);}
      else {setError(errorText(error));setConfirmation(null);}
    } finally {busy.current = false;setSaving(false);}
  }
  if (editing && customer) return <><Button kind="ghost" onClick={() => setEditing(false)}>Back to payment</Button><CreditTermsForm setup={setup} customer={customer} account={account?.account} onSaved={() => {setEditing(false);setConfirmation(null);}} /></>;
  return <form className="khata-form" onSubmit={event => void save(event)}><p>{order.number} · {order.customer.name}</p><p>{refund ? 'Record money you have actually returned. Mise does not transfer money for you.' : `Confirm the payment you received, or add ${formatMoney(order.total || 0,order.currency)} to the customer’s khata.`}</p><fieldset className="khata-fieldset" disabled={saving}><legend className="sr-only">{refund ? 'Refund details' : 'Payment details'}</legend>
    {refund ? <label>Refund amount ({order.currency})<input required inputMode="decimal" aria-label={`Refund amount (${order.currency})`} value={amount} onChange={event => setAmount(event.target.value)} /><small>Remaining owed {formatMoney(order.payment.cancellation?.refundDue || 0,order.currency)}. Partial refunds are allowed.</small></label> : <p className="order-payment-total">Total {formatMoney(order.total || 0,order.currency)}</p>}
    <label>{refund ? 'Returned by' : 'Payment method'}<select aria-label={refund ? 'Returned by' : 'Payment method'} value={method} onChange={event => {setMethod(event.target.value);setConfirmation(null);}}><option value="cash">Cash</option>{wallets.map(wallet => <option key={wallet} value={wallet}>{wallet}</option>)}<option value="card">Card</option>{!refund ? <option value="credit">Khata / Credit</option> : null}</select></label>
    {!refund && kind === 'cash' ? <label>Cash given (optional)<input inputMode="decimal" value={given} onChange={event => setGiven(event.target.value)} /></label> : null}
    {!refund && kind === 'credit' ? <><p>{account ? `${formatMoney(account.balance,order.currency)} due · limit ${formatMoney(account.account.limit,order.currency)}` : 'Choose a saved customer through Change order before using khata.'}</p>{customer && customer.archivedAt === undefined ? <Button type="button" kind="secondary" onClick={() => setEditing(true)}>{account?.account.allowed ? 'Change credit settings' : 'Set credit limit'}</Button> : null}</> : null}
    {refund ? <label>Refund note (optional)<textarea maxLength={1000} rows={2} value={note} onChange={event => setNote(event.target.value)} /></label> : null}</fieldset>
    {error ? <p role="alert" className="form-error">{error}</p> : null}<footer className="sheet-actions"><Button type="submit" disabled={saving || (!refund && kind === 'credit' && !account?.account.allowed)}>{saving ? 'Saving…' : refund ? 'Record refund' : confirmation ? 'Give anyway' : kind === 'credit' ? 'Add to khata' : 'Record payment received'}</Button></footer></form>;
}
