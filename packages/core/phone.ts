import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { MarketCode } from './packs';

export function normalisePhone(input: string, market: MarketCode = 'BD'): string | null {
  const text = input.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6)).trim().replace(/^00/, '+');
  try {
    const phone = parsePhoneNumberFromString(text, { defaultCountry: market === 'OTHER' ? undefined : market as CountryCode, extract: false });
    return phone?.isPossible() ? phone.number : null;
  } catch { return null; }
}
export function waLink(phone: string, text: string): string {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error('Use an E.164 phone number.');
  return `https://wa.me/${phone.slice(1)}?text=${encodeURIComponent(text)}`;
}
