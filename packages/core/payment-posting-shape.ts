import type { Payment, PaymentCheckedFields, PaymentPosting } from './models';
import { literalToken } from './literal-token';
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, required: string, optional = '') =>
  required.split(',').every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) =>
    (required + ',' + optional).split(',').includes(k),
  );
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 253402300799999;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the complete payment recording, original target and financial receipt.',
    );
}
export function paymentCheckedFields(
  p: PaymentCheckedFields,
): PaymentCheckedFields {
  return {
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    methodName: p.methodName,
    reference: p.reference,
    ...(p.referenceScope !== undefined
      ? { referenceScope: p.referenceScope }
      : {}),
    ...(p.fromPhone !== undefined ? { fromPhone: p.fromPhone } : {}),
    receivedAt: p.receivedAt,
  };
}
export function activePaymentPosting(
  p: Pick<Payment, 'postings'>,
): PaymentPosting | undefined {
  return p.postings?.find((posting) => !posting.undo);
}
export function paymentSnapshot(value: unknown): Record<string, unknown> {
  ensure(typeof value === 'string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value as string);
  } catch {
    throw Error('Keep the literal original financial snapshot.');
  }
  ensure(obj(parsed));
  return parsed as Record<string, unknown>;
}
function validateMoney(v: unknown): asserts v is PaymentCheckedFields {
  ensure(
    obj(v) &&
      keys(
        v,
        'amount,currency,method,methodName,reference,receivedAt',
        'fromPhone,referenceScope',
      ),
  );
  const m = v as unknown as PaymentCheckedFields;
  ensure(
    Number.isSafeInteger(m.amount) &&
      m.amount > 0 &&
      /^[A-Z]{3}$/.test(m.currency) &&
      ['cash', 'wallet', 'card'].includes(m.method) &&
      text(m.methodName, 120) &&
      m.methodName.trim() &&
      text(m.reference, 120) &&
      time(m.receivedAt) &&
      (m.fromPhone === undefined || /^\+[1-9]\d{6,14}$/.test(m.fromPhone)) &&
      (m.referenceScope === undefined ||
        (m.method === 'wallet' &&
          m.methodName === 'Bank transfer' &&
          text(m.referenceScope, 120) &&
          m.referenceScope.trim())),
  );
  ensure(m.method !== 'cash' || m.methodName === 'Cash');
  ensure(m.method !== 'card' || m.methodName === 'Card');
}
function scope(s: Record<string, unknown>, outletId: string) {
  ensure(
    obj(s.scope) &&
      keys(s.scope, 'businessId,outletId') &&
      id(s.scope.businessId) &&
      s.scope.outletId === outletId,
  );
  return s.scope as { businessId: string; outletId: string };
}
/** Historical shapes retain old checked values after a later explicit correction. */
export function validatePaymentPostings(p: Payment): void {
  if (p.postings === undefined) return;
  ensure(Array.isArray(p.postings) && p.postings.length > 0);
  const identities = new Set<string>();
  let previousAt = p.createdAt;
  for (const [index, posting] of p.postings.entries()) {
    ensure(
      obj(posting) &&
        keys(posting, 'eventId,at,money,target,receipt,note', 'undo') &&
        id(posting.eventId) &&
        time(posting.at) &&
        posting.at >= previousAt &&
        text(posting.note, 4000),
    );
    previousAt = posting.at;
    validateMoney(posting.money);
    ensure(
      obj(posting.target) &&
        keys(posting.target, 'kind,id,fingerprint') &&
        ['order', 'credit', 'counter'].includes(posting.target.kind) &&
        id(posting.target.id),
    );
    ensure(
      obj(posting.receipt) &&
        keys(posting.receipt, 'kind,id,fingerprint,eventIds') &&
        ['sale', 'credit'].includes(posting.receipt.kind) &&
        id(posting.receipt.id) &&
        Array.isArray(posting.receipt.eventIds),
    );
    const target = paymentSnapshot(posting.target.fingerprint),
      targetScope = scope(target, p.outletId),
      receipt = paymentSnapshot(posting.receipt.fingerprint),
      receiptScope = scope(receipt, p.outletId);
    ensure(targetScope.businessId === receiptScope.businessId);
    if (posting.target.kind === 'order')
      ensure(
        keys(target, 'scope,order') &&
          obj(target.order) &&
          target.order.id === posting.target.id &&
          target.order.outletId === p.outletId &&
          target.order.total === posting.money.amount &&
          target.order.currency === posting.money.currency &&
          obj(target.order.payment) &&
          target.order.payment.status === 'pending' &&
          posting.receipt.kind === 'sale',
      );
    else if (posting.target.kind === 'credit')
      ensure(
        keys(target, 'scope,account,customer,entries') &&
          obj(target.account) &&
          obj(target.customer) &&
          Array.isArray(target.entries) &&
          target.account.id === posting.target.id &&
          target.account.outletId === p.outletId &&
          target.account.currency === posting.money.currency &&
          target.customer.id === target.account.customerId &&
          target.customer.businessId === targetScope.businessId &&
          posting.receipt.kind === 'credit',
      );
    else
      ensure(
        keys(target, 'scope,business,outlet,who') &&
          obj(target.business) &&
          obj(target.outlet) &&
          target.business.id === targetScope.businessId &&
          target.outlet.id === p.outletId &&
          posting.target.id === p.outletId &&
          text(target.who, 80) &&
          posting.receipt.kind === 'sale',
      );
    const expectedKeys =
      posting.receipt.kind === 'sale'
        ? 'scope,sale,order,customer'
        : 'scope,entry,account,customer';
    ensure(keys(receipt, expectedKeys));
    const row = receipt[posting.receipt.kind === 'sale' ? 'sale' : 'entry'];
    ensure(
      obj(row) &&
        row.id === posting.receipt.id &&
        row.outletId === p.outletId &&
        row.amount === posting.money.amount &&
        row.currency === posting.money.currency &&
        row.methodName === posting.money.methodName &&
        row.createdAt === posting.at,
    );
    if (posting.receipt.kind === 'sale') {
      ensure(row.method === posting.money.method && row.voidedAt === undefined);
      if (posting.target.kind === 'order')
        ensure(
          obj(receipt.order) &&
            receipt.order.id === posting.target.id &&
            row.orderId === posting.target.id &&
            obj(receipt.order.payment) &&
            receipt.order.payment.status === 'paid' &&
            receipt.order.payment.saleId === row.id,
        );
      else ensure(receipt.order === null && row.orderId === undefined);
    } else
      ensure(
        row.type === 'payment' &&
          row.reversalOf === undefined &&
          row.refundId === undefined &&
          row.accountId === posting.target.id &&
          obj(receipt.account) &&
          receipt.account.id === posting.target.id &&
          obj(receipt.customer) &&
          row.customerId === receipt.customer.id,
      );
    ensure(
      posting.receipt.eventIds.length ===
        (posting.target.kind === 'order' ? 2 : 1) &&
        posting.receipt.eventIds.every(id),
    );
    for (const value of [posting.eventId, ...posting.receipt.eventIds]) {
      ensure(!identities.has(value) && value !== p.id && value !== p.inboxId);
      identities.add(value);
    }
    if (posting.undo) {
      const undo = posting.undo;
      ensure(
        obj(undo) &&
          keys(undo, 'eventId,at,eventIds,fingerprint,mode') &&
          id(undo.eventId) &&
          time(undo.at) &&
          undo.at >= posting.at &&
          ['performed', 'already-undone'].includes(undo.mode) &&
          Array.isArray(undo.eventIds) &&
          undo.eventIds.length === (posting.target.kind === 'order' ? 2 : 1) &&
          undo.eventIds.every(id),
      );
      const snapshot = paymentSnapshot(undo.fingerprint);
      ensure(
        keys(snapshot, 'scope,receipt,reversal,events') &&
          scope(snapshot, p.outletId).businessId === targetScope.businessId &&
          obj(snapshot.receipt) &&
          snapshot.receipt.id === posting.receipt.id &&
          Array.isArray(snapshot.events) &&
          snapshot.events.length === undo.eventIds.length &&
          snapshot.events.every(
            (event, i) => obj(event) && event.id === undo.eventIds[i],
          ),
      );
      for (const value of [undo.eventId, ...undo.eventIds]) {
        ensure(!identities.has(value) && value !== p.id && value !== p.inboxId);
        identities.add(value);
      }
      previousAt = undo.at;
    } else {
      ensure(
        index === p.postings.length - 1 &&
          p.voidedAt === undefined &&
          literalToken(paymentCheckedFields(p)) === literalToken(posting.money),
      );
      ensure(
        p.association &&
          p.association.kind === posting.receipt.kind &&
          p.association.id === posting.receipt.id &&
          p.association.fingerprint === posting.receipt.fingerprint &&
          p.association.eventId === posting.eventId &&
          p.association.at === posting.at,
      );
    }
  }
}
