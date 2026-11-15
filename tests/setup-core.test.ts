import { describe, expect, test } from 'vitest';
import { businessPacks, marketPacks, defaultMarket, phoneNav } from '../packages/core/packs';
import { setupCommand } from '../packages/core/setup';
import { normalisePhone, waLink } from '../packages/core/phone';
import { formatMoney } from '../packages/core/money';
import type { SetupInput } from '../packages/core/models';

const input: SetupInput = { businessType: 'corner_shop', marketCode: 'BD', name: 'Rahman Store', phone: '01712345482' };
test('setup normalises the phone, seeds removable samples and records the complete write', () => {
  const command = setupCommand(input, null, 1000);
  expect(command.snapshot.owner.phone).toBe('+8801712345482');
  expect(command.snapshot.business.languages).toEqual(['en', 'bn']);
  expect(command.snapshot.outlet.currency).toBe('BDT');
  expect(command.items).toHaveLength(3);
  expect(command.items.every(item => item.isSample && Number.isSafeInteger(item.price))).toBe(true);
  expect(command.event).toMatchObject({ command: 'setup.create', before: null, at: 1000, after: { items: command.items, categories: command.categories } });
  for (const entity of [command.snapshot.business, command.snapshot.outlet, command.snapshot.owner, ...command.items, ...command.categories, command.event]) expect(entity.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});
test('settings retain identity and creation times without reseeding samples', () => {
  const before = setupCommand(input, null, 1000).snapshot;
  const command = setupCommand({ ...input, businessType: 'restaurant', language: 'en', name: 'New name' }, before, 2000);
  expect(command.snapshot.business).toMatchObject({ id: before.business.id, createdAt: 1000, updatedAt: 2000, languages: ['en'] });
  expect(command.items).toEqual([]);
  expect(command.categories).toEqual([]);
  expect(command.event).toMatchObject({ command: 'setup.update', before });
});
test.each(['', '12', 'not a phone', 'Call 01712345482'])('invalid phone %j cannot create a shop', phone => {
  expect(() => setupCommand({ ...input, phone })).toThrow(/phone number/);
});
test('pack nouns, navigation and timezone defaults follow the selected business/market', () => {
  expect(businessPacks.corner_shop['noun/catalogue']).toBe('Price list');
  expect(businessPacks.restaurant['noun/catalogue']).toBe('Menu');
  expect(phoneNav('corner_shop').map(item => item.label)).toEqual(['Today', 'Counter', 'Orders', 'Khata', 'More']);
  expect(phoneNav('restaurant').map(item => item.label)).toEqual(['Today', 'Orders', 'Inbox', 'Stock', 'More']);
  expect(phoneNav('online_shop')[3].label).toBe('Products');
  expect(['Asia/Dhaka', 'Asia/Jakarta', 'Asia/Calcutta', 'Africa/Nairobi', 'Europe/London'].map(defaultMarket)).toEqual(['BD', 'ID', 'IN', 'KE', 'OTHER']);
  expect(marketPacks.OTHER['pay/wallets']).toEqual(['Cash']);
});
test.each([['BD', '০১৭১২৩৪৫৪৮২', '+8801712345482'], ['IN', '9876543210', '+919876543210'], ['KE', '0712345678', '+254712345678'], ['ID', '081234567890', '+6281234567890'], ['OTHER', '+14155552671', '+14155552671']] as const)('%s phones are stored in E.164', (market, phone, expected) => expect(normalisePhone(phone, market)).toBe(expected));
describe('money uses integer minor units and market grouping', () => {
  test.each([[11284000, 'BDT', '৳1,12,840'], [11284050, 'INR', '₹1,12,840.50'], [123456, 'USD', '$1,234.56'], [2500000, 'IDR', 'Rp25.000'], [-100, 'BDT', '−৳1']] as const)('%i %s → %s', (amount, currency, expected) => expect(formatMoney(amount, currency)).toBe(expected));
  test('rejects fractional minor units', () => expect(() => formatMoney(1.5, 'BDT')).toThrow(/integer/));
  test('keeps cents at the largest safe integer amount', () => expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91'));
});
test('WhatsApp links encode customer text and reject a non-normalised destination', () => {
  expect(waLink('+8801712345482', 'Hello & thanks')).toBe('https://wa.me/8801712345482?text=Hello%20%26%20thanks');
  expect(() => waLink('01712345482', 'Hello')).toThrow(/E.164/);
});
