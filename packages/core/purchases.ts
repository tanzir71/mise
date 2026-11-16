import { ulid } from 'ulid';
import { validateShop } from './shop-access';
import { marketPacks } from './packs';
import { orderLineTotal } from './order-lines';
import type { AuditEvent, Purchase, PurchaseLine, SetupSnapshot, StockItem, Supplier } from './models';

export interface PurchaseInput {
  supplierId?:string;supplierName:string;reference:string;lines:Omit<PurchaseLine,'lineTotal'>[];
  paid:Purchase['paid'];wallet?:string;note:string;
}
/** Recording a priced invoice does not assert that its stock has been received. */
export function recordPurchaseCommand(input:PurchaseInput,setup:SetupSnapshot,suppliers:Supplier[],stock:StockItem[],at = Date.now()):{purchase:Purchase;event:AuditEvent} {
  validateShop(setup);
  const supplier = input.supplierId ? suppliers.find(s => s.id === input.supplierId && s.outletId === setup.outlet.id && s.archivedAt === undefined) : undefined;
  if (input.supplierId && !supplier) throw new Error('Choose an active supplier from this outlet.');
  const supplierName = supplier?.name || input.supplierName.trim(),reference = input.reference.trim(),note = input.note.trim();
  if (!supplierName || supplierName.length > 120 || reference.length > 120 || /[\r\n]/.test(supplierName+reference) || note.length > 4000) throw new Error('Enter a supplier and a short invoice reference or note.');
  if (!['cash','wallet','card','due'].includes(input.paid)) throw new Error('Choose how this invoice was paid, or mark it due.');
  if (input.paid === 'wallet' && (!input.wallet || input.wallet === 'Cash' || !marketPacks[setup.business.marketCode]['pay/wallets'].includes(input.wallet))) throw new Error('Choose a wallet available in this market.');
  if (!input.lines.length || input.lines.length > 200) throw new Error('Record between one and 200 priced invoice lines.');
  const lines = input.lines.map(line => {
    const name = line.name.trim(),unit = line.unit.trim();
    if (!name || name.length > 120 || !unit || unit.length > 24 || /[\r\n]/.test(name+unit)) throw new Error('Enter an invoice item name and unit on one line.');
    if (line.stockItemId && !stock.some(item => item.id === line.stockItemId && item.outletId === setup.outlet.id && item.unit === unit && item.archivedAt === undefined)) throw new Error('Choose active stock in the invoice line’s unit.');
    return {stockItemId:line.stockItemId || undefined,name,unit,qty:line.qty,unitPrice:line.unitPrice,lineTotal:orderLineTotal(line.unitPrice,line.qty)};
  });
  const sum = lines.reduce((value,line) => value+BigInt(line.lineTotal),0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The purchase total exceeds the supported amount.');
  const eventId = ulid(at),purchase:Purchase = {id:ulid(at),outletId:setup.outlet.id,supplierId:supplier?.id,supplierName,reference,lines,total:Number(sum),currency:setup.outlet.currency,timezone:setup.outlet.timezone,paid:input.paid,methodName:input.paid === 'wallet' ? input.wallet! : input.paid === 'due' ? 'Due' : input.paid === 'cash' ? 'Cash' : 'Card',note,createdBy:setup.owner.id,eventId,createdAt:at,updatedAt:at};
  return {purchase,event:{id:eventId,outletId:setup.outlet.id,supplierId:supplier?.id,actor:{type:'member',id:setup.owner.id},command:'purchase.record',before:null,after:purchase,at}};
}
export function undoPurchaseCommand(before:Purchase,setup:SetupSnapshot,at = Date.now()):{purchase:Purchase;event:AuditEvent} {
  validateShop(setup);
  if (before.outletId !== setup.outlet.id || before.voidedAt !== undefined || at < before.createdAt || at-before.createdAt > 600000) throw new Error('A purchase can be undone once within ten minutes in its original outlet.');
  const purchase = {...before,voidedAt:at,updatedAt:at};
  return {purchase,event:{id:ulid(at),outletId:before.outletId,supplierId:before.supplierId,actor:{type:'member',id:setup.owner.id},command:'purchase.undo',before,after:purchase,at,undoOf:before.eventId}};
}
