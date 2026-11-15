const symbols: Record<string, string> = { BDT: '৳', INR: '₹', IDR: 'Rp', KES: 'KSh', USD: '$' };
// ISO 4217 minor units for our market packs; locale display defaults can differ (IDR).
const minorDigits: Record<string, number> = { BDT: 2, INR: 2, IDR: 2, KES: 2, USD: 2 };
const formats = new Map<string, { digits: number; whole: Intl.NumberFormat; decimal: string }>();
export function formatMoney(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount)) throw new Error('Money must be an integer in minor units.');
  let format = formats.get(currency);
  if (!format) {
    const digits = minorDigits[currency] ?? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
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
