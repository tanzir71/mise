import { useLiveQuery } from 'dexie-react-hooks';
import { stockAtoms, stockNumber, parseStockQuantity, stockToOrder } from '@mise/core/stock-quantity';
import type { SetupSnapshot, StockItem } from '@mise/core/models';
import { db } from './data/db';

export function useStock(setup:SetupSnapshot) {
  return useLiveQuery(async () => {
    const [items,suppliers,moves,messages,members] = await Promise.all([db.stockItems.where('outletId').equals(setup.outlet.id).toArray(),db.suppliers.where('outletId').equals(setup.outlet.id).toArray(),db.stockMoves.where('outletId').equals(setup.outlet.id).toArray(),db.supplierMessages.where('outletId').equals(setup.outlet.id).toArray(),db.members.where('businessId').equals(setup.business.id).toArray()]);
    return {items:items.sort((a,b) => a.createdAt-b.createdAt || a.name.localeCompare(b.name)),suppliers,moves,messages,members};
  },[setup.outlet.id,setup.business.id]);
}
export type StockData = NonNullable<ReturnType<typeof useStock>>;
export function quantityInput(value:string):number {const quantity = parseStockQuantity(value);if (quantity === null) throw new Error('Enter a non-negative quantity with at most three decimals.');return quantity;}
export const stockDifference = (after:number,before:number) => stockNumber(stockAtoms(after)-stockAtoms(before),true);
export function suggestedQuantity(item:StockItem):number|null {try {return stockToOrder(item);}catch{return null;}}
