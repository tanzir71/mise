import { dayKey } from './today';
import { marketPacks, type MarketCode } from './packs';

export type ExportPeriodInput = {preset:'today'|'week'|'month'|'all'}|{preset:'custom';from:string;to:string};
export interface ExportPeriod {preset:ExportPeriodInput['preset'];from:string|null;to:string|null;timezone:string}
const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function validDate(value:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
function shift(day:string,count:number):string {const date = new Date(`${day}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+count);return date.toISOString().slice(0,10);}
/** Calendar periods are in the outlet timezone, including daylight-saving transitions. */
export function exportPeriod(input:ExportPeriodInput,timezone:string,market:MarketCode,at = Date.now()):ExportPeriod {
  const today = dayKey(at,timezone);
  if (!Object.hasOwn(marketPacks,market)) throw new Error('Choose a supported market.');
  if (input.preset === 'all') return {preset:'all',from:null,to:null,timezone};
  if (input.preset === 'custom') {
    if (!validDate(input.from) || !validDate(input.to) || input.from > input.to) throw new Error('Choose a valid start and end date in order.');
    return {preset:'custom',from:input.from,to:input.to,timezone};
  }
  if (input.preset === 'today') return {preset:'today',from:today,to:today,timezone};
  if (input.preset === 'month') {
    const from = `${today.slice(0,7)}-01`, next = new Date(`${from}T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1,0);
    return {preset:'month',from,to:next.toISOString().slice(0,10),timezone};
  }
  if (input.preset === 'week') {
    const weekend = marketPacks[market]['week/weekend'],weekStart = (weekdays.indexOf(weekend.at(-1) || 'Sun')+1)%7;
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(), from = shift(today,-((weekday-weekStart+7)%7));
    return {preset:'week',from,to:shift(from,6),timezone};
  }
  throw new Error('Choose today, week, month, custom dates or all dates.');
}
export function inExportPeriod(at:number,period:ExportPeriod):boolean {
  const day = dayKey(at,period.timezone);return (!period.from || day >= period.from) && (!period.to || day <= period.to);
}
