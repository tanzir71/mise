import type { CreditEntry, Order, Payment, Sale } from './models';
import type { BackupTables } from './backup-tables';
import { validateBackupRow } from './backup-schema';
import { literalToken } from './literal-token';
import { validatePaymentPostingSnapshots } from './payment-posting-shape';
import { PaymentEvidenceReader } from './payment-evidence';
import { validatePaymentAssociationSnapshot } from './payment-records';

type FinancialTables = Pick<
  BackupTables,
  | 'outlets'
  | 'orders'
  | 'sales'
  | 'creditEntries'
  | 'creditAccounts'
  | 'customers'
  | 'events'
>;
const same = (a: unknown, b: unknown) =>
  a === b || literalToken(a) === literalToken(b);
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the original payment recording and its actual financial audit links.',
    );
}
function associationRows(p: Payment, snapshot: Record<string, unknown>) {
  const a = p.association!,
    s = snapshot.scope as { businessId: string; outletId: string },
    row = snapshot[a.kind === 'credit' ? 'entry' : a.kind] as Record<
      string,
      unknown
    >;
  validateBackupRow(
    a.kind === 'order'
      ? 'orders'
      : a.kind === 'sale'
        ? 'sales'
        : 'creditEntries',
    row,
    'original payment candidate',
  );
  if (a.kind === 'credit') {
    validateBackupRow(
      'creditAccounts',
      snapshot.account,
      'original payment candidate account',
    );
    validateBackupRow(
      'customers',
      snapshot.customer,
      'original payment candidate customer',
    );
    const account = snapshot.account as {
        id: string;
        outletId: string;
        currency: string;
        customerId: string;
      },
      customer = snapshot.customer as { id: string; businessId: string };
    ensure(
      account.id === row.accountId &&
        account.outletId === s.outletId &&
        account.currency === row.currency &&
        account.customerId === row.customerId &&
        customer.id === row.customerId &&
        customer.businessId === s.businessId,
    );
  } else if (a.kind === 'sale') {
    if (snapshot.order !== null) {
      validateBackupRow(
        'orders',
        snapshot.order,
        'original payment candidate order',
      );
      const order = snapshot.order as Order;
      ensure(
        order.id === row.orderId &&
          order.outletId === s.outletId &&
          order.currency === row.currency &&
          order.payment.saleId === row.id &&
          order.payment.status === 'paid',
      );
    } else ensure(row.orderId === undefined);
    if (snapshot.customer !== null) {
      validateBackupRow(
        'customers',
        snapshot.customer,
        'original payment candidate customer',
      );
      const customer = snapshot.customer as { id: string; businessId: string };
      ensure(
        customer.id === row.customerId && customer.businessId === s.businessId,
      );
    } else ensure(row.customerId === undefined);
  }
}
/** A historical snapshot is evidence only when the original domain audit and
 * financial identities still exist. Later edits, refunds and undo may make an
 * association stale; they must not erase or rewrite this original recording. */
export function validatePaymentFinanceLinks(
  payments: readonly Payment[],
  tables: FinancialTables,
): void {
  const claimed = new Set<string>(),
    reader = new PaymentEvidenceReader(tables.events, tables.creditEntries),
    eventMap = new Map(tables.events.map((e) => [e.id, e])),
    entryMap = new Map(tables.creditEntries.map((e) => [e.id, e]));
  const histories = new Map<string, Payment[]>();
  for (const event of tables.events)
    if (event.paymentId) {
      const chain = histories.get(event.paymentId) ?? [];
      chain.push(event.after as Payment);
      histories.set(event.paymentId, chain);
    }
  for (const payment of payments) {
    for (const original of histories.get(payment.id) ?? []) {
      const a = original.association;
      if (a) {
        const snapshot = reader.expand(a.fingerprint, a.at);
        validatePaymentAssociationSnapshot(original, a, snapshot);
        associationRows(original, snapshot);
      }
    }
    for (const posting of payment.postings ?? []) {
      const outlet = tables.outlets.find((row) => row.id === payment.outletId);
      ensure(outlet);
      const target = reader.expand(posting.target.fingerprint, posting.at),
        receipt = reader.expand(posting.receipt.fingerprint, posting.at);
      ensure(
        same(target.scope, {
          businessId: outlet.businessId,
          outletId: outlet.id,
        }) && same(receipt.scope, target.scope),
      );
      validatePaymentPostingSnapshots(payment, posting, target, receipt);
      const lookup = (id: string) => {
        const event = eventMap.get(id);
        ensure(event && event.outletId === outlet.id);
        return event;
      };
      const action = lookup(posting.eventId);
      ensure(
        action.command === 'payment.record' &&
          action.paymentId === payment.id &&
          action.at === posting.at &&
          same((action.after as Payment).postings?.at(-1), {
            ...posting,
            undo: undefined,
          }),
      );
      const events = posting.receipt.eventIds.map(lookup);
      for (const event of events)
        ensure(
          event.at === posting.at &&
            same(event.actor, action.actor) &&
            !event.undoOf,
        );
      const key = JSON.stringify([posting.receipt.kind, posting.receipt.id]);
      ensure(!claimed.has(key));
      claimed.add(key);
      if (posting.receipt.kind === 'sale') {
        validateBackupRow('sales', receipt.sale, 'payment original sale');
        const sale = receipt.sale as Sale;
        const current = tables.sales.find(
          (row) => row.id === sale.id && row.outletId === outlet.id,
        );
        ensure(
          current &&
            same(
              {
                ...current,
                updatedAt: sale.updatedAt,
                voidedAt: undefined,
                voidReason: undefined,
              },
              sale,
            ),
        );
        const event = events.at(-1)!;
        ensure(
          event.command === 'sale.record' &&
            event.id === sale.eventId &&
            event.before === null &&
            same(event.after, sale) &&
            sale.createdBy === action.actor.id,
        );
        if (posting.target.kind === 'order') {
          validateBackupRow(
            'orders',
            target.order,
            'payment original unpaid order',
          );
          validateBackupRow(
            'orders',
            receipt.order,
            'payment original paid order',
          );
          const before = target.order as Order,
            after = receipt.order as Order,
            current = tables.orders.find(
              (row) => row.id === before.id && row.outletId === outlet.id,
            ),
            orderEvent = events[0];
          ensure(
            current &&
              orderEvent.command === 'order.payment' &&
              orderEvent.orderId === before.id &&
              same(orderEvent.before, before) &&
              same(orderEvent.after, after) &&
              after.eventId === orderEvent.id &&
              after.revision === before.revision + 1 &&
              after.updatedAt === posting.at &&
              sale.orderId === before.id &&
              sale.customerId === before.customer.id &&
              sale.currency === before.currency &&
              sale.amount === before.total &&
              event.orderId === before.id &&
              event.customerId === sale.customerId,
          );
          ensure(
            before.payment.status === 'pending' &&
              !before.payment.saleId &&
              after.payment.status === 'paid' &&
              after.payment.saleId === sale.id &&
              after.payment.method === sale.method &&
              after.payment.at === posting.at,
          );
          ensure(
            same(
              {
                ...before,
                revision: after.revision,
                updatedAt: after.updatedAt,
                eventId: after.eventId,
                payment: after.payment,
              },
              after,
            ),
          );
        } else {
          ensure(
            posting.target.kind === 'counter' &&
              !sale.orderId &&
              sale.who === target.who,
          );
          validateBackupRow(
            'outlets',
            target.outlet,
            'payment original counter outlet',
          );
          ensure(
            (target.outlet as { currency: string }).currency === sale.currency,
          );
        }
      } else {
        validateBackupRow(
          'creditEntries',
          receipt.entry,
          'payment original khata collection',
        );
        validateBackupRow(
          'creditAccounts',
          receipt.account,
          'payment original account',
        );
        validateBackupRow(
          'customers',
          receipt.customer,
          'payment original customer',
        );
        const entry = receipt.entry as CreditEntry,
          event = events[0],
          current = tables.creditEntries.find(
            (row) => row.id === entry.id && row.outletId === outlet.id,
          );
        ensure(
          current &&
            same(current, entry) &&
            event.command === 'khata.payment' &&
            event.id === entry.eventId &&
            event.before === null &&
            same(event.after, entry) &&
            entry.createdBy === action.actor.id &&
            entry.type === 'payment' &&
            entry.note === posting.note,
        );
        const account = tables.creditAccounts.find(
            (row) => row.id === entry.accountId && row.outletId === outlet.id,
          ),
          customer = tables.customers.find(
            (row) =>
              row.id === entry.customerId &&
              row.businessId === outlet.businessId,
          );
        ensure(
          account &&
            customer &&
            account.currency === entry.currency &&
            account.customerId === entry.customerId &&
            same(target.account, receipt.account) &&
            same(target.customer, receipt.customer),
        );
        const prefix = reader.ledger(posting.target.fingerprint);
        if (prefix)
          ensure(
            prefix.accountId === entry.accountId &&
              prefix.throughSequence + 1 === entry.sequence &&
              prefix.balance >= entry.amount &&
              event.customerId === entry.customerId,
          );
        else {
          const original = target.entries as CreditEntry[];
          for (const row of original) {
            validateBackupRow('creditEntries', row, 'payment original ledger');
            ensure(
              row.outletId === outlet.id &&
                row.accountId === entry.accountId &&
                same(entryMap.get(row.id), row),
            );
          }
          ensure(
            same(
              original,
              tables.creditEntries
                .filter(
                  (row) =>
                    row.accountId === entry.accountId &&
                    row.sequence < entry.sequence,
                )
                .sort(
                  (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
                ),
            ) &&
              entry.sequence ===
                original.reduce((max, row) => Math.max(max, row.sequence), 0) +
                  1 &&
              event.customerId === entry.customerId,
          );
        }
      }
      if (!posting.undo) continue;
      const undo = posting.undo,
        ack = lookup(undo.eventId),
        snapshot = reader.expand(undo.fingerprint, undo.at),
        undoEvents = undo.eventIds.map(lookup);
      ensure(
        ack.command === 'payment.record-undo' &&
          ack.paymentId === payment.id &&
          ack.at === undo.at &&
          ack.undoOf === posting.eventId &&
          same(snapshot.events, undoEvents) &&
          same(snapshot.scope, target.scope),
      );
      ensure(same((ack.after as Payment).postings?.at(-1), posting));
      const event = undoEvents.at(-1)!,
        original = receipt[
          posting.receipt.kind === 'sale' ? 'sale' : 'entry'
        ] as Sale | CreditEntry;
      ensure(
        event.command ===
          (posting.receipt.kind === 'sale' ? 'sale.undo' : 'khata.undo') &&
          event.undoOf === original.eventId &&
          same(event.before, original) &&
          event.at >= posting.at &&
          event.at <= posting.at + 600000 &&
          undo.at >= event.at,
      );
      if (undo.mode === 'performed')
        ensure(event.at === undo.at && same(event.actor, ack.actor));
      if (posting.receipt.kind === 'sale') {
        ensure(
          same(event.after, snapshot.receipt) &&
            snapshot.reversal === null &&
            same(
              {
                ...original,
                updatedAt: event.at,
                voidedAt: event.at,
                voidReason: 'undo',
              },
              snapshot.receipt,
            ),
        );
        ensure(
          same(
            tables.sales.find((row) => row.id === original.id),
            snapshot.receipt,
          ),
        );
        if (posting.target.kind === 'order') {
          const orderEvent = undoEvents[0],
            before = orderEvent.before as Order,
            after = orderEvent.after as Order;
          validateBackupRow('orders', before, 'payment order before undo');
          validateBackupRow('orders', after, 'payment order after undo');
          ensure(
            orderEvent.command === 'order.payment-undo' &&
              orderEvent.orderId === posting.target.id &&
              before.id === posting.target.id &&
              after.id === before.id &&
              before.payment.saleId === original.id &&
              after.payment.status === 'pending' &&
              !after.payment.saleId &&
              orderEvent.at === event.at &&
              same(orderEvent.actor, event.actor),
          );
          ensure(
            same(
              {
                ...before,
                revision: before.revision + 1,
                updatedAt: event.at,
                eventId: orderEvent.id,
                payment: after.payment,
              },
              after,
            ),
          );
        }
      } else {
        const reversed = snapshot.reversal as CreditEntry;
        validateBackupRow(
          'creditEntries',
          reversed,
          'payment collection reversal',
        );
        ensure(
          same(snapshot.receipt, original) &&
            same(event.after, reversed) &&
            reversed.reversalOf === original.id &&
            reversed.amount === original.amount &&
            reversed.type === 'adjustment' &&
            reversed.accountId === (original as CreditEntry).accountId &&
            same(
              tables.creditEntries.find((row) => row.id === reversed.id),
              reversed,
            ),
        );
      }
    }
  }
  reader.assertComplete();
}
