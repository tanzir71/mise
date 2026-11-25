import type {
  AuditEvent,
  Customer,
  Order,
  Outlet,
  Payment,
  Sale,
} from '@mise/core/models';
import type { PaymentEvidenceReader } from '@mise/core/payment-evidence';
import { validateBackupRow } from '@mise/core/backup-schema';

export type OriginalPaymentTarget =
  | { kind: 'order'; id: string; number: string; customerName: string }
  | {
      kind: 'credit';
      id: string;
      name: string;
      nickname: string;
      currency: string;
    }
  | { kind: 'counter'; who: string; shopName: string; outletName?: string };
export interface OriginalPaymentInspection {
  associations: {
    eventId: string;
    at: number;
    target: OriginalPaymentTarget;
    receipt: { kind: 'sale' | 'credit'; id: string } | null;
  }[];
  postings: { eventId: string; target: OriginalPaymentTarget }[];
}
function originalOrder(value: unknown): OriginalPaymentTarget {
  validateBackupRow('orders', value, 'payment original order details');
  const order = value as Order;
  return {
    kind: 'order',
    id: order.id,
    number: order.number,
    customerName: order.customer.name,
  };
}
function originalCustomer(
  value: unknown,
  account: unknown,
): OriginalPaymentTarget {
  validateBackupRow(
    'creditAccounts',
    account,
    'payment original account details',
  );
  validateBackupRow('customers', value, 'payment original customer details');
  const customer = value as Customer;
  return {
    kind: 'credit',
    id: customer.id,
    name: customer.name,
    nickname: customer.nickname,
    currency: (account as { currency: string }).currency,
  };
}
function originalSale(
  value: unknown,
): Extract<OriginalPaymentTarget, { kind: 'counter' }> {
  validateBackupRow('sales', value, 'payment original counter details');
  const sale = value as Sale;
  return { kind: 'counter', who: sale.who, shopName: sale.shopName };
}
/** Presentation only, after complete native history/financial validation. Never
 * look up current names: later edits cannot rewrite what was checked originally. */
export function inspectOriginalPaymentTargets(
  payment: Payment,
  history: readonly AuditEvent[],
  reader: PaymentEvidenceReader,
): OriginalPaymentInspection {
  const associations = new Map<
    string,
    OriginalPaymentInspection['associations'][number]
  >();
  for (const event of history) {
    const association = (event.after as Payment).association;
    if (!association || associations.has(association.eventId)) continue;
    const snapshot = reader.expand(association.fingerprint, association.at);
    const target =
      association.kind === 'order'
        ? originalOrder(snapshot.order)
        : association.kind === 'credit'
          ? originalCustomer(snapshot.customer, snapshot.account)
          : snapshot.order !== null
            ? originalOrder(snapshot.order)
            : originalSale(snapshot.sale);
    associations.set(association.eventId, {
      eventId: association.eventId,
      at: association.at,
      target,
      receipt:
        association.kind === 'order'
          ? null
          : { kind: association.kind, id: association.id },
    });
  }
  const postings = (payment.postings ?? []).map((posting) => {
    const snapshot = reader.expand(posting.target.fingerprint, posting.at);
    let target: OriginalPaymentTarget;
    if (posting.target.kind === 'order') target = originalOrder(snapshot.order);
    else if (posting.target.kind === 'credit')
      target = originalCustomer(snapshot.customer, snapshot.account);
    else {
      const receipt = reader.expand(posting.receipt.fingerprint, posting.at);
      validateBackupRow('outlets', snapshot.outlet, 'payment original outlet');
      // Financial validation checks scope, identity and who against the sale.
      target = {
        ...originalSale(receipt.sale),
        outletName: (snapshot.outlet as Outlet).name,
      };
    }
    return { eventId: posting.eventId, target };
  });
  return { associations: [...associations.values()], postings };
}
