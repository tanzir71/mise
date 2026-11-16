import { handoffEventSession,handoffSourceTables,validateHandoffHistory } from './handoff';
import { stockAtoms, stockNameKey } from './stock-quantity';
import { creditBalance, entryDelta } from './khata';
import { orderLineTotal } from './order-lines';
import { backupTableNames, type BackupTables, type BackupTable } from './backup-tables';

/** Check live references; historical catalogue snapshots may refer to deleted items. */
export function validateBackupLinks(t:BackupTables):void {
  function ensure(ok:unknown,message:string):asserts ok {if (!ok) throw new Error(`Invalid backup: ${message}.`);}
  const maps = Object.fromEntries(backupTableNames.map(name => [name,new Map(t[name].map(row => [row.id,row]))])) as {[K in BackupTable]:Map<string,BackupTables[K][number]>};
  const ledgerGroups = new Map<string,BackupTables['creditEntries']>();
  for (const entry of t.creditEntries) {const entries = ledgerGroups.get(entry.accountId) || [];entries.push(entry);ledgerGroups.set(entry.accountId,entries);}
  const link = <K extends BackupTable>(table:K,id:string) => {const row = maps[table].get(id);ensure(row,`${table} is missing record ${id}`);return row;};
  const unique = (keys:(string|undefined)[],label:string) => {const present = keys.filter(key => key !== undefined);ensure(new Set(present).size === present.length,`${label} contains duplicate keys`);};
  const pair = (...parts:unknown[]) => JSON.stringify(parts);
  const count = backupTableNames.reduce((sum,name) => sum+t[name].length,0);
  if (!count) return;
  ensure(t.businesses.length === 1 && t.outlets.length === 1,'this local version requires one business and one outlet');
  const business = t.businesses[0], outlet = t.outlets[0];
  ensure(outlet.businessId === business.id,'the outlet belongs to another business');
  ensure(t.members.some(m => m.active && m.businessId === business.id && m.outletIds.includes(outlet.id)),'the shop has no active owner');
  for (const member of t.members) {ensure(member.businessId === business.id,'a member belongs to another business');for (const id of member.outletIds) ensure(link('outlets',id).businessId === member.businessId,'a member has a foreign outlet');}
  for (const table of backupTableNames) for (const row of t[table]) if ('outletId' in row) ensure(row.outletId === outlet.id,`${table} contains a foreign outlet`);
  for (const customer of t.customers) ensure(customer.businessId === business.id,'a customer belongs to another business');
  unique(t.customers.map(c => c.phone && pair(c.businessId,c.phone)),'customer phones');
  unique(t.creditAccounts.map(a => pair(a.outletId,a.customerId,a.currency)),'credit accounts');
  unique(t.creditEntries.map(e => pair(e.accountId,e.sequence)),'credit sequences');unique(t.creditEntries.map(e => e.reversalOf),'credit reversals');
  unique(t.orders.map(o => pair(o.outletId,o.sequence)),'order sequences');unique(t.orders.map(o => pair(o.outletId,o.number)),'order numbers');
  for (const table of ['orderNotes','orderCommunications'] as const) unique(t[table].map(r => pair(r.orderId,r.revision)),`${table} revisions`);
  unique(t.stockItems.map(i => i.activeKey === undefined ? undefined : pair(i.outletId,i.activeKey)),'active stock names');
  unique(t.stockMoves.map(m => pair(m.stockItemId,m.revision)),'stock revisions');unique(t.stockMoves.map(m => m.undoOf),'stock reversals');
  unique(t.dayClosings.map(c => c.activeKey === undefined ? undefined : pair(c.outletId,c.activeKey)),'active day closings');
  for (const item of t.items) ensure(link('categories',item.categoryId).outletId === item.outletId,'a catalogue category belongs to another outlet');
  validateHandoffHistory(t.events);
  for(const event of t.events)if(event.command==='handoff.prepare'){
    const state=handoffEventSession(event),source=link(handoffSourceTables[state.draft.source.kind],state.draft.source.id);
    ensure(state.draft.source.kind==='shop'?source.id===outlet.id:'outletId' in source?source.outletId===outlet.id:'businessId' in source&&source.businessId===business.id,'a message source belongs to another shop');
  }
  for (const event of t.events) {
    if (event.actor.type === 'member') link('members',event.actor.id);
    if (event.undoOf) link('events',event.undoOf);
    if (event.customerId) link('customers',event.customerId);
    if (event.orderId) link('orders',event.orderId);
    if (event.stockItemId) link('stockItems',event.stockItemId);
    if (event.supplierId) link('suppliers',event.supplierId);
    if (event.closingId) link('dayClosings',event.closingId);
  }
  for (const table of backupTableNames) for (const row of t[table]) {
    if ('createdBy' in row) link('members',row.createdBy);
    if ('eventId' in row) link('events',row.eventId);
  }
  for (const account of t.creditAccounts) {link('customers',account.customerId);ensure(account.reminder.dayOfMonth <= 31,'a credit reminder day exceeds 31');creditBalance(account,ledgerGroups.get(account.id) || []);}
  for (const entry of t.creditEntries) {
    const account = link('creditAccounts',entry.accountId);
    ensure(entry.customerId === account.customerId && entry.currency === account.currency,'a credit entry differs from its account');
    if (entry.saleId) {const sale = link('sales',entry.saleId);ensure(sale.customerId === entry.customerId && sale.creditAccountId === entry.accountId && sale.currency === entry.currency,'a credit sale differs from its ledger');}
    if (entry.orderId) ensure(link('orders',entry.orderId).currency === entry.currency,'a credit entry differs from its order currency');
    if (entry.refundId) {const refund = link('orderRefunds',entry.refundId);ensure(refund.orderId === entry.orderId && refund.accountId === entry.accountId,'a refund ledger link is inconsistent');}
    if (entry.returnsChargeId) ensure(link('creditEntries',entry.returnsChargeId).accountId === entry.accountId,'a returned charge belongs to another account');
    if (entry.reversalOf) {const before = link('creditEntries',entry.reversalOf);ensure(before.accountId === entry.accountId && !before.reversalOf && entry.type === 'adjustment' && entryDelta(entry) === -entryDelta(before),'a credit reversal is inconsistent');}
  }
  for (const sale of t.sales) {
    if (sale.customerId) link('customers',sale.customerId);
    if (sale.creditAccountId) {const account = link('creditAccounts',sale.creditAccountId);ensure(account.customerId === sale.customerId && account.currency === sale.currency,'a sale differs from its credit account');}
    ensure(sale.method !== 'credit' || !!sale.creditAccountId,'a credit sale has no account');
    if (sale.orderId) ensure(link('orders',sale.orderId).currency === sale.currency,'a sale differs from its order currency');
    if (sale.closingId) ensure(link('dayClosings',sale.closingId).addedSaleId === sale.id,'a closing sale has no matching closing');
    if (sale.given !== undefined) ensure(sale.change === sale.given-sale.amount && sale.given >= sale.amount,'cash given and change are inconsistent');
  }
  for (const order of t.orders) {
    if (order.customer.id) link('customers',order.customer.id);link('events',order.statusEventId);
    if (order.payment.saleId) {const sale = link('sales',order.payment.saleId);ensure(sale.orderId === order.id && sale.currency === order.currency,'an order payment has a different sale');}
    if (order.payment.cancellation?.creditEntryId) ensure(link('creditEntries',order.payment.cancellation.creditEntryId).orderId === order.id,'an order cancellation has a different entry');
  }
  for (const row of [...t.orderNotes,...t.orderCommunications]) link('orders',row.orderId);
  for (const refund of t.orderRefunds) {
    const sale = link('sales',refund.saleId), order = link('orders',refund.orderId);
    ensure(sale.orderId === order.id && sale.currency === refund.currency && order.currency === refund.currency,'a refund differs from its sale');
    if (refund.customerId) link('customers',refund.customerId);
    if (refund.accountId) ensure(link('creditAccounts',refund.accountId).customerId === refund.customerId,'a refund differs from its customer');
    if (refund.creditEntryId) ensure(link('creditEntries',refund.creditEntryId).refundId === refund.id,'a refund has an inconsistent ledger entry');
  }
  for (const item of t.stockItems) {
    if (item.supplierId) link('suppliers',item.supplierId);
    ensure(item.packSize > 0 && item.lowAt <= item.target,'a stock threshold or pack size is invalid');
    ensure(item.archivedAt !== undefined ? item.activeKey === undefined : item.activeKey === stockNameKey(item.name),'a stock active name is inconsistent');
  }
  for (const move of t.stockMoves) {
    const item = link('stockItems',move.stockItemId);ensure(item.unit === move.unit && stockAtoms(move.after)-stockAtoms(move.before) === stockAtoms(move.delta,true),'a stock movement is inconsistent');
    if (move.undoOf) {const before = link('stockMoves',move.undoOf);ensure(before.stockItemId === move.stockItemId && move.delta === -before.delta && !before.undoOf,'a stock reversal is inconsistent');}
  }
  for (const message of t.supplierMessages) {if (message.supplierId) link('suppliers',message.supplierId);for (const id of message.stockItemIds) link('stockItems',id);ensure(message.part <= message.parts,'a supplier message has an invalid part number');}
  for (const purchase of t.purchases) {
    if (purchase.supplierId) link('suppliers',purchase.supplierId);
    ensure(purchase.lines.length > 0 && purchase.lines.length <= 200,'a purchase needs priced invoice lines');
    let total = 0n;for (const line of purchase.lines) {ensure(line.lineTotal === orderLineTotal(line.unitPrice,line.qty),'a purchase line total is inconsistent');total += BigInt(line.lineTotal);if (line.stockItemId) ensure(link('stockItems',line.stockItemId).unit === line.unit,'a purchase line uses a different stock unit');}
    ensure(total === BigInt(purchase.total),'a purchase total differs from its invoice lines');
  }
  for (const closing of t.dayClosings) {
    ensure(closing.summary.day === closing.day && closing.summary.currency === closing.currency && closing.summary.timezone === closing.timezone,'a closing snapshot has different day or currency settings');
    ensure(closing.difference === closing.countedCash-closing.expectedCash && (closing.addedWalkIn === 0 || closing.addedWalkIn === closing.difference),'a closing variance is inconsistent');
    ensure(closing.voidedAt !== undefined ? closing.activeKey === undefined : closing.activeKey === `${closing.currency}:${closing.day}`,'a closing active day is inconsistent');
    if (closing.addedSaleId) {const sale = link('sales',closing.addedSaleId);ensure(sale.closingId === closing.id && sale.amount === closing.addedWalkIn && sale.currency === closing.currency,'a closing receipt is inconsistent');}
    else ensure(closing.addedWalkIn === 0,'a closing overage is missing its receipt');
  }
}
