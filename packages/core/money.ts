const symbols: Record<string, string> = { BDT: '৳', INR: '₹', IDR: 'Rp', KES: 'KSh', USD: '$' };
// ISO 4217 minor units for our market packs; locale display defaults can differ (IDR).
const minorDigits: Record<string, number> = { BDT: 2, INR: 2, IDR: 2, KES: 2, USD: 2 };
export const currencyDigits = (currency: string): number => minorDigits[currency] ?? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
export function parseMoney(input: string, currency: string): number | null {
  let value = input.trim().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
  for (const prefix of [symbols[currency], currency].filter(Boolean)) if (value.startsWith(prefix)) { value = value.slice(prefix.length).trim(); break; }
  if (currency === 'IDR') {
    const parts = value.split(',');
    if (parts.length > 2) return null;
    if (/^\d{1,3}(?:\.\d{3})+$/.test(parts[0])) parts[0] = parts[0].replaceAll('.', '');
    value = parts.join('.');
  } else if (value.includes(',')) {
    const parts = value.split('.'); if (parts.length > 2) return null;
    const [whole, fraction] = parts;
    if (!/^\d{1,3}(?:,\d{3})+$/.test(whole) && !/^\d{1,2}(?:,\d{2})*,\d{3}$/.test(whole)) return null;
    value = whole.replaceAll(',', '') + (fraction === undefined ? '' : `.${fraction}`);
  }
  const digits = currencyDigits(currency);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const amount = BigInt(whole || '0') * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function moneyInputValue(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Use non-negative integer minor units.');
  const digits = currencyDigits(currency), divisor = 10n ** BigInt(digits), value = BigInt(amount), fraction = value % divisor;
  return (value / divisor).toString() + (fraction ? (currency === 'IDR' ? ',' : '.') + fraction.toString().padStart(digits, '0') : '');
}
const formats = new Map<string, { digits: number; whole: Intl.NumberFormat; decimal: string }>();
export function formatMoney(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount)) throw new Error('Money must be an integer in minor units.');
  let format = formats.get(currency);
  if (!format) {
    const digits = currencyDigits(currency);
    const locale = ['BDT', 'INR'].includes(currency) ? 'en-IN' : currency === 'IDR' ? 'id-ID' : 'en-US';
    format = { digits, whole: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), decimal: new Intl.NumberFormat(locale, { minimumFractionDigits: 1 }).formatToParts(1.1).find(part => part.type === 'decimal')!.value };
    formats.set(currency, format);
  }
  const divisor = 10n ** BigInt(format.digits);
  const integer = BigInt(Math.abs(amount));
  const remainder = integer % divisor;
  const value = format.whole.format(integer / divisor) + (remainder ? format.decimal + remainder.toString().padStart(format.digits, '0') : '');
  return `${amount < 0 ? '−' : ''}${symbols[currency] || currency}${value}`;
}
