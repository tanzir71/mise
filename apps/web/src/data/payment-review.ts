import type { MiseDatabase } from './db';
import type { InboxDestination } from './inbox';
import { captureBindingToken } from './inbox';
import type { SetupSnapshot, Payment } from '@mise/core/models';
import { inboxSnapshot } from '@mise/core/inbox';
import { literalToken } from '@mise/core/literal-token';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import { isOrderFinished } from '@mise/core/orders';
import { creditBalance } from '@mise/core/khata';

/** Read-only mount identity. Every mutation still rereads its native proof. */
export async function readPaymentReviewFrame(
  db: MiseDatabase,
  expected: SetupSnapshot,
  itemId: string,
) {
  return db.transaction('r', db.tables, async () => {
    const [setup, item, selection, binding] = await Promise.all([
      db.setup(),
      db.inboxItems.get(itemId),
      db.operatorState.get('active'),
      db.cloudState.get('binding'),
    ]);
    if (
      !setup ||
      !item ||
      setup.business.id !== expected.business.id ||
      setup.outlet.id !== expected.outlet.id ||
      setup.owner.id !== expected.owner.id ||
      item.outletId !== setup.outlet.id
    )
      throw Error(
        'Open this original source in the selected outlet and operator.',
      );
    const destination: InboxDestination = {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
      selectionToken: literalToken(selection ?? null),
      bindingToken: captureBindingToken(binding),
    };
    const blocked =
      (!!binding && parseLocalCloudState(binding).phase !== 'cancelled') || (await db.nativePaymentState.count()) > 0;
    return {
      setup,
      item,
      destination,
      blocked,
      key: literalToken({ setup, destination, source: inboxSnapshot(item) }),
    };
  });
}
export async function readPaymentMoneyChoices(
  db: MiseDatabase,
  setup: SetupSnapshot,
  payment: Payment,
) {
  return db.transaction('r', db.tables, async () => {
    const [orders, accounts, customers, entries] = await Promise.all([
      db.orders.where('outletId').equals(setup.outlet.id).toArray(),
      db.creditAccounts.where('outletId').equals(setup.outlet.id).toArray(),
      db.customers.where('businessId').equals(setup.business.id).toArray(),
      db.creditEntries.where('outletId').equals(setup.outlet.id).toArray(),
    ]);
    const people = new Map(
      customers.filter((c) => c.archivedAt === undefined).map((c) => [c.id, c]),
    );
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const rows = grouped.get(entry.accountId);
      if (rows) rows.push(entry);
      else grouped.set(entry.accountId, [entry]);
    }
    return {
      orders: orders.filter(
        (o) =>
          o.payment.status === 'pending' &&
          !isOrderFinished(o) &&
          o.status !== 'returning' &&
          o.currency === payment.currency &&
          o.total === payment.amount,
      ),
      accounts: accounts
        .filter(
          (a) => a.currency === payment.currency && people.has(a.customerId),
        )
        .map((a) => ({
          id: a.id,
          label: people.get(a.customerId)!.name,
          balance: creditBalance(a, grouped.get(a.id) ?? []),
        }))
        .filter((a) => a.balance >= payment.amount),
    };
  });
}
