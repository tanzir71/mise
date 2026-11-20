import { isOrderCommand, type ShopCommand } from './shop-commands';
import type { OrderCommand } from './order-commands';
import type { LocalRowChange } from './local-outbox';

export const savedCurrencyHeader = 'X-Mise-Saved-Currency';
export const validSavedCurrency = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the immutable original order image, never the device's current profile. */
export function savedOrderCurrency(
  command: ShopCommand,
  changes: readonly LocalRowChange[],
): string | undefined {
  if (!isOrderCommand(command) || command.type === 'order.warning-settings')
    return undefined;
  const rows = changes.filter(
    (row) => row.table === 'orders' && row.key === command.orderId,
  );
  if (rows.length !== 1)
    throw Error('Keep the complete original order and its saved currency.');
  const { before, after } = rows[0];
  if (
    !object(after) ||
    after.id !== command.orderId ||
    after.outletId !== command.outletId ||
    !validSavedCurrency(after.currency) ||
    (before !== null &&
      (!object(before) ||
        before.id !== command.orderId ||
        before.outletId !== command.outletId ||
        before.currency !== after.currency))
  )
    throw Error(
      'Keep the original order currency. Review the saved source before sending.',
    );
  return after.currency;
}

/** Called after real outcome lookup and on every newly prepared retry. */
export function proposedOrderCurrencyMatches(
  command: OrderCommand,
  records: unknown,
  currency: unknown,
): boolean {
  if (command.type === 'order.warning-settings') return true;
  if (
    !validSavedCurrency(currency) ||
    !Array.isArray(records) ||
    !records.every(
      (row): row is { table: string; values: Record<string, unknown> } =>
        object(row) && typeof row.table === 'string' && object(row.values),
    )
  )
    return false;
  const orders = records.filter(
    (row) => row.table === 'orders' && row.values.id === command.orderId,
  );
  return (
    orders.length === 1 &&
    orders[0].values.currency === currency &&
    records
      .filter((row) =>
        ['sales', 'credit_entries', 'order_refunds'].includes(row.table),
      )
      .every((row) => row.values.currency === currency)
  );
}
