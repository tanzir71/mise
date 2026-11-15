import { expect, test } from 'vitest';
import { setupCommand } from '../packages/core/setup';
import { recordSaleCommand, undoSaleCommand, canUndoSale, dailySales, saleTotals, givenSuggestions, receiptText } from '../packages/core/sales';

const seeded = setupCommand({ businessType: 'corner_shop', marketCode: 'BD', name: 'Test shop', phone: '01712345482' });
const context = { setup: seeded.snapshot, items: seeded.items, wallets: ['Cash', 'bKash', 'Nagad'] };
const cash = { expression: '75+150+20', method: 'cash' } as const;
test('cash command captures exact given/change, actor, currency and an immutable receipt snapshot', () => {
  const result = recordSaleCommand({ ...cash, given: 50000, who: ' Akter apa ' }, context, 1000);
  expect(result.sale).toMatchObject({ amount: 24500, given: 50000, change: 25500, who: 'Akter apa', currency: 'BDT', shopName: 'Test shop', createdBy: seeded.snapshot.owner.id });
  expect(result.event).toMatchObject({ id: result.sale.eventId, command: 'sale.record', before: null, after: result.sale, actor: { type: 'member', id: seeded.snapshot.owner.id } });
  expect(receiptText(result.sale)).toContain('Total: ৳245 · Cash');
  expect(receiptText(result.sale)).toContain('Given: ৳500 · Change: ৳255');
  expect(recordSaleCommand(cash, context).sale.change).toBe(0);
});
test('sale commands reject invalid totals, payments and cash given without storing floats', () => {
  for (const expression of ['0', '-1', '1/0', '2+']) expect(() => recordSaleCommand({ ...cash, expression }, context)).toThrow(/total/);
  for (const given of [24499, 25000.1, Infinity]) expect(() => recordSaleCommand({ ...cash, given }, context)).toThrow(/Given/);
  expect(() => recordSaleCommand({ ...cash, method: 'wallet', wallet: 'Unknown' }, context)).toThrow(/wallet/);
  expect(() => recordSaleCommand({ ...cash, method: 'wallet', wallet: 'Cash' }, context)).toThrow(/wallet/);
  expect(() => recordSaleCommand({ ...cash, method: 'card', given: 25000 }, context)).toThrow(/cash/);
  expect(recordSaleCommand({ ...cash, method: 'wallet', wallet: 'bKash' }, context).sale).toMatchObject({ methodName: 'bKash', given: undefined, change: undefined });
});
test('named lines use current, available, outlet-scoped catalogue snapshots', () => {
  const item = seeded.items[0], line = { itemId: item.id, unitPrice: item.price, qty: 2 };
  const result = recordSaleCommand({ ...cash, items: [line] }, context);
  expect(result.sale.items[0]).toMatchObject({ name: item.name, unitPrice: item.price, lineTotal: item.price * 2, qty: 2 });
  expect(() => recordSaleCommand({ ...cash, items: [line] }, { ...context, items: [{ ...item, available: false }] })).toThrow(/available/);
  expect(() => recordSaleCommand({ ...cash, items: [line] }, { ...context, items: [{ ...item, outletId: 'other' }] })).toThrow(/available/);
  expect(() => recordSaleCommand({ ...cash, items: [{ ...line, unitPrice: item.price + 1 }] }, context)).toThrow(/price changed/);
  expect(() => recordSaleCommand({ ...cash, items: [{ ...line, qty: 0.5 }] }, context)).toThrow(/quantity/);
});
test('undo is once only, within ten minutes, and links its complete audit event', () => {
  const { sale } = recordSaleCommand(cash, context, 1000);
  expect(canUndoSale(sale, 999)).toBe(false); expect(canUndoSale(sale, 601000)).toBe(true);
  expect(canUndoSale(sale, 601001)).toBe(false);
  const undo = undoSaleCommand(sale, 'owner', 601000);
  expect(undo.event).toMatchObject({ command: 'sale.undo', before: sale, after: undo.sale, undoOf: sale.eventId });
  expect(() => undoSaleCommand(undo.sale, 'owner', 601000)).toThrow(/once/);
  expect(() => undoSaleCommand(sale, 'owner', 601001)).toThrow(/10 minutes/);
});
test('day selection follows the outlet timezone; totals separate methods/currencies and exclude undone sales', () => {
  const at = Date.UTC(2026, 10, 15, 18, 30), { sale } = recordSaleCommand(cash, context, at);
  const previous = { ...sale, id: 'old', createdAt: at - 3600000 };
  expect(dailySales([sale, previous], 'Asia/Dhaka', at)).toEqual([sale]);
  expect(dailySales([sale, previous], 'UTC', at)).toHaveLength(2);
  const undone = undoSaleCommand(sale, 'owner', at + 1).sale;
  expect(saleTotals([sale, { ...sale, id: 'wallet', methodName: 'bKash' }, { ...sale, id: 'usd', currency: 'USD' }, undone])).toEqual([
    { currency: 'BDT', method: 'Cash', amount: 24500, count: 1 }, { currency: 'BDT', method: 'bKash', amount: 24500, count: 1 }, { currency: 'USD', method: 'Cash', amount: 24500, count: 1 },
  ]);
  expect(() => saleTotals([{ ...sale, amount: Number.MAX_SAFE_INTEGER }, sale])).toThrow(/supported/);
});
test('round cash suggestions match the counter reference and stay exact', () => {
  expect(givenSuggestions(24500, 'BDT')).toEqual([25000, 30000, 50000, 100000]);
  expect(givenSuggestions(24500000, 'IDR')).toEqual([25000000, 30000000, 50000000, 100000000]);
  expect(givenSuggestions(0, 'BDT')).toEqual([]);
});
test('receipts include an existing HTTPS shop link only, and do not promise customer registration', () => {
  const shop = { ...context.setup, outlet: { ...context.setup.outlet, shopLink: 'https://example.com/shop' } };
  expect(receiptText(recordSaleCommand(cash, { ...context, setup: shop }).sale)).toContain('https://example.com/shop');
  shop.outlet.shopLink = 'javascript:alert(1)';
  expect(receiptText(recordSaleCommand(cash, { ...context, setup: shop }).sale)).not.toContain('javascript:');
});
