import type { MiseDatabase } from './db';
import { recordPurchaseCommand, undoPurchaseCommand, type PurchaseInput } from '@mise/core/purchases';

export async function recordDatabasePurchase(db:MiseDatabase,input:PurchaseInput) {
  return db.transaction('rw',db.tables,async () => {
    const setup = await db.setup();if (!setup) throw new Error('Set up your shop first.');
    const [suppliers,stock] = await Promise.all([db.suppliers.where('outletId').equals(setup.outlet.id).toArray(),db.stockItems.where('outletId').equals(setup.outlet.id).toArray()]);
    const change = recordPurchaseCommand(input,setup,suppliers,stock);
    await db.purchases.add(change.purchase);await db.events.add(change.event);return change.purchase;
  });
}
export async function undoDatabasePurchase(db:MiseDatabase,id:string) {
  return db.transaction('rw',db.tables,async () => {
    const [setup,before] = await Promise.all([db.setup(),db.purchases.get(id)]);if (!setup || !before) throw new Error('Purchase not found.');
    const change = undoPurchaseCommand(before,setup);await db.purchases.put(change.purchase);await db.events.add(change.event);
  });
}
