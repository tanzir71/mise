import { useEffect, useState } from 'react';
import { formatMoney } from '@mise/core/money';
import type { SetupSnapshot } from '@mise/core/models';
export function useTodayClock() {
  const [,setNow] = useState(Date.now);
  useEffect(() => {const update = () => setNow(Date.now()), timer = setInterval(update,15000);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);return () => {clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};},[]);
  return Date.now();
}
export function todayDate(at:number, setup:SetupSnapshot) {return new Intl.DateTimeFormat('en-GB',{timeZone:setup.outlet.timezone,weekday:'short',day:'numeric',month:'short'}).format(at);}
export function closingTime(at:number, timezone:string) {return new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'numeric',minute:'2-digit'}).format(at);}
export function durationLabel(ms:number|null) {return ms === null ? '—' : ms < 60000 ? 'Under 1 min' : `${Math.round(ms/60000)} min`;}
export const paymentName = (method:string) => method === 'credit' ? 'Credit' : method === 'wallet' ? 'Wallets' : method === 'cash' ? 'Cash' : 'Card';
export function percentage(amount:number,total:number) {return total > 0 ? Number(BigInt(amount)*10000n/BigInt(total))/100 : 0;}
export const cashMovementHelp = 'Recorded cash is today’s net cash movement. Opening float and unrecorded expenses are not included.';
export const countLabel = (count:number,singular:string,plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
export const signedMoney = (amount:number,currency:string) => `${amount > 0 ? '+' : ''}${formatMoney(amount,currency)}`;
