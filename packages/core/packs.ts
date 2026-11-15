import source from '../../handover/docs/packs.json';

export type BusinessType = keyof typeof source.business;
export type MarketCode = keyof typeof source.market | 'OTHER';
export type MessageLanguage = 'en' | 'bn' | 'both';
export const businessPacks = source.business;
export const marketPacks = {
  ...source.market,
  OTHER: { ...source.market.KE, 'market/name': 'Other', 'market/city': '', 'currency/code': 'USD', 'currency/symbol': '$', 'money/grouping': 'thousands', 'lang/secondary': 'English', 'lang/code': 'en', 'lang/sample-item': 'Sample item', 'font/secondary': 'Geist', 'phone/cc': '', 'phone/format': '+ country code and number', timezone: 'UTC', 'pay/wallets': ['Cash'], 'pay/qr': 'Payment QR', 'address/style': 'Address and landmark', 'tax/name': 'Tax', 'delivery/aggregators': [], 'chat/apps': ['WhatsApp', 'calls'], 'courier/parcel': [], marketplace: [], 'calendar/events': [] },
};
export function defaultMarket(timezone: string): MarketCode {
  if (timezone === 'Asia/Dhaka') return 'BD';
  if (['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'].includes(timezone)) return 'ID';
  if (['Asia/Kolkata', 'Asia/Calcutta'].includes(timezone)) return 'IN';
  return timezone === 'Africa/Nairobi' ? 'KE' : 'OTHER';
}
export interface AppNavItem { path: string; label: string; icon: string }
const nav: Record<string, AppNavItem> = {
  today: { path: '/', label: 'Today', icon: 'home' }, counter: { path: '/counter', label: 'Counter', icon: 'calculator' },
  orders: { path: '/orders', label: 'Orders', icon: 'receipt' }, khata: { path: '/khata', label: 'Khata', icon: 'wallet' },
  inbox: { path: '/inbox', label: 'Inbox', icon: 'message' }, stock: { path: '/stock', label: 'Stock', icon: 'package' },
  more: { path: '/more', label: 'More', icon: 'more' },
};
export function phoneNav(type: BusinessType): AppNavItem[] {
  const keys = type === 'corner_shop' || type === 'food_stall' ? ['today', 'counter', 'orders', 'khata', 'more'] : ['today', 'orders', 'inbox', 'stock', 'more'];
  return keys.map(key => key === 'stock' ? { ...nav[key], label: businessPacks[type].nav.stock } : nav[key]);
}
