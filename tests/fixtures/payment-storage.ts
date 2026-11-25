import type { MiseDatabase } from '../../apps/web/src/data/db';
import { newInboxId } from '../../packages/core/inbox';
import { defaultCreditTerms } from '../../packages/core/khata';
import type { CreditEntry, AuditEvent } from '../../packages/core/models';
/** Frozen new scale corpus: 5,000 immutable charges and one maximum imported note. */
export async function seedPaymentStorage(db: MiseDatabase) {
  const setup = await db.saveSetup({
      businessType: 'corner_shop',
      marketCode: 'BD',
      name: 'Ledger storage',
      phone: '01712345482',
    }),
    customer = await db.saveCustomer(
      {
        name: 'Customer',
        nickname: 'Apa',
        phone: '01712345482',
        address: '',
        notes: '',
        tags: [],
      },
      { credit: { ...defaultCreditTerms, allowed: true, limit: 10000000 } },
    ),
    account = (
      await db.creditAccounts.where('customerId').equals(customer.id).toArray()
    )[0],
    at = Date.now() - 10000;
  // A simulated valid imported history, independent of the new payment writers.
  // Every immutable charge has its complete original audit and source note.
  const note = 'Ledger original\0\ud800 '.repeat(60),
    entries: CreditEntry[] = [],
    events: AuditEvent[] = [];
  for (let i = 0; i < 5000; i++) {
    const entry: CreditEntry = {
      id: newInboxId(),
      outletId: setup.outlet.id,
      accountId: account.id,
      customerId: customer.id,
      currency: 'BDT',
      sequence: i + 1,
      type: 'charge',
      amount: 100,
      note,
      createdBy: setup.owner.id,
      eventId: newInboxId(),
      createdAt: at,
      updatedAt: at,
    };
    entries.push(entry);
    events.push({
      id: entry.eventId,
      outletId: entry.outletId,
      customerId: customer.id,
      actor: { type: 'member', id: setup.owner.id },
      command: 'khata.charge',
      before: null,
      after: entry,
      at,
    });
  }
  await db.transaction('rw', db.creditEntries, db.events, async () => {
    await db.creditEntries.bulkAdd(entries);
    await db.events.bulkAdd(events);
  });
  const imported = await db.readBackup(),
    largeNote = 'Original imported label\0\ud800 '
      .repeat(40000)
      .slice(0, 1000000);
  imported.tables.customers[0].notes = largeNote;
  // Existing ordinary backups deliberately support legacy imported literal notes.
  await db.restoreBackup(
    JSON.stringify(imported),
    await db.previewRestore(imported),
  );
  return { setup, customer, account, entries, largeNote };
}
