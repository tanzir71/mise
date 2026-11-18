import { activeEntries } from './khata';
import { civilDay, creditOverview } from './khata-reports';
import { saleCashIn, refundCashOut } from './order-payments';
import { isOrderFinished } from './orders';
import { stockIsLow } from './stock';
import { validateShop, type NamedShopSetup } from './shop-access';
import type { CreditAccount, CreditEntry, Customer, DayClosing, DaySummary, Order, OrderRefund, Sale, SetupSnapshot, StockItem } from './models';

export interface TodayContext<S extends NamedShopSetup=SetupSnapshot> {
  setup:S; sales:Sale[]; orders:Order[]; refunds:OrderRefund[];
  accounts:CreditAccount[]; entries:CreditEntry[]; customers:Customer[]; stock:StockItem[]; closings:DayClosing[];
}
export function dayKey(at:number, timezone:string):string {
  if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000) throw new Error('Choose a valid day.');
  const value = new Date(civilDay(at,timezone)*86400000).toISOString();
  if (!/^\d{4}-/.test(value)) throw new Error('Choose a day from year 0000 to 9999.');
  return value.slice(0,10);
}
export function safeTotal(values:number[]):number {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error('Use integer minor units.');
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The total exceeds the supported amount.');
  return Number(total);
}
/** Current records, grouped by the outlet's civil day. A saved closing keeps its own immutable snapshot. */
export function todayOverview(context:TodayContext<NamedShopSetup>, at = Date.now()) {
  const {setup} = context; validateShop(setup);
  const {id:outletId,currency,timezone} = setup.outlet, day = dayKey(at,timezone);
  const onDay = (record:{createdAt:number}) => record.createdAt <= at && dayKey(record.createdAt,timezone) === day;
  const scoped = <T extends {outletId:string;currency:string}>(records:T[]) => records.filter(record => record.outletId === outletId && record.currency === currency);
  const sales = scoped(context.sales), receipts = sales.filter(onDay), activeSales = receipts.filter(sale => sale.voidedAt === undefined);
  const entriesByAccount = new Map<string,CreditEntry[]>();
  for (const entry of context.entries) {const group = entriesByAccount.get(entry.accountId) || [];group.push(entry);entriesByAccount.set(entry.accountId,group);}
  const accounts = scoped(context.accounts), entries = accounts.flatMap(account => activeEntries(account,entriesByAccount.get(account.id) || []));
  const dayEntries = entries.filter(onDay), activeSaleIds = new Set(sales.filter(sale => sale.voidedAt === undefined).map(sale => sale.id));
  const payments = dayEntries.filter(entry => entry.type === 'payment'), refunds = scoped(context.refunds).filter(onDay).filter(refund => refund.voidedAt === undefined);
  const orders = context.orders.filter(order => order.outletId === outletId && order.createdAt <= at);
  const waiting = orders.filter(order => !isOrderFinished(order) && (!order.scheduledFor || order.scheduledFor <= at)).sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  const completed = orders.filter(order => ['delivered','collected','done'].includes(order.status) && order.statusChangedAt <= at && order.statusChangedAt >= order.createdAt && dayKey(order.statusChangedAt,timezone) === day);
  const lowStock = context.stock.filter(item => item.outletId === outletId && item.archivedAt === undefined && stockIsLow(item));
  const activeCustomers = new Set(context.customers.filter(customer => customer.businessId === setup.business.id && customer.archivedAt === undefined).map(customer => customer.id));
  const dueReminders = accounts.filter(account => activeCustomers.has(account.customerId)).map(account => creditOverview(account,entriesByAccount.get(account.id) || [],timezone,setup.business.marketCode,at)).filter(row => row.dueThisWeek);
  const cashSales = safeTotal(receipts.map(saleCashIn)), cashCollections = safeTotal(payments.filter(entry => entry.methodName === 'Cash').map(entry => entry.amount)), cashRefunds = safeTotal(refunds.map(refundCashOut));
  const split = (['cash','wallet','card','credit'] as const).map(method => ({method,amount:safeTotal(activeSales.filter(sale => sale.method === method).map(sale => sale.amount)),count:activeSales.filter(sale => sale.method === method).length}));
  const summary:DaySummary = {
    day,timezone,currency,shopName:setup.business.name,outletName:setup.outlet.name,
    sales:safeTotal(activeSales.map(sale => sale.amount)),saleCount:activeSales.length,
    orderCount:orders.filter(order => order.currency === currency && onDay(order) && order.status !== 'cancelled').length,
    creditGiven:safeTotal(dayEntries.filter(entry => entry.type === 'charge' && (!entry.saleId || activeSaleIds.has(entry.saleId))).map(entry => entry.amount)),
    creditCollected:safeTotal(dayEntries.filter(entry => entry.type === 'payment' || entry.type === 'refund').map(entry => entry.type === 'refund' ? -entry.amount : entry.amount)),
    cashSales,cashCollections,cashRefunds,expectedCash:safeTotal([cashSales,cashCollections,-cashRefunds]),
    split,completedOrders:completed.length,averageTimeMs:completed.length ? Math.round(safeTotal(completed.map(order => order.statusChangedAt-order.createdAt))/completed.length) : null,
    waitingOrders:waiting.length,lowStock:lowStock.length,dueReminders:new Set(dueReminders.map(row => row.account.customerId)).size,
  };
  const closing = context.closings.find(record => record.outletId === outletId && record.currency === currency && record.day === day && record.voidedAt === undefined) || null;
  const givenPeople = new Set(dayEntries.filter(entry => entry.type === 'charge' && (!entry.saleId || activeSaleIds.has(entry.saleId))).map(entry => entry.customerId)).size;
  const collectedPeople = new Set(payments.map(entry => entry.customerId)).size;
  return {summary,waiting,lowStock,dueReminders,closing,givenPeople,collectedPeople};
}
export function closingPreview(context:TodayContext<NamedShopSetup>, at = Date.now()) {
  const {summary} = todayOverview(context,at);
  return {summary,fingerprint:JSON.stringify(summary)};
}
/** Arbitrary positive denomination values allow notes, coins and a typed total in every market. */
export function denominationTotal(lines:{value:number;count:number}[]):number {
  if (lines.length > 30 || new Set(lines.map(line => line.value)).size !== lines.length) throw new Error('Use up to 30 different denominations.');
  const values = lines.map(line => {
    if (!Number.isSafeInteger(line.value) || line.value <= 0 || !Number.isSafeInteger(line.count) || line.count < 0 || line.count > 1000000) throw new Error('Use a positive denomination and a whole count from 0 to 1,000,000.');
    const amount = BigInt(line.value)*BigInt(line.count);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The cash count exceeds the supported amount.');
    return Number(amount);
  });
  return safeTotal(values);
}
