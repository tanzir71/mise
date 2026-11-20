import { isMoneyCommand, type ShopCommand } from './shop-commands';
import type { MoneyCommand } from './money-commands';
import type { LocalRowChange } from './local-outbox';
import { validSavedCurrency } from './order-currency';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Original financial row identities, independent of today's shop profile. */
function sources(command: Exclude<MoneyCommand, { type: 'khata.communication' }>) {
  if (command.type === 'khata.payment')
    return [{ table: 'creditEntries', wire: 'credit_entries', id: command.entryId, existing: false }];
  if (command.type === 'khata.undo')
    return [{ table: 'creditEntries', wire: 'credit_entries', id: command.reversalId, existing: false }];
  const rows = [{ table: 'sales', wire: 'sales', id: command.saleId, existing: command.type === 'sale.undo' }];
  if (command.type === 'sale.credit' || command.type === 'sale.undo' && command.entryId)
    rows.push({ table: 'creditEntries', wire: 'credit_entries', id: command.entryId!, existing: false });
  return rows;
}

/** Read only immutable queue images; never consult mutable current settings. */
export function savedMoneyCurrency(
  command: ShopCommand,
  changes: readonly LocalRowChange[],
  priorCommands: readonly ShopCommand[] = [],
): string | undefined {
  if (!isMoneyCommand(command) || command.type === 'khata.communication')
    return undefined;
  let currency: string | undefined;
  for (const source of sources(command)) {
    const rows = changes.filter(row => row.table === source.table && row.key === source.id);
    if (rows.length !== 1) throw Error('Keep the complete original money action.');
    const { before, after } = rows[0];
    if (!object(after) || after.id !== source.id || after.outletId !== command.outletId ||
        !validSavedCurrency(after.currency) ||
        (source.existing
          ? before === null
            ? !priorCommands.some(prior => (prior.type === 'sale.record' || prior.type === 'sale.credit') && prior.saleId === source.id && prior.outletId === command.outletId)
            : !object(before) || before.id !== source.id || before.outletId !== command.outletId || before.currency !== after.currency
          : before !== null) ||
        currency !== undefined && currency !== after.currency)
      throw Error('Keep the original sale or khata currency.');
    if (source.table === 'creditEntries' &&
        ('accountId' in command && after.accountId !== command.accountId ||
         command.type === 'khata.undo' && after.reversalOf !== command.entryId ||
         command.type === 'sale.credit' && after.saleId !== command.saleId))
      throw Error('Keep the original financial companion.');
    currency = after.currency;
  }
  return currency;
}

/** Run after actual outcome lookup and on every newly prepared SQL retry. */
export function proposedMoneyCurrencyMatches(
  command: MoneyCommand,
  records: unknown,
  currency: unknown,
): boolean {
  if (command.type === 'khata.communication') return true;
  if (!validSavedCurrency(currency) || !Array.isArray(records) ||
      !records.every((row): row is { table: string; values: Record<string, unknown> } =>
        object(row) && typeof row.table === 'string' && object(row.values)))
    return false;
  return sources(command).every(source => {
    const rows = records.filter(row => row.table === source.wire && row.values.id === source.id);
    return rows.length === 1 && rows[0].values.outlet_id === command.outletId &&
      rows[0].values.currency === currency;
  }) && records.filter(row => row.table === 'sales' || row.table === 'credit_entries')
    .every(row => row.values.currency === currency);
}
