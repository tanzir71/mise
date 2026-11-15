import type { Order, OrderStatus } from '@mise/core/models';
import { orderStatusLabels, type OrderInput } from '@mise/core/orders';
import { formatMoney } from '@mise/core/money';

export function orderInput(order:Order):OrderInput {
  return {source:order.source,sourceText:order.sourceText,customerId:order.customer.id,name:order.customer.name,phone:order.customer.phone || '',type:order.type,address:order.address,table:order.table,scheduledFor:order.scheduledFor,lines:order.lines,deliveryFee:order.deliveryFee,discount:order.discount,payment:order.payment};
}
export const fulfilmentLabel = (order:Order) => order.type === 'dine_in' ? `Dine-in · ${order.table}` : order.type === 'pickup' ? 'Pickup' : 'Delivery';
export function paymentLabel(order:Order):string {
  const payment = order.payment, cancelled = payment.cancellation;
  if (cancelled) return cancelled.refundDue > 0 ? `Refund owed ${formatMoney(cancelled.refundDue,order.currency)}` : payment.method === 'credit' ? 'Credit cancelled · no refund owed' : cancelled.refundTotal ? 'Refund complete' : 'No money owed';
  const name = payment.method === 'credit' ? 'Khata' : payment.method === 'wallet' ? payment.wallet : payment.method === 'card' ? 'Card' : 'Cash';
  return `${name} · ${payment.status === 'pending' ? 'pending' : payment.status === 'credited' ? 'added to khata' : 'paid'}`;
}
export const advanceLabel = (status:OrderStatus) => `Mark ${orderStatusLabels[status].toLowerCase()}`;
export function orderColumn(order:Order):number {
  if (['new','to_confirm','requested','priced','ordered'].includes(order.status)) return 0;
  if (['confirmed','kitchen_seen','cooking','making','accepted','packing'].includes(order.status)) return 1;
  if (['ready','ready_called','packed','booked'].includes(order.status)) return 2;
  return 3;
}
export function orderTone(status:OrderStatus):'neutral'|'warning'|'info'|'positive'|'negative' {
  return ['cancelled','returned'].includes(status) ? 'negative' : ['ready','ready_called','delivered','done','collected'].includes(status) ? 'positive' : ['new','requested','to_confirm','priced','ordered'].includes(status) ? 'warning' : 'info';
}
