import { formatMoney } from './money';
import { normalisePhone, waLink } from './phone';
import { isOrderFinished, orderSourceLabels } from './orders';
import type { Customer, Item, Order, OrderStatus, SetupSnapshot } from './models';
import type { OrderLineInput } from './order-lines';

export function orderAgeMinutes(order: Order, at = Date.now()): number { return Math.max(0,Math.floor((at-order.createdAt)/60000)); }
export function orderIsLate(order: Order, minutes = 15, at = Date.now()): boolean { return !isOrderFinished(order) && at-Math.max(order.createdAt,order.scheduledFor || 0) >= minutes*60000; }
export function searchOrders(orders: Order[], query: string, status?:OrderStatus): Order[] {
  const text = query.replace(/[০-৯]/g,value => String(value.charCodeAt(0)-0x09e6)).trim().normalize('NFKC').toLowerCase(), digits = text.replace(/\D/g,'').replace(/^0+/,'');
  return orders.filter(order => (!status || order.status === status) && (!text || `${order.number} ${order.customer.name} ${order.customer.phone || ''} ${orderSourceLabels[order.source]} ${order.lines.map(line => line.name).join(' ')}`.normalize('NFKC').toLowerCase().includes(text) || (digits.length >= 3 && order.customer.phone?.endsWith(digits)))).sort((a,b) => b.sequence-a.sequence);
}
export function findOrderCustomer(customers: Customer[], phone: string, setup: SetupSnapshot): Customer|undefined {
  const normalized = normalisePhone(phone,setup.business.marketCode);
  return normalized ? customers.find(customer => customer.businessId === setup.business.id && customer.archivedAt === undefined && customer.phone === normalized) : undefined;
}
export function usualOrderLines(customerId: string, orders: Order[], items: Item[], outletId: string, currency: string): OrderLineInput[] {
  const last = orders.filter(order => order.outletId === outletId && order.customer.id === customerId && order.status !== 'cancelled').sort((a,b) => b.sequence-a.sequence)[0];
  return (last?.lines || []).filter(line => !line.unavailable && (!line.substitution || line.substitution.accepted)).map(line => {
    const item = items.find(item => item.id === line.itemId && item.outletId === outletId);
    return {itemId:item?.id,name:item?.name || line.name,unit:item?.unit || line.unit,qty:line.qty,unitPrice:item?.price ?? (line.itemId || last?.currency !== currency ? null : line.unitPrice),unavailable:line.itemId ? !item?.available : false};
  });
}
export function orderQuoteText(order: Order, setup: SetupSnapshot): string {
  if (order.outletId !== setup.outlet.id) throw new Error('Choose an order from this shop.');
  const render = (bn: boolean) => {
    const lines = order.lines.map(line => `${line.qty} ${line.unit} ${line.name} — ${line.unavailable ? bn ? 'স্টকে নেই' : 'Out of stock' : line.lineTotal === null ? bn ? 'দাম বাকি' : 'Price pending' : formatMoney(line.lineTotal,order.currency)}${line.substitution ? bn ? ` (${line.substitution.from}-এর বদলি; ${line.substitution.accepted ? 'সম্মতি পেয়েছি' : 'সম্মতি জানান'})` : ` (swap for ${line.substitution.from}; ${line.substitution.accepted ? 'accepted' : 'please confirm'})` : ''}`);
    return [setup.business.name,`${bn ? 'অর্ডার' : 'Order'} ${order.number} · ${order.customer.name}`, ...lines,order.deliveryFee ? `${bn ? 'ডেলিভারি' : 'Delivery'}: ${formatMoney(order.deliveryFee,order.currency)}` : '',order.discount ? `${bn ? 'ছাড়' : 'Discount'}: ${formatMoney(order.discount,order.currency)}` : '',order.total === null ? bn ? 'মোট দাম এখনও বাকি — দাম ও বদলি পণ্যে সম্মতি জানান।' : 'Total pending — please confirm prices and swaps.' : `${bn ? 'মোট' : 'Total'}: ${formatMoney(order.total,order.currency)}`,bn ? 'দাম ও বদলি পণ্য দেখে সম্মতি জানান।' : 'Please confirm the prices and any swaps.'].filter(Boolean).join('\n');
  };
  const message = [setup.business.languages.includes('bn') && render(true),setup.business.languages.includes('en') && render(false)].filter(Boolean).join('\n\n');
  if (message.length > 4000) throw new Error('This quote is too long to share. Copy or send a shorter summary.');
  return message;
}
export function orderContactLinks(order: Order, text: string): {whatsapp?:string;call?:string} { return order.customer.phone ? {whatsapp:waLink(order.customer.phone,text),call:`tel:${order.customer.phone}`} : {}; }
