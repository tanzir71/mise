import {
  isCustomerCommand,
  type ShopCommand,
  type CustomerCommand,
} from './shop-commands';
import type { LocalRowChange } from './local-outbox';
import { validSavedCurrency } from './order-currency';

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const metadataOnly = (c: CustomerCommand) =>
  c.type === 'customer.update' && c.credit === null && c.opening === null;
function earlierCreation(
  c: Extract<CustomerCommand, { type: 'khata.settings' }>,
  changes: readonly LocalRowChange[],
  priorCommands: readonly ShopCommand[],
  currency: unknown,
): boolean {
  return priorCommands.some((prior) => {
    if (
      !isCustomerCommand(prior) ||
      !('ids' in prior) ||
      prior.ids.accountId !== c.accountId ||
      prior.customerId !== c.customerId ||
      prior.outletId !== c.outletId
    )
      return false;
    const eventId =
      prior.type === 'khata.settings'
        ? prior.accountId === null
          ? prior.id
          : null
        : prior.ids.accountEventId;
    if (eventId === null) return false;
    const audits = changes.filter(
        (row) => row.table === 'events' && row.key === eventId,
      ),
      event = audits[0]?.after;
    return (
      audits.length === 1 &&
      audits[0].before === null &&
      object(event) &&
      event.id === eventId &&
      event.command === 'khata.create' &&
      event.customerId === c.customerId &&
      event.outletId === c.outletId &&
      event.before === null &&
      object(event.after) &&
      event.after.id === c.accountId &&
      event.after.customerId === c.customerId &&
      event.after.outletId === c.outletId &&
      event.after.currency === currency
    );
  });
}

/** Read only the original changed khata/opening images. A contact-only edit has
 * no monetary assertion; it must not manufacture an account from a new profile. */
export function savedCustomerCurrency(
  command: ShopCommand,
  changes: readonly LocalRowChange[],
  priorCommands: readonly ShopCommand[] = [],
): string | undefined {
  if (!isCustomerCommand(command) || !('ids' in command)) return undefined;
  const c = command,
    accounts = changes.filter(
      (row) => row.table === 'creditAccounts' && row.key === c.ids.accountId,
    );
  if (accounts.length === 0 && metadataOnly(c)) return undefined;
  if (accounts.length !== 1)
    throw Error('Keep the complete original khata settings.');
  const { before, after } = accounts[0];
  if (
    !object(after) ||
    after.id !== c.ids.accountId ||
    after.customerId !== c.customerId ||
    after.outletId !== c.outletId ||
    !validSavedCurrency(after.currency) ||
    (before !== null &&
      (!object(before) ||
        before.id !== after.id ||
        before.customerId !== c.customerId ||
        before.outletId !== c.outletId ||
        before.currency !== after.currency)) ||
    (c.type === 'customer.create' && before !== null) ||
    (c.type === 'khata.settings' &&
      (c.accountId === null
        ? before !== null
        : before === null &&
          !earlierCreation(c, changes, priorCommands, after.currency)))
  )
    throw Error('Keep the original khata currency.');
  if (
    (c.type === 'customer.create' || c.type === 'customer.update') &&
    c.opening !== null
  ) {
    const entries = changes.filter(
        (row) =>
          row.table === 'creditEntries' && row.key === c.ids.openingEntryId,
      ),
      entry = entries[0]?.after;
    if (
      entries.length !== 1 ||
      entries[0].before !== null ||
      !object(entry) ||
      entry.id !== c.ids.openingEntryId ||
      entry.accountId !== c.ids.accountId ||
      entry.customerId !== c.customerId ||
      entry.outletId !== c.outletId ||
      entry.currency !== after.currency
    )
      throw Error('Keep the original opening balance and its currency.');
  }
  return after.currency;
}

/** Apply after actual outcome lookup and on every fresh SQL/projection retry.
 * A metadata edit with no source unit cannot silently create a new khata. */
export function proposedCustomerCurrencyMatches(
  c: CustomerCommand,
  records: unknown,
  currency: unknown,
): boolean {
  if (!('ids' in c)) return true;
  if (
    !Array.isArray(records) ||
    !records.every(
      (row): row is { table: string; values: Record<string, unknown> } =>
        object(row) && typeof row.table === 'string' && object(row.values),
    )
  )
    return false;
  const accounts = records.filter((row) => row.table === 'credit_accounts'),
    entries = records.filter((row) => row.table === 'credit_entries');
  if (accounts.length === 0 && entries.length === 0)
    return (
      metadataOnly(c) &&
      (currency === undefined || validSavedCurrency(currency))
    );
  if (!validSavedCurrency(currency) || accounts.length !== 1) return false;
  const account = accounts[0].values;
  if (
    account.id !== c.ids.accountId ||
    account.customer_id !== c.customerId ||
    account.outlet_id !== c.outletId ||
    account.currency !== currency
  )
    return false;
  if (
    (c.type === 'customer.create' || c.type === 'customer.update') &&
    c.opening !== null
  ) {
    if (entries.length !== 1) return false;
    const entry = entries[0].values;
    return (
      entry.id === c.ids.openingEntryId &&
      entry.account_id === c.ids.accountId &&
      entry.customer_id === c.customerId &&
      entry.outlet_id === c.outletId &&
      entry.currency === currency
    );
  }
  return entries.length === 0;
}
