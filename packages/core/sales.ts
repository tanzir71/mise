import { ulid } from 'ulid';
import { calculateAmount, normalizeExpression } from './calc';
import { currencyDigits, formatMoney } from './money';
import { orderableItems } from './catalogue';
import type { AuditEvent, Item, Sale, PaymentMethod, SetupSnapshot } from './models';

export interface SaleInput { expression: string; method: PaymentMethod; wallet?: string; given?: number; who?: string; items?: { itemId: string; qty: number; unitPrice: number }[] }
export interface SaleContext { setup: SetupSnapshot; items: Item[]; wallets: string[] }
export function recordSaleCommand(input: SaleInput, context: SaleContext, at = Date.now()): { sale: Sale; event: AuditEvent } {
  const { setup } = context, amount = calculateAmount(input.expression, setup.outlet.currency);
  if (amount === null || amount <= 0) throw new Error('Enter a total greater than zero.');
  if (!['cash', 'wallet', 'card'].includes(input.method)) throw new Error('Choose a payment method.');
  if (input.method === 'wallet' && (!input.wallet || input.wallet === 'Cash' || !context.wallets.includes(input.wallet))) throw new Error('Choose a wallet available in this market.');
  if ((input.who?.trim().length || 0) > 80) throw new Error('Use a name of at most 80 characters.');
  const given = input.method === 'cash' ? input.given ?? amount : undefined;
  if (given !== undefined && (!Number.isSafeInteger(given) || given < amount)) throw new Error('Given must cover the total.');
  if (input.method !== 'cash' && input.given !== undefined) throw new Error('Given is only used for cash.');
  if ((input.items?.length || 0) > 200) throw new Error('Use at most 200 item lines.');
  const available = new Map(orderableItems(context.items).filter(item => item.outletId === setup.outlet.id).map(item => [item.id, item]));
  const items = (input.items || []).map(line => {
    const item = available.get(line.itemId);
    if (!item) throw new Error('An item is no longer available. Remove it from this sale.');
    if (item.price !== line.unitPrice) throw new Error('An item price changed. Remove and add it again.');
    const total = BigInt(item.price) * BigInt(Number.isSafeInteger(line.qty) ? line.qty : 0);
    if (!Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > 999 || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Use a quantity between 1 and 999.');
    return { itemId: item.id, name: item.name, unit: item.unit, qty: line.qty, unitPrice: item.price, lineTotal: Number(total) };
  });
  let shopLink: string | undefined;
  if (setup.outlet.shopLink) { try { const url = new URL(setup.outlet.shopLink); if (url.protocol === 'https:') shopLink = url.href; } catch { /* A receipt still works without a shop link. */ } }
  const eventId = ulid(at);
  const sale: Sale = { id: ulid(at), outletId: setup.outlet.id, expression: normalizeExpression(input.expression), amount, currency: setup.outlet.currency, method: input.method, methodName: input.method === 'wallet' ? input.wallet! : input.method === 'cash' ? 'Cash' : 'Card', given, change: given === undefined ? undefined : given - amount, who: input.who?.trim() || '', items, shopName: setup.business.name, shopLink, timezone: setup.outlet.timezone, createdBy: setup.owner.id, eventId, createdAt: at, updatedAt: at };
  return { sale, event: { id: eventId, outletId: sale.outletId, actor: { type: 'member', id: setup.owner.id }, command: 'sale.record', before: null, after: sale, at } };
}
export const canUndoSale = (sale: Sale, at = Date.now()) => sale.voidedAt === undefined && at >= sale.createdAt && at - sale.createdAt <= 600000;
export function undoSaleCommand(sale: Sale, actorId: string, at = Date.now()): { sale: Sale; event: AuditEvent } {
  if (!canUndoSale(sale, at)) throw new Error('A sale can be undone once, within 10 minutes.');
  const after = { ...sale, voidedAt: at, updatedAt: at };
  return { sale: after, event: { id: ulid(at), outletId: sale.outletId, actor: { type: 'member', id: actorId }, command: 'sale.undo', before: sale, after, undoOf: sale.eventId, at } };
}
export function dailySales(sales: Sale[], timezone: string, at = Date.now()): Sale[] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = formatter.format(at);
  return sales.filter(sale => sale.voidedAt === undefined && formatter.format(sale.createdAt) === day);
}
export function saleTotals(sales: Sale[]): { currency: string; method: string; amount: number; count: number }[] {
  const groups = new Map<string, { currency: string; method: string; amount: bigint; count: number }>();
  for (const sale of sales.filter(sale => sale.voidedAt === undefined)) {
    const key = `${sale.currency}:${sale.methodName}`, group = groups.get(key) || { currency: sale.currency, method: sale.methodName, amount: 0n, count: 0 };
    group.amount += BigInt(sale.amount); group.count++; groups.set(key, group);
  }
  return [...groups.values()].map(group => { if (group.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The total exceeds the supported amount.'); return { ...group, amount: Number(group.amount) }; });
}
export function givenSuggestions(amount: number, currency: string): number[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) return [];
  const scale = 10n ** BigInt(currencyDigits(currency)), base = currency === 'IDR' ? 1000n : 1n, value = BigInt(amount);
  const suggestions = new Set<number>();
  for (const step of [5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000]) {
    const increment = BigInt(step) * base * scale;
    if (increment * 50n < value) continue;
    const next = (value + increment - 1n) / increment * increment;
    if (next > value && next <= BigInt(Number.MAX_SAFE_INTEGER)) suggestions.add(Number(next));
    if (suggestions.size === 4) break;
  }
  return [...suggestions];
}
export function receiptText(sale: Sale): string {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: sale.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(sale.createdAt);
  return [sale.shopName, `Receipt ${sale.id.slice(-6)}`, date, sale.who && `For: ${sale.who}`, sale.items.length && 'Catalogue prices before adjustments:', ...sale.items.map(line => `${line.qty} × ${line.name} · ${formatMoney(line.lineTotal, sale.currency)}`), `Calculation: ${sale.expression}`, `Total: ${formatMoney(sale.amount, sale.currency)} · ${sale.methodName}`, sale.given !== undefined && `Given: ${formatMoney(sale.given, sale.currency)} · Change: ${formatMoney(sale.change || 0, sale.currency)}`, sale.voidedAt !== undefined && 'UNDONE', sale.shopLink, 'Thank you.'].filter(Boolean).join('\n');
}
