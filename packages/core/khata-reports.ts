import { activeEntries, creditBalance, outstandingLots } from './khata';
import { marketPacks, type MarketCode } from './packs';
import type { CreditAccount, CreditEntry } from './models';
const DAY = 86400000, formatters = new Map<string,Intl.DateTimeFormat>();
function parts(at: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'numeric',day:'numeric'}); formatters.set(timezone,formatter); }
  const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type,part.value]));
  return { year:Number(values.year),month:Number(values.month),day:Number(values.day) };
}
export function civilDay(at: number, timezone: string): number { const value = parts(at,timezone); return Date.UTC(value.year,value.month-1,value.day)/DAY; }
export function marketWeekStart(market: MarketCode): number { const day = marketPacks[market]['week/weekend'].at(-1) || 'Sun'; return (['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day)+1)%7; }
function total(values: number[]): number {
  const sum = values.reduce((sum,value) => sum+BigInt(value),0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The total exceeds the supported amount.');
  return Number(sum);
}
export interface CreditOverview { account: CreditAccount; balance: number; since: number | null; ageDays: number; over30Amount: number; collectedThisWeek: number; lastPaymentAt: number | null; lastReminderAt: number | null; dueThisWeek: boolean; dueOn: string | null; overLimit: boolean }
export function creditOverview(account: CreditAccount, entries: CreditEntry[], timezone: string, market: MarketCode, at = Date.now()): CreditOverview {
  const balance = creditBalance(account,entries), lots = outstandingLots(account,entries), since = lots[0]?.at ?? null;
  const day = civilDay(at,timezone), weekStart = day-((new Date(day*DAY).getUTCDay()-marketWeekStart(market)+7)%7);
  const records = activeEntries(account,entries), payments = records.filter(entry => entry.type === 'payment');
  const reminders = records.filter(entry => entry.type === 'reminder' && entry.purpose !== 'receipt');
  const lastPaymentAt = payments.length ? Math.max(...payments.map(entry => entry.createdAt)) : null;
  const lastReminderAt = reminders.length ? Math.max(...reminders.map(entry => entry.createdAt)) : null;
  let dueOn: string | null = null, dueThisWeek = false;
  if (balance > 0 && since !== null && account.reminder.enabled) {
    const current = parts(at,timezone);
    let year = current.year, month = current.month;
    const dueDay = () => Date.UTC(year,month-1,Math.min(account.reminder.dayOfMonth,new Date(Date.UTC(year,month,0)).getUTCDate()))/DAY;
    if (dueDay() < civilDay(since,timezone)) { month++; if (month > 12) { year++; month = 1; } }
    const due = dueDay(), last = lastReminderAt === null ? null : parts(lastReminderAt,timezone);
    const completed = Boolean(last && last.year === year && last.month === month && lastReminderAt! >= since);
    dueOn = new Date(due*DAY).toISOString().slice(0,10);
    dueThisWeek = !completed && due <= weekStart+6; // Includes missed reminders from earlier this month.
  }
  return {account,balance,since,ageDays:since === null ? 0 : Math.max(0,day-civilDay(since,timezone)),over30Amount:total(lots.filter(lot => day-civilDay(lot.at,timezone) > 30).map(lot => lot.amount)),collectedThisWeek:total(records.filter(entry => entry.type === 'payment' || entry.type === 'refund').filter(entry => { const on = civilDay(entry.createdAt,timezone); return on >= weekStart && on <= day && entry.createdAt <= at; }).map(entry => entry.type === 'refund' ? -entry.amount : entry.amount)),lastPaymentAt,lastReminderAt,dueThisWeek,dueOn,overLimit:balance > account.limit};
}
export type CreditFilter = 'all'|'due-week'|'over-30'|'over-limit'|'paid-up';
export function filterCreditOverviews(rows: CreditOverview[], filter: CreditFilter): CreditOverview[] {
  return rows.filter(row => filter === 'all' || (filter === 'due-week' ? row.dueThisWeek : filter === 'over-30' ? row.over30Amount > 0 : filter === 'over-limit' ? row.overLimit : row.balance <= 0)).sort((a,b) => b.ageDays-a.ageDays || (a.balance === b.balance ? a.account.id.localeCompare(b.account.id) : a.balance < b.balance ? 1 : -1));
}
export function khataTotals(rows: CreditOverview[]): { currency: string; due: number; people: number; collected: number; over30: number }[] {
  const currencies = [...new Set(rows.map(row => row.account.currency))];
  return currencies.map(currency => { const group = rows.filter(row => row.account.currency === currency); return {currency,due:total(group.map(row => Math.max(0,row.balance))),people:new Set(group.filter(row => row.balance > 0).map(row => row.account.customerId)).size,collected:total(group.map(row => row.collectedThisWeek)),over30:total(group.map(row => row.over30Amount))}; });
}
