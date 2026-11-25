import type { PaymentMethod } from './models';
import type { PaymentMatchRecords } from './payment-matches';
import { literalToken } from './literal-token';

export interface CurrentPaymentReceipt {
  kind: 'sale' | 'credit';
  id: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  methodName: string;
  at: number;
  fingerprint: string;
}
/** An actual existing receipt, independent of a message's age or match window.
 * This is read evidence; it neither creates money nor authorizes a writer. */
export function currentPaymentReceipt(
  records: PaymentMatchRecords,
  kind: 'sale' | 'credit',
  id: string,
): CurrentPaymentReceipt | null {
  const { setup } = records,
    { outlet, business } = setup;
  if (outlet.businessId !== business.id)
    throw Error('Read the receipt in its actual business and outlet.');
  const scope = { businessId: business.id, outletId: outlet.id },
    money = (v: number) => Number.isSafeInteger(v) && v > 0;
  const customers = records.customers.filter(
    (c) => c.businessId === business.id,
  );
  if (kind === 'sale') {
    const rows = records.sales.filter(
      (s) => s.id === id && s.outletId === outlet.id,
    );
    if (rows.length !== 1) return null;
    const sale = rows[0];
    if (
      sale.voidedAt !== undefined ||
      sale.method === 'credit' ||
      !money(sale.amount) ||
      records.refunds.some(
        (r) =>
          r.outletId === outlet.id &&
          r.saleId === id &&
          r.voidedAt === undefined &&
          r.amount > 0,
      )
    )
      return null;
    const order = sale.orderId
        ? records.orders.find(
            (o) => o.id === sale.orderId && o.outletId === outlet.id,
          )
        : undefined,
      customer = sale.customerId
        ? customers.find((c) => c.id === sale.customerId)
        : undefined;
    if (
      (sale.orderId &&
        (!order ||
          order.payment.status !== 'paid' ||
          order.payment.saleId !== id ||
          order.payment.cancellation)) ||
      (sale.customerId && !customer)
    )
      return null;
    return {
      kind,
      id,
      amount: sale.amount,
      currency: sale.currency,
      method: sale.method,
      methodName: sale.methodName,
      at: sale.createdAt,
      fingerprint: literalToken({
        scope,
        sale,
        order: order ?? null,
        customer: customer ?? null,
      }),
    };
  }
  const rows = records.entries.filter(
    (e) => e.id === id && e.outletId === outlet.id,
  );
  if (rows.length !== 1) return null;
  const entry = rows[0],
    account = records.accounts.find(
      (a) => a.id === entry.accountId && a.outletId === outlet.id,
    ),
    customer = account
      ? customers.find((c) => c.id === account.customerId)
      : undefined;
  if (
    entry.type !== 'payment' ||
    entry.reversalOf ||
    entry.refundId ||
    !money(entry.amount) ||
    !account ||
    !customer ||
    entry.customerId !== customer.id ||
    entry.currency !== account.currency ||
    !entry.methodName ||
    records.entries.some(
      (e) =>
        e.outletId === outlet.id &&
        e.accountId === entry.accountId &&
        e.customerId === entry.customerId &&
        e.reversalOf === id,
    )
  )
    return null;
  const method =
    entry.methodName === 'Cash'
      ? 'cash'
      : entry.methodName === 'Card'
        ? 'card'
        : 'wallet';
  return {
    kind,
    id,
    amount: entry.amount,
    currency: entry.currency,
    method,
    methodName: entry.methodName,
    at: entry.occurredAt ?? entry.createdAt,
    fingerprint: literalToken({ scope, entry, account, customer }),
  };
}
