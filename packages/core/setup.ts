import { ulid } from 'ulid';
import { businessPacks, marketPacks } from './packs';
import { normalisePhone } from './phone';
import type { SetupInput, SetupSnapshot, SetupCommand, Item } from './models';

export function setupCommand(input: SetupInput, before: SetupSnapshot | null = null, at = Date.now(), id: () => string = () => ulid(at)): SetupCommand {
  if (!Object.hasOwn(businessPacks, input.businessType) || !Object.hasOwn(marketPacks, input.marketCode)) throw new Error('Choose a business and market.');
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error('Use a shop name between 1 and 80 characters.');
  const phone = normalisePhone(input.phone, input.marketCode);
  if (!phone) throw new Error('Enter a complete phone number, including the country code for Other.');
  const pack = marketPacks[input.marketCode];
  const timezone = input.timezone || pack.timezone;
  const currency = (input.currency || pack['currency/code']).toUpperCase();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); new Intl.NumberFormat('en', { style: 'currency', currency }); } catch { throw new Error('Choose a valid timezone and currency.'); }
  if (input.language && !['en', 'bn', 'both'].includes(input.language)) throw new Error('Choose a message language.');
  const language = input.language || (input.marketCode === 'BD' ? 'both' : 'en');
  const languages: SetupSnapshot['business']['languages'] = language === 'both' ? ['en', 'bn'] : [language];
  const business = { id: before?.business.id || id(), name, businessType: input.businessType, marketCode: input.marketCode, languages, createdAt: before?.business.createdAt ?? at, updatedAt: at } satisfies SetupSnapshot['business'];
  const outlet = { id: before?.outlet.id || id(), businessId: business.id, name: input.outletName?.trim() || name, address: input.address?.trim() || '', timezone, currency, shopLink: before?.outlet.shopLink, creditMessaging:before?.outlet.creditMessaging, createdAt: before?.outlet.createdAt ?? at, updatedAt: at };
  const owner = { id: before?.owner.id || id(), businessId: business.id, outletIds: [outlet.id], name: before?.owner.name || 'Owner', phone, role: 'owner', active: true, createdAt: before?.owner.createdAt ?? at, updatedAt: at } satisfies SetupSnapshot['owner'];
  const snapshot = { business, outlet, owner };
  const category = { id: id(), outletId: outlet.id, name: 'Samples', sort: 0, createdAt: at, updatedAt: at };
  const food = input.businessType === 'restaurant' || input.businessType === 'food_stall';
  const names = food ? ['Sample dish', 'Tea', 'Water'] : input.businessType === 'online_shop' ? ['T-shirt', 'Notebook', 'Bag'] : ['Rice', 'Soap', 'Egg'];
  const prices = input.marketCode === 'OTHER' ? [300, 150, 100] : input.marketCode === 'ID' ? [2500000, 500000, 300000] : input.marketCode === 'KE' ? [15000, 5000, 3000] : [7500, 2500, 1500];
  const items: Item[] = before ? [] : names.map((item, index) => ({ id: id(), outletId: outlet.id, name: item, nameLocal: food && index === 0 ? pack['lang/sample-item'] : '', categoryId: category.id, price: prices[index], unit: 'pc', available: true, isSample: true, createdAt: at, updatedAt: at }));
  const categories = before ? [] : [category];
  return { snapshot, items, categories, event: { id: id(), outletId: outlet.id, actor: { type: 'member', id: owner.id }, command: before ? 'setup.update' : 'setup.create', before, after: before ? snapshot : { ...snapshot, items, categories }, at } };
}
