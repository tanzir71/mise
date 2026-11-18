import type { MiseDatabase } from './db';
import { recordPurchaseCommand, undoPurchaseCommand, type PurchaseInput } from '@mise/core/purchases';
import {withOutboxIntent} from './outbox-capture';
import {purchaseIntent} from './outbox-intents';

export async function recordDatabasePurchase(db:MiseDatabase,input:PurchaseInput) {
  return db.transaction('rw',db.tables,async () => {
    const setup = await db.setup();if (!setup) throw new Error('Set up your shop first.');
    const [suppliers,stock] = await Promise.all([db.suppliers.where('outletId').equals(setup.outlet.id).toArray(),db.stockItems.where('outletId').equals(setup.outlet.id).toArray()]);
    const change = recordPurchaseCommand(input,setup,suppliers,stock);
    return withOutboxIntent(db,purchaseIntent(change.purchase,change.event),async()=>{await db.purchases.add(change.purchase);await db.events.add(change.event);return change.purchase;});
  });
}
export async function undoDatabasePurchase(db:MiseDatabase,id:string) {
  return db.transaction('rw',db.tables,async () => {
    const [setup,before] = await Promise.all([db.setup(),db.purchases.get(id)]);if (!setup || !before) throw new Error('Purchase not found.');
    const change = undoPurchaseCommand(before,setup);await withOutboxIntent(db,{id:change.event.id,type:'purchase.undo',outletId:before.outletId,purchaseId:id,occurredAt:change.event.at},async()=>{await db.purchases.put(change.purchase);await db.events.add(change.event);});
  });
}
