import type {
  AuditEvent,
  CreditEntry,
  Order,
  Payment,
  PaymentPosting,
  Sale,
  SetupSnapshot,
} from './models';
import type { PaymentMatchRecords } from './payment-matches';
import {
  assertCurrentPayment,
  writePaymentChange,
  type PaymentChange,
} from './payment-records';
import {
  activePaymentPosting,
  paymentCheckedFields,
  paymentSnapshot,
} from './payment-posting-shape';
import { currentPaymentReceipt } from './payment-receipts';
import { literalToken } from './literal-token';
import { marketPacks } from './packs';
import { moneyInputValue } from './money';
import { orderPricing } from './order-lines';
import {
  settleOrderCommand,
  undoOrderPaymentCommand,
  type OrderMoneyIds,
} from './order-payments';
import { recordSaleCommand, undoSaleCommand } from './sales';
import {
  creditBalance,
  recordCreditPaymentCommand,
  undoCreditEntryCommand,
  type CustomerLedgerContext,
} from './khata';

export type PaymentMoneyTarget =
  | { kind: 'order'; id: string }
  | { kind: 'credit'; id: string }
  | { kind: 'counter'; who: string };
export interface PaymentFinanceRecords extends PaymentMatchRecords {
  events: readonly AuditEvent[];
}
export interface PaymentMoneyPreview {
  target: PaymentPosting['target'];
  label: string;
  amount: number;
  currency: string;
  methodName: string;
  receivedAt: number;
  balance?: number;
}
export type PaymentFinanceIds = (
  kind:
    | 'orderEvent'
    | 'sale'
    | 'saleEvent'
    | 'entry'
    | 'creditEvent'
    | 'refund'
    | 'refundEvent',
) => string;
export interface PaymentMoneyChange {
  payment: PaymentChange;
  orders: Order[];
  sales: Sale[];
  entries: CreditEntry[];
  events: AuditEvent[];
}
const same = (a: unknown, b: unknown) => literalToken(a) === literalToken(b);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
const scope = (setup: SetupSnapshot) => ({
  businessId: setup.business.id,
  outletId: setup.outlet.id,
});
function ledger(
  records: PaymentFinanceRecords,
  accountId: string,
): CustomerLedgerContext {
  const account = records.accounts.find(
      (a) => a.id === accountId && a.outletId === records.setup.outlet.id,
    ),
    customer = account
      ? records.customers.find(
          (c) =>
            c.id === account.customerId &&
            c.businessId === records.setup.business.id,
        )
      : undefined;
  if (!account || !customer)
    throw Error('Choose an actual customer account in this outlet.');
  return {
    setup: records.setup,
    account,
    customer,
    entries: records.entries
      .filter(
        (e) => e.accountId === accountId && e.outletId === account.outletId,
      )
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
  };
}
/** Manual recording labels, not a bank connection or proof that money arrived. */
function wallets(payment: Payment, setup: SetupSnapshot): string[] {
  const originalMarket = payment.parsed.sourceContext.market,
    allowed = [
      ...marketPacks[setup.business.marketCode]['pay/wallets'],
      ...(originalMarket ? marketPacks[originalMarket]['pay/wallets'] : []),
      'Bank transfer',
    ];
  ensure(
    payment.method === 'cash'
      ? payment.methodName === 'Cash'
      : payment.method === 'card'
        ? payment.methodName === 'Card'
        : payment.methodName !== 'Cash' && allowed.includes(payment.methodName),
    'Choose a supported actual payment method before recording money.',
  );
  if (payment.methodName === 'Bank transfer')
    ensure(
      !!payment.referenceScope?.trim(),
      'Name the bank/source before recording this transfer. This label does not verify the transfer.',
    );
  return [...new Set(allowed)];
}
function ready(
  payment: Payment,
  records: PaymentFinanceRecords,
  payments: readonly Payment[],
  at: number,
) {
  assertCurrentPayment(payment, payment.revision, records.setup);
  ensure(
    payment.voidedAt === undefined && !activePaymentPosting(payment),
    'Undo or inspect this source’s existing recording before recording more money.',
  );
  ensure(
    payment.parsed.direction !== 'outgoing',
    'This source describes outgoing money. Keep it for review and use the manual money path for a genuinely received payment.',
  );
  ensure(
    payment.receivedAt <= at + 300000,
    'Check the received time before recording a future transfer.',
  );
  wallets(payment, records.setup);
  ensure(
    !payments.some(
      (other) =>
        other.id !== payment.id &&
        other.outletId === payment.outletId &&
        other.voidedAt === undefined &&
        payment.referenceKey !== undefined &&
        other.referenceKey === payment.referenceKey,
    ),
    'This observed reference is already retained by another payment source.',
  );
}
export function previewPaymentMoney(
  payment: Payment,
  records: PaymentFinanceRecords,
  payments: readonly Payment[],
  target: PaymentMoneyTarget,
  note = '',
  at = Date.now(),
): PaymentMoneyPreview {
  ready(payment, records, payments, at);
  ensure(
    typeof note === 'string' && note.length <= 4000,
    'Keep the separate recording note within 4,000 characters. The complete original stays in its source.',
  );
  ensure(
    !!target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      ['order', 'credit', 'counter'].includes(target.kind),
    'Choose a real order, customer account or a new counter receipt.',
  );
  const s = scope(records.setup),
    base = {
      amount: payment.amount,
      currency: payment.currency,
      methodName: payment.methodName,
      receivedAt: payment.receivedAt,
    };
  if (target.kind === 'order') {
    ensure(
      Object.keys(target).sort().join(',') === 'id,kind' && id(target.id),
      'Choose the actual order identity.',
    );
    const order = records.orders.find(
      (o) => o.id === target.id && o.outletId === payment.outletId,
    );
    if (!order) throw Error('Order not found in this outlet.');
    const pricing = orderPricing(
      order.lines,
      order.deliveryFee,
      order.discount,
    );
    ensure(
      order.payment.status === 'pending' &&
        !order.payment.saleId &&
        !['cancelled', 'returning', 'returned'].includes(order.status) &&
        pricing.complete &&
        pricing.total === order.total &&
        pricing.subtotal === order.subtotal &&
        order.total === payment.amount &&
        order.currency === payment.currency,
      'Check the current unpaid order, final prices, amount and currency.',
    );
    ensure(
      !payments.some(
        (other) =>
          other.id !== payment.id &&
          other.outletId === payment.outletId &&
          other.voidedAt === undefined &&
          other.association?.kind === 'order' &&
          other.association.id === order.id,
      ),
      'Another payment source reserves this order. Inspect its original first.',
    );
    ensure(
      !payment.association ||
        (payment.association.kind === 'order' &&
          payment.association.id === order.id),
      'Unmatch the existing receipt before choosing a different recording.',
    );
    return {
      ...base,
      label: order.number,
      target: {
        kind: 'order',
        id: order.id,
        fingerprint: literalToken({ scope: s, order }),
      },
    };
  }
  ensure(
    !payment.association,
    'This observation already has an association. Inspect or unmatch it before recording new money.',
  );
  if (target.kind === 'credit') {
    ensure(
      Object.keys(target).sort().join(',') === 'id,kind' && id(target.id),
      'Choose the actual customer account identity.',
    );
    const context = ledger(records, target.id),
      balance = creditBalance(context.account, context.entries);
    ensure(
      context.account.currency === payment.currency &&
        balance >= payment.amount,
      'Choose an account in the observed currency with enough actual debt.',
    );
    return {
      ...base,
      label: context.customer.nickname || context.customer.name,
      balance,
      target: {
        kind: 'credit',
        id: context.account.id,
        fingerprint: literalToken({
          scope: s,
          account: context.account,
          customer: context.customer,
          entries: context.entries,
        }),
      },
    };
  }
  ensure(
    Object.keys(target).sort().join(',') === 'kind,who' &&
      typeof target.who === 'string' &&
      target.who.trim().length <= 80,
    'Use a counter receipt name of at most 80 characters.',
  );
  ensure(
    payment.currency === records.setup.outlet.currency,
    'New counter receipts use the current outlet currency. Keep the original currency and choose its actual order or khata instead.',
  );
  return {
    ...base,
    label: 'New counter receipt',
    target: {
      kind: 'counter',
      id: payment.outletId,
      fingerprint: literalToken({
        scope: s,
        business: records.setup.business,
        outlet: records.setup.outlet,
        who: target.who.trim(),
      }),
    },
  };
}
function orderIds(ids: PaymentFinanceIds): OrderMoneyIds {
  return (kind) => ids(kind === 'event' ? 'orderEvent' : kind);
}
function changedRecords(
  records: PaymentFinanceRecords,
  orders: Order[],
  sales: Sale[],
  entries: CreditEntry[],
): PaymentFinanceRecords {
  const merge = <T extends { id: string }>(old: readonly T[], next: T[]) => [
    ...old.filter((row) => !next.some((n) => n.id === row.id)),
    ...next,
  ];
  return {
    ...records,
    orders: merge(records.orders, orders),
    sales: merge(records.sales, sales),
    entries: merge(records.entries, entries),
  };
}
/** Explicitly record NEW money after a current comparison. Linking an existing
 * receipt uses the separate metadata association command and never comes here. */
export function recordPaymentMoneyCommand(
  before: Payment,
  revision: number,
  records: PaymentFinanceRecords,
  payments: readonly Payment[],
  target: PaymentMoneyTarget,
  expectedFingerprint: string,
  note: string,
  confirmedNewMoney: boolean,
  eventId: string,
  ids: PaymentFinanceIds,
  at = Date.now(),
): PaymentMoneyChange {
  assertCurrentPayment(before, revision, records.setup);
  ensure(
    confirmedNewMoney === true,
    'Confirm that this money was received and is not already recorded.',
  );
  const preview = previewPaymentMoney(
    before,
    records,
    payments,
    target,
    note,
    at,
  );
  ensure(
    preview.target.fingerprint === expectedFingerprint,
    'The selected financial target changed. Review it again.',
  );
  const allowed = wallets(before, records.setup),
    orders: Order[] = [],
    sales: Sale[] = [],
    entries: CreditEntry[] = [],
    events: AuditEvent[] = [];
  let kind: 'sale' | 'credit', receiptId: string;
  if (target.kind === 'order') {
    const order = records.orders.find(
        (o) => o.id === target.id && o.outletId === before.outletId,
      )!,
      change = settleOrderCommand(
        order,
        {
          method: before.method,
          ...(before.method === 'wallet' ? { wallet: before.methodName } : {}),
        },
        { setup: records.setup, wallets: allowed },
        order.revision,
        at,
        orderIds(ids),
      );
    ensure(
      change.sales.length === 1 &&
        change.entries.length === 0 &&
        change.refunds.length === 0,
      'Keep the actual collected order receipt.',
    );
    orders.push(change.order);
    sales.push(...change.sales);
    events.push(...change.events);
    kind = 'sale';
    receiptId = change.sales[0].id;
  } else if (target.kind === 'credit') {
    const change = recordCreditPaymentCommand(
      before.amount,
      before.method,
      before.method === 'wallet' ? before.methodName : undefined,
      ledger(records, target.id),
      allowed,
      note,
      at,
      (type) => ids(type === 'event' ? 'creditEvent' : 'entry'),
    );
    entries.push(change.entry);
    events.push(change.event);
    kind = 'credit';
    receiptId = change.entry.id;
  } else {
    const change = recordSaleCommand(
      {
        expression: moneyInputValue(before.amount, before.currency).replace(
          ',',
          '.',
        ),
        method: before.method,
        ...(before.method === 'wallet' ? { wallet: before.methodName } : {}),
        who: target.who,
      },
      { setup: records.setup, items: [], wallets: allowed },
      at,
      (type) => ids(type === 'event' ? 'saleEvent' : 'sale'),
    );
    sales.push(change.sale);
    events.push(change.event);
    kind = 'sale';
    receiptId = change.sale.id;
  }
  const identities = [eventId, receiptId, ...events.map((event) => event.id)];
  ensure(
    identities.every(id) &&
      new Set(identities).size === identities.length &&
      !identities.some((id) => id === before.id || id === before.inboxId),
    'Use distinct original financial and payment identities.',
  );
  const actual = currentPaymentReceipt(
    changedRecords(records, orders, sales, entries),
    kind,
    receiptId,
  );
  ensure(
    actual &&
      actual.amount === before.amount &&
      actual.currency === before.currency &&
      actual.method === before.method &&
      actual.methodName === before.methodName,
    'Keep the actual new financial receipt.',
  );
  const posting: PaymentPosting = {
    eventId,
    at,
    note,
    money: paymentCheckedFields(before),
    target: preview.target,
    receipt: {
      kind,
      id: receiptId,
      fingerprint: actual!.fingerprint,
      eventIds: events.map((event) => event.id),
    },
  };
  const payment = writePaymentChange(
    before,
    {
      ...before,
      postings: [...(before.postings ?? []), posting],
      association: {
        kind,
        id: receiptId,
        fingerprint: actual!.fingerprint,
        at,
        eventId,
      },
    },
    records.setup,
    'payment.record',
    at,
    eventId,
  );
  return { payment, orders, sales, entries, events };
}

export interface PaymentUndoEvidence {
  fingerprint: string;
  events: AuditEvent[];
}
/** Prove an existing undo through the exact original financial identities. */
export function paymentMoneyUndoEvidence(
  posting: PaymentPosting,
  records: PaymentFinanceRecords,
): PaymentUndoEvidence | null {
  const expected = posting.receipt.kind === 'sale' ? 'sale.undo' : 'khata.undo',
    original = paymentSnapshot(posting.receipt.fingerprint),
    row = original[posting.receipt.kind === 'sale' ? 'sale' : 'entry'] as
      Sale | CreditEntry;
  const financial = records.events.filter(
    (event) =>
      event.outletId === records.setup.outlet.id &&
      event.command === expected &&
      event.undoOf === row.eventId &&
      same(event.before, row),
  );
  if (financial.length !== 1) return null;
  const event = financial[0],
    events: AuditEvent[] = [];
  let receipt: Sale | CreditEntry,
    reversal: CreditEntry | null = null;
  if (posting.receipt.kind === 'sale') {
    const sale = records.sales.find(
      (s) =>
        s.id === posting.receipt.id && s.outletId === records.setup.outlet.id,
    );
    if (
      !sale ||
      sale.voidedAt === undefined ||
      sale.voidReason !== 'undo' ||
      !same(event.after, sale)
    )
      return null;
    receipt = sale;
    if (posting.target.kind === 'order') {
      const candidates = records.events.filter((e) => {
        const b = e.before as Order | null,
          a = e.after as Order | null;
        return (
          e.outletId === sale.outletId &&
          e.orderId === posting.target.id &&
          e.command === 'order.payment-undo' &&
          e.at === event.at &&
          b?.payment.saleId === sale.id &&
          a?.payment.status === 'pending' &&
          !a.payment.saleId
        );
      });
      if (candidates.length !== 1) return null;
      events.push(candidates[0]);
    }
  } else {
    const originalEntry = row as CreditEntry,
      entry = records.entries.find(
        (e) =>
          e.id === posting.receipt.id && e.outletId === records.setup.outlet.id,
      ),
      reversed = records.entries.filter(
        (e) =>
          e.outletId === records.setup.outlet.id &&
          e.accountId === originalEntry.accountId &&
          e.reversalOf === row.id,
      );
    if (
      !entry ||
      !same(entry, row) ||
      reversed.length !== 1 ||
      !same(event.after, reversed[0]) ||
      reversed[0].amount !== row.amount
    )
      return null;
    receipt = entry;
    reversal = reversed[0];
  }
  events.push(event);
  return {
    events,
    fingerprint: literalToken({
      scope: scope(records.setup),
      receipt,
      reversal,
      events,
    }),
  };
}
export function previewPaymentMoneyUndo(
  payment: Payment,
  records: PaymentFinanceRecords,
  at = Date.now(),
) {
  assertCurrentPayment(payment, payment.revision, records.setup);
  const posting = activePaymentPosting(payment);
  if (!posting) throw Error('Choose this source’s actual recorded money.');
  const evidence = paymentMoneyUndoEvidence(posting, records),
    actual =
      posting.receipt.kind === 'sale'
        ? records.sales.find(
            (s) =>
              s.id === posting.receipt.id && s.outletId === payment.outletId,
          )
        : records.entries.find(
            (e) =>
              e.id === posting.receipt.id && e.outletId === payment.outletId,
          );
  ensure(actual, 'Keep the original financial receipt and source.');
  let state: unknown;
  if (evidence) state = { mode: 'already-undone', evidence };
  else if (posting.target.kind === 'order') {
    const order = records.orders.find(
      (o) => o.id === posting.target.id && o.outletId === payment.outletId,
    );
    ensure(
      order && order.payment.saleId === posting.receipt.id,
      'The order has another payment or changed after this receipt. Open its current financial history.',
    );
    state = {
      order,
      sale: actual,
      refunds: records.refunds.filter((r) => r.orderId === posting.target.id),
    };
  } else if (posting.receipt.kind === 'credit') {
    const entry = actual as CreditEntry;
    state = { entry, ...ledger(records, entry.accountId) };
  } else state = { sale: actual };
  return {
    postingId: posting.eventId,
    receiptId: posting.receipt.id,
    alreadyUndone: !!evidence,
    fingerprint: literalToken({ scope: scope(records.setup), posting, state }),
    recordedAt: posting.at,
    receivedAt: posting.money.receivedAt,
    undoDeadline: posting.at + 600000,
    expired: !evidence && at > posting.at + 600000,
  };
}
export function undoPaymentMoneyCommand(
  before: Payment,
  revision: number,
  records: PaymentFinanceRecords,
  expectedFingerprint: string,
  confirmedUndo: boolean,
  eventId: string,
  ids: PaymentFinanceIds,
  at = Date.now(),
): PaymentMoneyChange {
  assertCurrentPayment(before, revision, records.setup);
  ensure(
    confirmedUndo === true,
    'Confirm which original financial recording to undo.',
  );
  const preview = previewPaymentMoneyUndo(before, records, at);
  ensure(
    preview.fingerprint === expectedFingerprint,
    'The current financial receipt changed. Review it again.',
  );
  const posting = activePaymentPosting(before)!,
    orders: Order[] = [],
    sales: Sale[] = [],
    entries: CreditEntry[] = [],
    events: AuditEvent[] = [];
  let evidence = paymentMoneyUndoEvidence(posting, records);
  const mode = evidence ? ('already-undone' as const) : ('performed' as const);
  if (!evidence) {
    const original = paymentSnapshot(posting.receipt.fingerprint),
      recorded = original[
        posting.receipt.kind === 'sale' ? 'sale' : 'entry'
      ] as Sale | CreditEntry;
    if (posting.target.kind === 'order') {
      const order = records.orders.find(
          (o) => o.id === posting.target.id && o.outletId === before.outletId,
        )!,
        sale = records.sales.find(
          (s) => s.id === posting.receipt.id && s.outletId === before.outletId,
        );
      ensure(
        sale &&
          same(sale, recorded) &&
          !records.refunds.some(
            (r) => r.saleId === sale.id && r.voidedAt === undefined,
          ),
        'The original order receipt changed or has a refund. Inspect its financial history.',
      );
      const change = undoOrderPaymentCommand(
        order,
        sale,
        { setup: records.setup },
        order.revision,
        at,
        orderIds(ids),
      );
      orders.push(change.order);
      sales.push(...change.sales);
      entries.push(...change.entries);
      events.push(...change.events);
    } else if (posting.receipt.kind === 'credit') {
      const entry = records.entries.find(
        (e) => e.id === posting.receipt.id && e.outletId === before.outletId,
      );
      ensure(
        entry && same(entry, recorded),
        'The original khata receipt changed.',
      );
      const change = undoCreditEntryCommand(
        entry!,
        ledger(records, entry!.accountId),
        at,
        false,
        (type) => ids(type === 'event' ? 'creditEvent' : 'entry'),
      );
      entries.push(change.entry);
      events.push(change.event);
    } else {
      const sale = records.sales.find(
        (s) => s.id === posting.receipt.id && s.outletId === before.outletId,
      );
      ensure(
        sale && same(sale, recorded),
        'The original counter receipt changed.',
      );
      const change = undoSaleCommand(sale!, records.setup.owner.id, at, () =>
        ids('saleEvent'),
      );
      sales.push(change.sale);
      events.push(change.event);
    }
    evidence = paymentMoneyUndoEvidence(posting, {
      ...changedRecords(records, orders, sales, entries),
      events: [...records.events, ...events],
    });
    ensure(
      evidence,
      'Keep the actual original financial undo and its receipts.',
    );
  }
  const unmatched = { ...before },
    postings = structuredClone(before.postings!);
  delete unmatched.association;
  postings[postings.length - 1] = {
    ...posting,
    undo: {
      eventId,
      at,
      eventIds: evidence!.events.map((e) => e.id),
      fingerprint: evidence!.fingerprint,
      mode,
    },
  };
  const payment = writePaymentChange(
    before,
    { ...unmatched, postings },
    records.setup,
    'payment.record-undo',
    at,
    eventId,
    posting.eventId,
  );
  return { payment, orders, sales, entries, events };
}
