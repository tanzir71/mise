import { ulid } from 'ulid';
import { ORDER_SOURCE_MAX_TEXT } from './order-limits';
import { marketPacks, type BusinessType } from './packs';
import { normalisePhone } from './phone';
import { orderPricing, prepareOrderLines, type OrderLineInput } from './order-lines';
import { validateShop, type ShopSetup } from './shop-access';
import type { AuditEvent, Customer, Item, Order, OrderCommunication, OrderNote, OrderPayment, OrderSource, OrderStatus, OrderType } from './models';

export type OrderIds=(kind:'order'|'line'|'event'|'note'|'communication')=>string;

export const orderFlows: Record<BusinessType, readonly OrderStatus[]> = {
  restaurant:['new','confirmed','kitchen_seen','cooking','ready','out','delivered'],
  online_shop:['new','to_confirm','confirmed','packed','booked','with_courier','delivered','returning','returned'],
  food_stall:['ordered','making','ready_called','collected'],
  corner_shop:['requested','priced','accepted','packing','ready','delivering','done'],
};
export const orderStatusLabels: Record<OrderStatus,string> = {new:'New',confirmed:'Confirmed',kitchen_seen:'Kitchen has it',cooking:'Cooking',ready:'Ready',out:'Out with rider',delivered:'Delivered',to_confirm:'To confirm',packed:'Packed',booked:'Booked',with_courier:'With courier',returning:'Returning',returned:'Returned',ordered:'Ordered',making:'Making',ready_called:'Ready · call out',collected:'Collected',requested:'Requested',priced:'Priced',accepted:'Accepted',packing:'Packing',delivering:'Delivering',done:'Done',cancelled:'Cancelled'};
export const orderSourceLabels: Record<OrderSource,string> = {phone:'Phone',walk_in:'Walk-in',table:'Table',paste:'Paste chat',other:'Other'};
export const isOrderFinished = (order: Order) => ['delivered','returned','collected','done','cancelled'].includes(order.status);
export const editableOrder = (order: Order) => !isOrderFinished(order) && order.status !== 'returning';
export function editableOrderPrices(order: Order): boolean { return order.payment.status === 'pending' && ({restaurant:['new','confirmed'],online_shop:['new','to_confirm','confirmed'],food_stall:['ordered'],corner_shop:['requested','priced']}[order.businessType]).includes(order.status); }
export interface OrderInput {
  source:OrderSource; sourceText:string; customerId?:string; name:string; phone:string; type:OrderType; address:string; table:string;
  scheduledFor?:number; lines:OrderLineInput[]; deliveryFee:number; discount:number; payment:{method:OrderPayment['method'];wallet?:string};
}
export interface OrderContext { setup:ShopSetup; items:Item[]; customer?:Customer; sequence:number }
export function validateOrder(order: Order, setup: ShopSetup, revision: number) {
  validateShop(setup);
  if (order.outletId !== setup.outlet.id) throw new Error('Choose an order from this shop.');
  if (order.revision !== revision) throw new Error('This order changed. Refresh it before saving.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('The order revision exceeds the supported range.');
  if (!orderFlows[order.businessType]?.includes(order.status) && order.status !== 'cancelled') throw new Error('This order has an unsupported status.');
}
export function orderEvent(order: Order, setup: ShopSetup, command: string, before: unknown, after: unknown, at: number, newId:()=>string=()=>ulid(at)): AuditEvent {
  return {id:newId(),outletId:order.outletId,orderId:order.id,orderRevision:order.revision,actor:{type:'member',id:setup.owner.id},command,before,after,at};
}
export function saveOrderCommand(input: OrderInput, context: OrderContext, before: Order|null = null, revision = 0, at = Date.now(), newId:OrderIds=()=>ulid(at)): {order:Order;event:AuditEvent} {
  const {setup,customer} = context;
  validateShop(setup);
  if (before) { validateOrder(before,setup,revision); if (!editableOrder(before)) throw new Error('A finished order cannot be edited.'); }
  if (!['phone','walk_in','table','paste','other'].includes(input.source) || !['delivery','pickup','dine_in'].includes(input.type)) throw new Error('Choose a supported order source and fulfilment type.');
  if (!Number.isSafeInteger(context.sequence) || context.sequence < 1) throw new Error('Use a valid order number.');
  if (input.customerId && (!customer || customer.id !== input.customerId || customer.businessId !== setup.business.id || (customer.archivedAt !== undefined && before?.customer.id !== customer.id))) throw new Error('Choose an active customer from this shop.');
  const name = input.name.trim(), address = input.address.trim(), table = input.table.trim(), sourceText = input.sourceText;
  if (name.length > 80 || /[\r\n]/.test(name) || address.length > 250 || table.length > 40 || typeof sourceText!=='string' || sourceText.length > ORDER_SOURCE_MAX_TEXT) throw new Error('Keep the name, address, table and source note within their field limits.');
  const phone = input.phone.trim() ? normalisePhone(input.phone,setup.business.marketCode) : input.customerId ? customer?.phone : undefined;
  if (input.phone.trim() && !phone) throw new Error('Enter a complete phone number.');
  const retainedPhone = before?.customer.id === input.customerId && before?.customer.phone === phone;
  if (input.customerId && customer?.phone && phone !== customer.phone && !retainedPhone) throw new Error('The phone does not match the selected customer.');
  if (input.type === 'delivery' && !address) throw new Error('Enter a delivery address.');
  if (input.type === 'dine_in' && !table) throw new Error('Enter a table or seat.');
  if (input.scheduledFor !== undefined && (!Number.isSafeInteger(input.scheduledFor) || input.scheduledFor < 0)) throw new Error('Choose a valid order time.');
  const currency = before?.currency || setup.outlet.currency;
  const lines = prepareOrderLines(input.lines,before && before.currency !== setup.outlet.currency ? [] : context.items,setup.outlet.id,before?.lines,at,()=>newId('line')), pricing = orderPricing(lines,input.type === 'delivery' ? input.deliveryFee : 0,input.discount);
  if (before && before.status !== orderFlows[before.businessType][0] && !pricing.complete) throw new Error('Price every available line and confirm swaps before changing a confirmed order.');
  const wallets = marketPacks[setup.business.marketCode]['pay/wallets'];
  const retainedWallet = before?.payment.method === 'wallet' && before.payment.wallet === input.payment.wallet;
  if (!['cash','wallet','card','credit'].includes(input.payment.method) || (input.payment.method === 'wallet' && (!input.payment.wallet || input.payment.wallet === 'Cash' || (!wallets.includes(input.payment.wallet) && !retainedWallet)))) throw new Error('Choose a supported payment method.');
  if (input.payment.method === 'credit' && !input.customerId) throw new Error('Choose a saved customer for khata.');
  if (before && !editableOrderPrices(before)) {
    const commercial = (values: typeof lines) => values.map(line => ({id:line.id,itemId:line.itemId,name:line.name,unit:line.unit,qty:line.qty,unitPrice:line.unitPrice,unavailable:line.unavailable,substitution:line.substitution}));
    if (JSON.stringify(commercial(lines)) !== JSON.stringify(commercial(before.lines)) || pricing.total !== before.total || input.discount !== before.discount || (input.type === 'delivery' ? input.deliveryFee : 0) !== before.deliveryFee || input.customerId !== before.customer.id || input.payment.method !== before.payment.method || (input.payment.method === 'wallet' && input.payment.wallet !== before.payment.wallet)) throw new Error('Item prices, customer and payment cannot be edited at this stage. Update fulfilment details or add a note.');
  }
  const eventId = newId('event'), id = before?.id || newId('order'), status = before?.status || orderFlows[setup.business.businessType][0];
  const order: Order = {id,outletId:setup.outlet.id,businessType:before?.businessType || setup.business.businessType,sequence:before?.sequence || context.sequence,number:before?.number || `A-${String(context.sequence).padStart(4,'0')}`,revision:(before?.revision || 0)+1,source:input.source,sourceText,customer:{id:input.customerId || undefined,name:name || (input.customerId ? customer?.nickname || customer?.name : '') || (input.source === 'walk_in' ? 'Walk-in' : 'Customer'),phone:phone || undefined},type:input.type,status,statusChangedAt:before?.statusChangedAt ?? at,statusEventId:before?.statusEventId || eventId,lines,subtotal:pricing.subtotal,deliveryFee:input.type === 'delivery' ? input.deliveryFee : 0,discount:input.discount,total:pricing.total,currency,timezone:before?.timezone || setup.outlet.timezone,address:input.type === 'delivery' ? address : '',table:input.type === 'dine_in' ? table : '',scheduledFor:input.scheduledFor,payment:before?.payment.status !== undefined && before.payment.status !== 'pending' ? before.payment : {method:input.payment.method,wallet:input.payment.method === 'wallet' ? input.payment.wallet : undefined,status:'pending'},handledBy:before?.handledBy || setup.owner.id,createdBy:before?.createdBy || setup.owner.id,eventId,createdAt:before?.createdAt ?? at,updatedAt:at};
  const event = orderEvent(order,setup,before ? 'order.update' : 'order.create',before,order,at,()=>eventId);
  return {order,event};
}
export function nextOrderStatuses(order: Order): OrderStatus[] {
  if (isOrderFinished(order)) return [];
  if (order.status === 'ready' && order.businessType === 'restaurant') return [order.type === 'delivery' ? 'out' : 'delivered'];
  if (order.status === 'ready' && order.businessType === 'corner_shop') return [order.type === 'delivery' ? 'delivering' : 'done'];
  if (order.status === 'packed' && order.businessType === 'online_shop' && order.type !== 'delivery') return ['delivered'];
  if (order.status === 'with_courier') return ['delivered','returning'];
  const flow = orderFlows[order.businessType], index = flow.indexOf(order.status);
  return index >= 0 && index < flow.length-1 ? [flow[index+1]] : [];
}
export function changeOrderStatusCommand(before: Order, status: OrderStatus, setup: ShopSetup, revision: number, at = Date.now(), newId:OrderIds=()=>ulid(at)) {
  validateOrder(before,setup,revision);
  if (status === 'cancelled') {
    if (isOrderFinished(before)) throw new Error('A finished order cannot be cancelled.');
    if (before.payment.status !== 'pending') throw new Error('Reverse the recorded payment before cancelling this order.');
  } else {
    if (!nextOrderStatuses(before).includes(status)) throw new Error('Choose the next status in this business’s flow.');
    if (!orderPricing(before.lines,before.deliveryFee,before.discount).complete) throw new Error('Price all available lines and confirm swaps first.');
  }
  const order = {...before,status,statusChangedAt:at,revision:before.revision+1,updatedAt:at};
  const event = orderEvent(order,setup,status === 'cancelled' ? 'order.cancel' : 'order.status',before,null,at,()=>newId('event'));
  order.eventId = event.id; order.statusEventId = event.id; event.after = order;
  return {order,event};
}
export function undoOrderStatusCommand(before: Order, change: AuditEvent, setup: ShopSetup, revision: number, at = Date.now(), newId:OrderIds=()=>ulid(at)) {
  validateOrder(before,setup,revision);
  const original = change.before as Order|null, after = change.after as Order|null;
  if (!['order.status','order.cancel'].includes(change.command) || change.orderId !== before.id || change.outletId !== before.outletId || before.statusEventId !== change.id || original?.id !== before.id || after?.id !== before.id || after.status !== before.status) throw new Error('Only the last status change can be undone once.');
  if (original.outletId !== before.outletId || original.businessType !== before.businessType || original.revision !== after.revision-1 || after.statusEventId !== change.id || change.orderRevision !== after.revision || !orderFlows[before.businessType].includes(original.status)) throw new Error('The status history does not match this order.');
  const order = {...before,status:original.status,statusChangedAt:original.statusChangedAt,revision:before.revision+1,updatedAt:at};
  const event = orderEvent(order,setup,'order.status-undo',before,null,at,()=>newId('event')); event.undoOf = change.id;
  order.eventId = event.id; order.statusEventId = event.id; event.after = order;
  return {order,event};
}
export function addOrderNoteCommand(before: Order, text: string, setup: ShopSetup, revision: number, at = Date.now(), newId:OrderIds=()=>ulid(at)) {
  validateOrder(before,setup,revision);
  if (!text.trim() || text.trim().length > 2000) throw new Error('Write a note within 2,000 characters.');
  const order = {...before,revision:before.revision+1,updatedAt:at}, event = orderEvent(order,setup,'order.note',before,null,at,()=>newId('event'));
  order.eventId = event.id;
  const note: OrderNote = {id:newId('note'),orderId:order.id,outletId:order.outletId,revision:order.revision,text:text.trim(),createdBy:setup.owner.id,eventId:event.id,createdAt:at,updatedAt:at};
  event.after = {order,note}; return {order,note,event};
}
export function recordOrderCommunicationCommand(before: Order, input: Pick<OrderCommunication,'purpose'|'channel'|'text'>, setup: ShopSetup, revision: number, at = Date.now(), newId:OrderIds=()=>ulid(at)) {
  validateOrder(before,setup,revision);
  if (!['quote','message','call'].includes(input.purpose) || !['whatsapp','manual','call'].includes(input.channel) || !input.text.trim() || input.text.length > 4000) throw new Error('Choose a supported contact action and text within 4,000 characters.');
  if (input.purpose === 'call' ? input.channel !== 'call' : input.channel === 'call') throw new Error('Use the matching message or call channel.');
  const order = {...before,revision:before.revision+1,updatedAt:at}, event = orderEvent(order,setup,`order.${input.purpose}-sent`,before,null,at,()=>newId('event'));
  order.eventId = event.id;
  const communication: OrderCommunication = {id:newId('communication'),orderId:order.id,outletId:order.outletId,revision:order.revision,...input,text:input.text.trim(),createdBy:setup.owner.id,eventId:event.id,createdAt:at,updatedAt:at};
  event.after = {order,communication}; return {order,communication,event};
}
export function saveOrderWarningCommand(minutes: number, setup: ShopSetup, at = Date.now(), newId:OrderIds=()=>ulid(at)) {
  validateShop(setup);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Choose a warning between 1 and 1,440 minutes.');
  const outlet = {...setup.outlet,orderWarningMinutes:minutes,updatedAt:at};
  const event: AuditEvent = {id:newId('event'),outletId:outlet.id,actor:{type:'member',id:setup.owner.id},command:'order.warning-settings',before:setup.outlet,after:outlet,at};
  return {outlet,event};
}
