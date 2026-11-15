import { ulid } from 'ulid';
import { marketPacks } from './packs';
import { moneyInputValue } from './money';
import { orderLineTotal, orderPricing } from './order-lines';
import { changeOrderStatusCommand, isOrderFinished, orderEvent, undoOrderStatusCommand, validateOrder } from './orders';
import { recordSaleCommand, undoSaleCommand } from './sales';
import { undoCreditSaleCommand } from './credit-sales';
import { activeEntries, chargeCreditCommand, recordOrderCreditRefundCommand, restoreOrderCreditCommand, returnOrderCreditCommand, undoOrderCreditRefundCommand, type LedgerContext, type OverLimitConfirmation } from './khata';
import type { AuditEvent, CreditEntry, Order, OrderRefund, PaymentMethod, Sale, SetupSnapshot } from './models';

export interface OrderMoneyContext { setup:SetupSnapshot; ledger?:LedgerContext }
export interface OrderSettlementInput { method:PaymentMethod|'credit'; wallet?:string; given?:number; accountId?:string; confirmation?:OverLimitConfirmation }
export interface OrderRefundInput { amount:number; method:PaymentMethod; wallet?:string; note?:string }
export interface OrderMoneyChange { order:Order; sales:Sale[]; entries:CreditEntry[]; refunds:OrderRefund[]; events:AuditEvent[] }
function result(order: Order, event: AuditEvent): OrderMoneyChange { return {order,sales:[],entries:[],refunds:[],events:[event]}; }
function update(before: Order, setup: SetupSnapshot, command: string, at: number) {
  const order = {...before,revision:before.revision+1,updatedAt:at};
  const event = orderEvent(order,setup,command,before,null,at); order.eventId = event.id; event.after = order;
  return result(order,event);
}
function saleEvent(sale: Sale, before: Sale|null, setup: SetupSnapshot, command: string, at: number): AuditEvent {
  return {id:ulid(at),outletId:sale.outletId,orderId:sale.orderId,customerId:sale.customerId,actor:{type:'member',id:setup.owner.id},command,before,after:sale,at};
}
function paymentMethod(method: PaymentMethod, wallet: string|undefined, setup: SetupSnapshot, previous?:Sale, historicalWallets:string[] = []): string {
  if (!['cash','wallet','card'].includes(method)) throw new Error('Choose a supported payment method.');
  if (method === 'wallet' && (!wallet || wallet === 'Cash' || (!marketPacks[setup.business.marketCode]['pay/wallets'].includes(wallet) && !(previous?.method === 'wallet' && previous.methodName === wallet) && !historicalWallets.includes(wallet)))) throw new Error('Choose a wallet available in this market.');
  return method === 'wallet' ? wallet! : method === 'cash' ? 'Cash' : 'Card';
}
function ledgerFor(order: Order, context: OrderMoneyContext): LedgerContext {
  const ledger = context.ledger;
  if (!ledger || ledger.setup.business.id !== context.setup.business.id || ledger.setup.outlet.id !== context.setup.outlet.id || ledger.setup.owner.id !== context.setup.owner.id || ledger.customer.id !== order.customer.id || ledger.account.currency !== order.currency) throw new Error('Choose this customer’s khata in the order currency.');
  return ledger;
}
function linkedSale(order: Order, sale?:Sale): Sale {
  if (!sale || order.payment.saleId !== sale.id || sale.orderId !== order.id || sale.outletId !== order.outletId || sale.customerId !== order.customer.id || sale.currency !== order.currency || sale.amount !== order.total || sale.method !== order.payment.method || (sale.method === 'credit' ? order.payment.status !== 'credited' : order.payment.status !== 'paid')) throw new Error('The payment does not match this order.');
  return sale;
}
export function settleOrderCommand(before: Order, input: OrderSettlementInput, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  const {setup} = context; validateOrder(before,setup,revision);
  if (before.payment.status !== 'pending' || before.payment.saleId) throw new Error('This order already has a recorded payment.');
  if (['cancelled','returning','returned'].includes(before.status)) throw new Error('This order is cancelled or being returned.');
  const pricing = orderPricing(before.lines,before.deliveryFee,before.discount);
  if (!pricing.complete || pricing.total !== before.total || pricing.subtotal !== before.subtotal || before.total === null) throw new Error('Finish pricing and confirm swaps before recording payment.');
  if (!['cash','wallet','card','credit'].includes(input.method)) throw new Error('Choose a supported payment method.');
  const historicalWallets = before.payment.method === 'wallet' && before.payment.wallet ? [before.payment.wallet] : [];
  if (input.method !== 'credit') paymentMethod(input.method,input.wallet,setup,undefined,historicalWallets);
  if (input.given !== undefined && (input.method !== 'cash' || !Number.isSafeInteger(input.given) || input.given < before.total)) throw new Error('Given must cover the cash total.');
  const change = update(before,setup,'order.payment',at);
  if (before.total === 0) { change.order.payment = {method:'cash',status:'paid',at}; return change; }
  const expression = moneyInputValue(before.total,before.currency).replace(',','.');
  const recorded = recordSaleCommand({expression,method:input.method === 'credit' ? 'cash' : input.method,wallet:input.wallet,given:input.method === 'cash' ? input.given : undefined,who:before.customer.name},{setup:{...setup,outlet:{...setup.outlet,currency:before.currency}},items:[],wallets:[...marketPacks[setup.business.marketCode]['pay/wallets'],...historicalWallets]},at);
  const sale: Sale = {...recorded.sale,orderId:before.id,orderNumber:before.number,deliveryFee:before.deliveryFee,discount:before.discount,customerId:before.customer.id,items:before.lines.filter(line => !line.unavailable).map(line => ({itemId:line.itemId,name:line.name,unit:line.unit,qty:line.qty,unitPrice:line.unitPrice!,lineTotal:orderLineTotal(line.unitPrice!,line.qty)}))};
  if (input.method === 'credit') {
    const ledger = ledgerFor(before,context);
    if (input.accountId !== ledger.account.id || before.currency !== setup.outlet.currency) throw new Error('Choose the current-currency khata for new credit.');
    const credit = chargeCreditCommand(before.total,ledger,{confirmation:input.confirmation,saleId:sale.id,note:`${before.number} · ${before.lines.filter(line => !line.unavailable).map(line => line.name).join(', ').slice(0,1500)}`},at);
    credit.entry.orderId = before.id; credit.event.orderId = before.id;
    sale.method = 'credit'; sale.methodName = setup.business.marketCode === 'BD' ? 'Baki' : 'Credit'; sale.given = undefined; sale.change = undefined; sale.creditAccountId = ledger.account.id;
    change.entries.push(credit.entry); change.events.push(credit.event);
  }
  change.order.payment = {method:input.method,wallet:input.method === 'wallet' ? input.wallet : undefined,status:input.method === 'credit' ? 'credited' : 'paid',saleId:sale.id,at};
  change.sales.push(sale); change.events.push({...recorded.event,orderId:before.id,customerId:before.customer.id,after:sale});
  return change;
}
export function undoOrderPaymentCommand(before: Order, sale: Sale|undefined, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  validateOrder(before,context.setup,revision);
  if (before.payment.status === 'pending' || before.payment.cancellation) throw new Error('Undo cancellation first, or choose a recorded payment.');
  const change = update(before,context.setup,'order.payment-undo',at);
  if (before.total === 0 && !before.payment.saleId) {
    if (before.payment.at === undefined || at < before.payment.at || at-before.payment.at > 600000) throw new Error('A payment record can be undone within 10 minutes.');
  } else {
    const original = linkedSale(before,sale);
    if (original.method === 'credit') {
      const ledger = ledgerFor(before,context), entry = ledger.entries.find(entry => entry.saleId === original.id && entry.type === 'charge');
      if (!entry) throw new Error('The credit charge is missing.');
      const undone = undoCreditSaleCommand(original,entry,ledger,at); change.sales.push(undone.sale); change.entries.push(undone.entry); change.events.push({...undone.event,orderId:before.id},{...undone.creditEvent,orderId:before.id});
    } else { const undone = undoSaleCommand(original,context.setup.owner.id,at); change.sales.push(undone.sale); change.events.push({...undone.event,orderId:before.id,customerId:before.customer.id}); }
  }
  change.order.payment = {method:before.payment.method,wallet:before.payment.wallet,status:'pending'}; return change;
}
export function cancelOrderCommand(before: Order, sale: Sale|undefined, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  const {setup} = context; validateOrder(before,setup,revision);
  if (before.payment.status === 'pending') { const changed=changeOrderStatusCommand(before,'cancelled',setup,revision,at); return result(changed.order,changed.event); }
  if (isOrderFinished(before)) throw new Error('A finished order cannot be cancelled.');
  const change = update(before,setup,'order.cancel',at);
  change.order.status = 'cancelled'; change.order.statusChangedAt = at; change.order.statusEventId = change.events[0].id;
  let refundDue = 0, creditEntryId:string|undefined;
  if (before.total !== 0 || before.payment.saleId) {
    const original = linkedSale(before,sale); if (original.voidedAt !== undefined) throw new Error('This payment is already cancelled or undone.');
    if (original.method === 'credit') {
      const returned = returnOrderCreditCommand(original,ledgerFor(before,context),`Credit cancelled · ${before.number}`,at);
      change.entries.push(returned.entry); change.events.push(returned.event); refundDue = returned.refundDue; creditEntryId = returned.entry.id;
    } else refundDue = original.amount;
    const cancelled: Sale = {...original,voidedAt:at,voidReason:'order-cancel',updatedAt:at};
    change.sales.push(cancelled); change.events.push(saleEvent(cancelled,original,setup,'sale.order-cancel',at));
  }
  change.order.payment = {...before.payment,cancellation:{creditEntryId,refundTotal:refundDue,refundDue}}; return change;
}
export function undoOrderCancellationCommand(before: Order, cancelled: AuditEvent, sale: Sale|undefined, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  const {setup} = context;
  const undone = undoOrderStatusCommand(before,cancelled,setup,revision,at), change = result(undone.order,undone.event);
  if (before.status !== 'cancelled') throw new Error('Choose the last cancellation.');
  const cancellation = before.payment.cancellation;
  if (!cancellation) return change;
  if (cancellation.refundDue !== cancellation.refundTotal) throw new Error('A refund has been recorded. Correct that refund before undoing cancellation.');
  if (before.payment.saleId) {
    const original = linkedSale(before,sale);
    if (original.voidReason !== 'order-cancel' || original.voidedAt === undefined) throw new Error('The cancelled payment is missing.');
    if (original.method === 'credit') {
      if (!cancellation.creditEntryId) throw new Error('The credit cancellation is missing.');
      const restored = restoreOrderCreditCommand(original,cancellation.creditEntryId,ledgerFor(before,context),at); change.entries.push(restored.entry); change.events.push(restored.event);
    }
    const restored: Sale = {...original,voidedAt:undefined,voidReason:undefined,updatedAt:at};
    const event = saleEvent(restored,original,setup,'sale.order-cancel-undo',at); event.undoOf = cancelled.id; change.sales.push(restored); change.events.push(event);
  }
  change.order.payment = {...before.payment,cancellation:undefined}; return change;
}
export function refundOrderCommand(before: Order, sale: Sale, input: OrderRefundInput, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  const {setup} = context; validateOrder(before,setup,revision); const original = linkedSale(before,sale), cancellation = before.payment.cancellation;
  if (before.status !== 'cancelled' || original.voidReason !== 'order-cancel' || original.voidedAt === undefined || !cancellation || cancellation.refundDue <= 0 || !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > cancellation.refundDue) throw new Error('Enter a refund up to the remaining amount owed.');
  const historicalWallets = context.ledger ? activeEntries(context.ledger.account,context.ledger.entries).filter(entry => entry.type === 'payment' && entry.methodName && !['Cash','Card'].includes(entry.methodName)).map(entry => entry.methodName!) : [];
  const methodName = paymentMethod(input.method,input.wallet,setup,original,historicalWallets), note = input.note?.trim() || `Refund · ${before.number}`;
  if (note.length > 1000) throw new Error('Keep the refund note within 1,000 characters.');
  const change = update(before,setup,'order.refund',at), eventId = ulid(at);
  const refund: OrderRefund = {id:ulid(at),orderId:before.id,saleId:original.id,outletId:before.outletId,customerId:before.customer.id,accountId:original.creditAccountId,amount:input.amount,currency:before.currency,method:input.method,methodName,note,createdBy:setup.owner.id,eventId,createdAt:at,updatedAt:at};
  if (original.method === 'credit') {
    const credited = recordOrderCreditRefundCommand(refund,ledgerFor(before,context),at); refund.creditEntryId = credited.entry.id; change.entries.push(credited.entry); change.events.push(credited.event);
  }
  change.order.payment = {...before.payment,cancellation:{...cancellation,refundDue:cancellation.refundDue-input.amount}};
  change.refunds.push(refund); change.events.push({id:eventId,outletId:before.outletId,orderId:before.id,actor:{type:'member',id:setup.owner.id},command:'refund.record',before:null,after:refund,at}); return change;
}
export function undoOrderRefundCommand(before: Order, refund: OrderRefund, context: OrderMoneyContext, revision: number, at = Date.now()): OrderMoneyChange {
  const {setup} = context; validateOrder(before,setup,revision); const cancellation = before.payment.cancellation;
  if (before.status !== 'cancelled' || !cancellation || refund.orderId !== before.id || refund.saleId !== before.payment.saleId || refund.outletId !== before.outletId || refund.currency !== before.currency || refund.voidedAt !== undefined || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || (before.payment.method === 'credit' && !refund.accountId) || at < refund.createdAt || at-refund.createdAt > 600000 || BigInt(cancellation.refundDue)+BigInt(refund.amount) > BigInt(cancellation.refundTotal)) throw new Error('This refund record can be undone once, within 10 minutes.');
  const change = update(before,setup,'order.refund-undo',at);
  if (refund.accountId) { const credited = undoOrderCreditRefundCommand(refund,ledgerFor(before,context),at); change.entries.push(credited.entry); change.events.push(credited.event); }
  const voided = {...refund,voidedAt:at,updatedAt:at}; change.refunds.push(voided);
  change.order.payment = {...before.payment,cancellation:{...cancellation,refundDue:cancellation.refundDue+refund.amount}};
  change.events.push({id:ulid(at),outletId:before.outletId,orderId:before.id,actor:{type:'member',id:setup.owner.id},command:'refund.undo',before:refund,after:voided,undoOf:refund.eventId,at}); return change;
}
/** Cash count uses retained receipts from cancelled orders, gross debt payments, then actual refunds. */
export const saleCashIn = (sale: Sale) => sale.method === 'cash' && (sale.voidedAt === undefined || sale.voidReason === 'order-cancel') ? sale.amount : 0;
export const refundCashOut = (refund: OrderRefund) => refund.method === 'cash' && refund.voidedAt === undefined ? refund.amount : 0;
