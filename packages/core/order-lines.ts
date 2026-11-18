import { ulid } from 'ulid';
import type { Item, OrderLine } from './models';

export interface OrderLineInput { id?:string; itemId?:string; name:string; unit:string; qty:number; unitPrice:number|null; note?:string; unavailable?:boolean; substitution?:{from:string;accepted:boolean} }
export function checkedOrderAmount(amount: bigint): number {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The order amount exceeds the supported range.');
  return Number(amount);
}
export function orderLineTotal(price: number, qty: number): number {
  if (!Number.isSafeInteger(price) || price < 0 || !Number.isFinite(qty) || qty <= 0 || qty > 999999 || !/^\d+(?:\.\d{1,3})?$/.test(String(qty))) throw new Error('Use a non-negative price and a quantity up to 999,999 with at most three decimal places.');
  const [whole,fraction = ''] = String(qty).split('.'), quantity = BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
  // Round each line to the nearest minor unit, with halves rounded up.
  return checkedOrderAmount((BigInt(price)*quantity+500n)/1000n);
}
export function prepareOrderLines(input: OrderLineInput[], items: Item[], outletId: string, before: OrderLine[] = [], at = Date.now(), newId:()=>string=()=>ulid(at)): OrderLine[] {
  if (!input.length || input.length > 200) throw new Error('Use between 1 and 200 order lines.');
  const ids = new Set<string>(), catalogue = new Map(items.filter(item => item.outletId === outletId).map(item => [item.id,item]));
  return input.map(value => {
    const old = value.id ? before.find(line => line.id === value.id) : undefined;
    if (value.id && (!old || ids.has(value.id))) throw new Error('Choose unique lines from this order.');
    const id = old?.id || newId();
    if(ids.has(id)||!old&&before.some(line=>line.id===id))throw new Error('Choose unique lines from this order.');
    ids.add(id);
    const item = value.itemId ? catalogue.get(value.itemId) : undefined, name = value.name.trim(), unit = value.unit.trim(), unavailable = Boolean(value.unavailable);
    if (value.unavailable !== undefined && typeof value.unavailable !== 'boolean') throw new Error('Mark availability explicitly.');
    const note = value.note?.trim() || ''; if (note.length > 500) throw new Error('Keep an item note within 500 characters.');
    if (!name || name.length > 120 || !unit || unit.length > 24 || /[\r\n]/.test(name+unit)) throw new Error('Enter an item name and unit on one line.');
    orderLineTotal(value.unitPrice ?? 0,value.qty);
    const from = value.substitution?.from.trim();
    if (value.substitution && (!from || from.length > 120 || /[\r\n]/.test(from))) throw new Error('Name the original item for a swap.');
    if (value.substitution && unavailable) throw new Error('Offer a swap as an available proposal, or mark the original item out of stock.');
    if (value.substitution && typeof value.substitution.accepted !== 'boolean') throw new Error('Confirm a swap explicitly.');
    const unchanged = old && old.itemId === value.itemId && old.name === name && old.unit === unit && old.qty === value.qty && old.unitPrice === value.unitPrice && (!old.unavailable || unavailable);
    if (value.itemId && !unchanged && (!item?.available || item.name !== name || item.unit !== unit || item.price !== value.unitPrice)) throw new Error('A catalogue item changed or is unavailable. Remove it and choose it again.');
    const substitution = from ? {from,accepted:Boolean(value.substitution?.accepted),acceptedAt:value.substitution?.accepted ? old?.substitution?.accepted && old.substitution.from === from && unchanged ? old.substitution.acceptedAt : at : undefined} : undefined;
    return {id,itemId:value.itemId || undefined,name,unit,qty:value.qty,unitPrice:value.unitPrice,lineTotal:value.unitPrice === null ? null : orderLineTotal(value.unitPrice,value.qty),note,unavailable,substitution};
  });
}
export function orderPricing(lines: OrderLine[], fee = 0, discount = 0): {subtotal:number;total:number|null;proposed:number;complete:boolean} {
  if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(discount) || discount < 0) throw new Error('Use non-negative delivery fees and discounts in minor units.');
  let subtotal = 0n, proposed = 0n, complete = true, available = 0;
  for (const line of lines) {
    if (line.unavailable) continue;
    if (line.unitPrice === null) { complete = false; continue; }
    const amount = BigInt(orderLineTotal(line.unitPrice,line.qty));
    if (line.substitution && !line.substitution.accepted) { proposed += amount; complete = false; }
    else { subtotal += amount; available++; }
  }
  if (BigInt(discount) > subtotal+BigInt(fee)) throw new Error('The discount cannot exceed the priced subtotal and delivery fee.');
  return {subtotal:checkedOrderAmount(subtotal),proposed:checkedOrderAmount(proposed),total:complete && available > 0 ? checkedOrderAmount(subtotal+BigInt(fee)-BigInt(discount)) : null,complete:complete && available > 0};
}
