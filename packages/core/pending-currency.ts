import type { LocalOutboxEntry } from './local-outbox';
import type { ShopCommand } from './shop-commands';
import { savedOrderCurrency } from './order-currency';
import { savedMoneyCurrency } from './money-currency';
import { savedPurchaseCurrency } from './purchase-currency';

/** Index the detached original queue, not a mutable working/canonical profile.
 * Derive only when a command is genuinely pending; coverage is checked first. */
export function originalCurrencyReader(entries: readonly Pick<LocalOutboxEntry, 'commands' | 'changes'>[]) {
  const sources = new Map<string, { entry: typeof entries[number]; index: number }>();
  for (const entry of entries) for (let index = 0; index < entry.commands.length; index++) {
    const command = entry.commands[index];
    if (sources.has(command.id)) throw Error('Keep each original pending command identity.');
    sources.set(command.id, { entry, index });
  }
  return (command: ShopCommand): string | undefined => {
    const source = sources.get(command.id), original = source?.entry.commands[source.index];
    if (!source || !original || original.type !== command.type ||
        original.outletId !== command.outletId) throw Error('Keep the original pending currency source.');
    return savedOrderCurrency(command, source.entry.changes) ??
      savedMoneyCurrency(command, source.entry.changes, source.entry.commands.slice(0, source.index)) ??
      savedPurchaseCurrency(command, source.entry.changes, source.entry.commands.slice(0, source.index));
  };
}
