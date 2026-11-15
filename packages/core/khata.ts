import { ulid } from 'ulid';
import { customerEvent } from './customers';
import type { AuditEvent, CreditAccount, CreditEntry, CreditReminder, Customer, PaymentMethod, SetupSnapshot } from './models';

export interface CreditTermsInput { allowed: boolean; limit: number; reminder: CreditReminder }
export const defaultCreditTerms: CreditTermsInput = { allowed:false, limit:0, reminder:{enabled:false,dayOfMonth:2,tone:'gentle',channel:'whatsapp'} };
export interface LedgerContext { setup: SetupSnapshot; customer: Customer; account: CreditAccount; entries: CreditEntry[] }
export interface OverLimitConfirmation { balance: number; limit: number }
export class CreditLimitError extends Error {
  constructor(public balance: number, public limit: number, public proposed: number) { super('This would exceed the customer’s credit limit. Confirm Give anyway to continue.'); this.name = 'CreditLimitError'; }
}
function safeAmount(value: number, positive = false) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0)) throw new Error('Use a valid amount in minor units.');
}
function checked(value: bigint): number {
  if (value < -BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The khata balance exceeds the supported amount.');
  return Number(value);
}
export function entryDelta(entry: CreditEntry): number {
  safeAmount(entry.amount);
  if (!['charge','payment','adjustment','reminder'].includes(entry.type)) throw new Error('This khata contains an unsupported entry.');
  if (entry.type === 'reminder') { if (entry.amount !== 0) throw new Error('A reminder cannot change the balance.'); return 0; }
  if ((entry.type === 'charge' || entry.type === 'payment') && entry.amount <= 0) throw new Error('Charges and payments must use positive amounts.');
  return entry.type === 'payment' ? -entry.amount : entry.amount;
}
export function accountEntries(account: CreditAccount, entries: CreditEntry[]): CreditEntry[] {
  return entries.filter(entry => entry.accountId === account.id).map(entry => {
    if (entry.currency !== account.currency || entry.customerId !== account.customerId || entry.outletId !== account.outletId) throw new Error('This khata contains an entry from another account or currency.');
    return entry;
  });
}
export const creditBalance = (account: CreditAccount, entries: CreditEntry[]): number => checked(accountEntries(account,entries).reduce((sum,entry) => sum+BigInt(entryDelta(entry)),0n));
export function activeEntries(account: CreditAccount, entries: CreditEntry[]): CreditEntry[] {
  const records = accountEntries(account,entries), reversed = new Set(records.map(entry => entry.reversalOf).filter(Boolean));
  return records.filter(entry => !entry.reversalOf && !reversed.has(entry.id));
}
export function validateCreditContext(context: LedgerContext, active = true) {
  const { setup, customer, account } = context;
  if (customer.businessId !== setup.business.id || account.customerId !== customer.id || account.outletId !== setup.outlet.id) throw new Error('This khata belongs to another shop.');
  if (active && customer.archivedAt !== undefined) throw new Error('Restore this customer before changing their khata.');
}
export function saveCreditTermsCommand(input: CreditTermsInput, customer: Customer, setup: SetupSnapshot, before: CreditAccount | null = null, at = Date.now()): { account: CreditAccount; event: AuditEvent } {
  if (customer.businessId !== setup.business.id || customer.archivedAt !== undefined) throw new Error('Choose an active customer from this shop.');
  if (before && (before.customerId !== customer.id || before.outletId !== setup.outlet.id)) throw new Error('This khata belongs to another customer or outlet.');
  safeAmount(input.limit); if (input.limit < 0) throw new Error('The credit limit cannot be negative.');
  if (!Number.isInteger(input.reminder.dayOfMonth) || input.reminder.dayOfMonth < 1 || input.reminder.dayOfMonth > 31 || !['gentle','direct'].includes(input.reminder.tone) || input.reminder.channel !== 'whatsapp') throw new Error('Choose a monthly reminder day from 1 to 31 and a supported tone.');
  const account: CreditAccount = { id: before?.id || ulid(at), customerId:customer.id, outletId:setup.outlet.id, currency:before?.currency || setup.outlet.currency, allowed:Boolean(input.allowed), limit:input.limit, reminder:{...input.reminder,enabled:Boolean(input.reminder.enabled)}, createdAt:before?.createdAt ?? at, updatedAt:at };
  return { account, event:customerEvent(before ? 'khata.settings' : 'khata.create',customer.id,before,account,setup,at) };
}
function entryCommand(context: LedgerContext, values: Pick<CreditEntry,'type'|'amount'|'note'> & Partial<Pick<CreditEntry,'saleId'|'methodName'|'occurredAt'|'reversalOf'|'purpose'|'overLimit'>>, command: string, at: number): { entry: CreditEntry; event: AuditEvent } {
  validateCreditContext(context); safeAmount(values.amount);
  if (values.note.length > 4000) throw new Error('Keep this note within 4,000 characters.');
  const event = customerEvent(command,context.customer.id,null,null,context.setup,at);
  const sequence = accountEntries(context.account,context.entries).reduce((max,entry) => Math.max(max,entry.sequence),0)+1;
  if (!Number.isSafeInteger(sequence)) throw new Error('The khata sequence exceeds the supported range.');
  const entry: CreditEntry = { id:ulid(at), accountId:context.account.id, customerId:context.customer.id, outletId:context.account.outletId, currency:context.account.currency, sequence, ...values, createdBy:context.setup.owner.id, eventId:event.id, createdAt:at, updatedAt:at };
  event.after = entry; return { entry,event };
}
export function chargeCreditCommand(amount: number, context: LedgerContext, options: { confirmation?: OverLimitConfirmation; note?: string; saleId?: string } = {}, at = Date.now()) {
  validateCreditContext(context); safeAmount(amount,true);
  const { account } = context;
  if (!account.allowed) throw new Error('Credit is turned off for this customer.');
  if (account.currency !== context.setup.outlet.currency) throw new Error('This khata uses another currency. Choose the current currency account.');
  const balance = creditBalance(account,context.entries), proposed = checked(BigInt(balance)+BigInt(amount));
  const over = proposed > account.limit;
  if (over && (options.confirmation?.balance !== balance || options.confirmation.limit !== account.limit)) throw new CreditLimitError(balance,account.limit,proposed);
  return entryCommand(context,{type:'charge',amount,note:options.note || '',saleId:options.saleId,overLimit:over ? {balance,limit:account.limit} : undefined},'khata.charge',at);
}
export function recordCreditPaymentCommand(amount: number, method: PaymentMethod, wallet: string | undefined, context: LedgerContext, wallets: string[], note = '', at = Date.now()) {
  validateCreditContext(context); safeAmount(amount,true);
  if (amount > creditBalance(context.account,context.entries)) throw new Error('A payment cannot exceed the amount due.');
  if (!['cash','wallet','card'].includes(method) || (method === 'wallet' && (!wallet || wallet === 'Cash' || !wallets.includes(wallet)))) throw new Error('Choose a supported payment method.');
  return entryCommand(context,{type:'payment',amount,note,methodName:method === 'wallet' ? wallet : method === 'card' ? 'Card' : 'Cash'},'khata.payment',at);
}
export function openingBalanceCommand(amount: number, occurredAt: number, context: LedgerContext, at = Date.now()) {
  validateCreditContext(context); safeAmount(amount,true);
  if (accountEntries(context.account,context.entries).length) throw new Error('An opening balance can only be set on an empty khata.');
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > at) throw new Error('Choose a balance date up to today.');
  return entryCommand(context,{type:'adjustment',amount,note:'Opening balance',occurredAt},'khata.opening-balance',at);
}
export const canUndoCreditEntry = (entry: CreditEntry, entries: CreditEntry[], at = Date.now()) => entry.type !== 'reminder' && !entry.reversalOf && at >= entry.createdAt && at-entry.createdAt <= 600000 && !entries.some(value => value.reversalOf === entry.id);
export function undoCreditEntryCommand(entry: CreditEntry, context: LedgerContext, at = Date.now(), fromSale = false) {
  validateCreditContext(context);
  const stored = accountEntries(context.account,context.entries).find(value => value.id === entry.id);
  if (!stored) throw new Error('Credit entry not found.');
  entry = stored;
  if (entry.accountId !== context.account.id || !canUndoCreditEntry(entry,context.entries,at)) throw new Error('This entry can be undone once, within 10 minutes.');
  if (entry.saleId && !fromSale) throw new Error('Undo the original sale to reverse this charge.');
  const delta = -entryDelta(entry), balance = creditBalance(context.account,context.entries);
  if (BigInt(balance)+BigInt(delta) < 0n) throw new Error('This credit has been partly paid. Undo the payment before undoing the charge.');
  checked(BigInt(balance)+BigInt(delta));
  const result = entryCommand(context,{type:'adjustment',amount:delta,note:'Entry undone',reversalOf:entry.id},'khata.undo',at);
  result.event.before = entry; result.event.undoOf = entry.eventId; return result;
}
export function recordCommunicationCommand(context: LedgerContext, purpose: 'reminder'|'receipt'|'call', text: string, channel: 'whatsapp'|'manual'|'call', at = Date.now()) {
  if (!['reminder','receipt','call'].includes(purpose) || !['whatsapp','manual','call'].includes(channel)) throw new Error('Choose a supported message action.');
  return entryCommand(context,{type:'reminder',amount:0,note:text,purpose,methodName:channel},`khata.${purpose}-sent`,at);
}
/** FIFO ageing excludes reversal pairs, so undoing a payment restores the original age. */
export function outstandingLots(account: CreditAccount, entries: CreditEntry[]): { amount: number; at: number }[] {
  const lots: {amount:bigint;at:number}[] = [];
  for (const entry of activeEntries(account,entries).sort((a,b) => a.sequence-b.sequence || a.id.localeCompare(b.id))) {
    const delta = BigInt(entryDelta(entry));
    if (delta > 0n) lots.push({amount:delta,at:entry.occurredAt ?? entry.createdAt});
    else if (delta < 0n) { let payment = -delta; while (payment > 0n && lots.length) { const applied = payment < lots[0].amount ? payment : lots[0].amount; lots[0].amount -= applied; payment -= applied; if (!lots[0].amount) lots.shift(); } }
  }
  return lots.map(lot => ({amount:checked(lot.amount),at:lot.at})).sort((a,b) => a.at-b.at);
}
export const outstandingSince = (account: CreditAccount, entries: CreditEntry[]): number | null => outstandingLots(account,entries)[0]?.at ?? null;
