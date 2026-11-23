import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { creditOverview } from '@mise/core/khata-reports';
import type { CreditAccount, CreditEntry, SetupSnapshot } from '@mise/core/models';
import { formatMoney } from '@mise/core/money';
import { db } from './data/db';

export function useKhata(setup: SetupSnapshot) {
  const data = useLiveQuery(async () => {
    const [customers,accounts,entries,events,members] = await Promise.all([
      db.customers.where('businessId').equals(setup.business.id).toArray(), db.creditAccounts.where('outletId').equals(setup.outlet.id).toArray(),
      db.creditEntries.where('outletId').equals(setup.outlet.id).toArray(), db.events.where('outletId').equals(setup.outlet.id).toArray(), db.members.where('businessId').equals(setup.business.id).toArray(),
    ]);
    return {customers,accounts,entries,events,members};
  },[setup.business.id,setup.outlet.id]);
  const [now,setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()),30000); return () => clearInterval(timer); },[]);
  const byAccount = useMemo(() => {
    const result = new Map<string,CreditEntry[]>();
    for (const entry of data?.entries || []) { const values = result.get(entry.accountId) || []; values.push(entry); result.set(entry.accountId,values); }
    return result;
  },[data?.entries]);
  const asOf = useMemo(() => Date.now(),[data,now]);
  const rows = useMemo(() => (data?.accounts || []).map(account => creditOverview(account,byAccount.get(account.id) || [],setup.outlet.timezone,setup.business.marketCode,asOf)),[data?.accounts,byAccount,setup.outlet.timezone,setup.business.marketCode,asOf]);
  return {data,rows,byAccount,now:asOf};
}
export const displayName = (customer: {name:string;nickname:string}) => customer.nickname || customer.name;
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not save. Keep this browser’s data and try again.';
export function khataDate(at: number, setup: SetupSnapshot, time = false) { return new Intl.DateTimeFormat('en-GB',{timeZone:setup.outlet.timezone,dateStyle:'medium',...(time ? {timeStyle:'short' as const} : {})}).format(at); }
export {Avatar} from '@mise/ui/Avatar.tsx';
export function CreditMeter({account,balance}: {account:CreditAccount;balance:number}) {
  return <div className={`credit-meter${balance > account.limit ? ' over-limit' : ''}`} role="meter" aria-label="Credit used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(account.limit ? Math.min(100,Math.max(0,balance/account.limit*100)) : balance > 0 ? 100 : 0)} aria-valuetext={`${formatMoney(balance,account.currency)} due; limit ${formatMoney(account.limit,account.currency)}`}><span style={{width:`${account.limit ? Math.min(100,Math.max(0,balance/account.limit*100)) : balance > 0 ? 100 : 0}%`}} /></div>;
}
