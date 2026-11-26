import { readPaymentOriginalBasis } from '@mise/core/payment-originals';
import { validatePaymentFinanceLinks } from '@mise/core/payment-finance-links';
import { validatePaymentHistory } from '@mise/core/payment-history';
import {
  paymentOriginal,
  paymentAssociationIsCurrent,
} from '@mise/core/payment-records';
import { literalToken } from '@mise/core/literal-token';
import type { Payment } from '@mise/core/models';
import type { MiseDatabase } from './db';
import type { StoredInboxItem } from './inbox';
import type { SavedPaymentReceipt } from './payment-capture';
import { readNativePaymentState } from './native-payment-state';
import { readDatabaseBackup } from './backup';
import { inspectOriginalPaymentTargets } from './payment-inspection';

/** Presentation of accepted originals. Current money remains in the ordinary
 * shop, and this return value cannot execute or acknowledge a command. */
export async function savedNativePaymentReceipt(
  db: MiseDatabase,
  item: StoredInboxItem,
  paymentId: string,
): Promise<SavedPaymentReceipt | null | undefined> {
  const saved = await readNativePaymentState(db);
  if (!saved) return undefined;
  if (await db.payments.count())
    throw Error(
      'Keep the separate local and accepted payment histories for review.',
    );
  const payment = saved.projection.payments.find((p) => p.id === paymentId);
  if (!payment) return null;
  if (
    payment.inboxId !== item.id ||
    literalToken(payment.original) !== literalToken(paymentOriginal(item))
  )
    throw Error('Keep the original accepted payment source.');
  const events = saved.projection.events
    .filter((e) => e.paymentId === payment.id)
    .sort((a, b) => a.paymentRevision! - b.paymentRevision!);
  validatePaymentHistory([payment], events, [item]);
  const action = saved.projection.actions.find(
      (a) => a.invocation.command.id === payment.eventId,
    ),
    basis =
      action &&
      saved.projection.originals.bases.find(
        (b) => b.root === action.source.ref.root,
      );
  if (!basis) throw Error('Keep the exact original accepted payment revision.');
  const nodes = new Map(
      saved.projection.originals.nodes.map((n) => [n.digest, n.json]),
    ),
    original = readPaymentOriginalBasis(basis, (key) => nodes.get(key)),
    reader = validatePaymentFinanceLinks(
      original.tables.payments,
      original.tables,
    ),
    current = await readDatabaseBackup(db),
    setup = await db.setup();
  if (
    !setup ||
    setup.business.id !== basis.scope.businessId ||
    setup.outlet.id !== basis.scope.outletId
  )
    throw Error('Open this original payment in its actual shop.');
  // Expand original evidence against its own immutable ledger. Eligibility and
  // candidate checks still use actual current records, including later reversals.
  const comparison = structuredClone(payment);
  if (comparison.association)
    comparison.association.fingerprint = literalToken(
      reader.expand(
        comparison.association.fingerprint,
        comparison.association.at,
      ),
    );
  for (const posting of comparison.postings ?? [])
    posting.receipt.fingerprint = literalToken(
      reader.expand(posting.receipt.fingerprint, posting.at),
    );
  const t = current.tables;
  return {
    payment,
    events,
    original: structuredClone(events[0].after as Payment),
    inspection: inspectOriginalPaymentTargets(payment, events, reader),
    associationCurrent: paymentAssociationIsCurrent(
      comparison,
      {
        setup,
        orders: t.orders,
        sales: t.sales,
        entries: t.creditEntries,
        accounts: t.creditAccounts,
        customers: t.customers,
        refunds: t.orderRefunds,
        events: t.events,
      },
      saved.projection.payments,
    ),
  };
}
