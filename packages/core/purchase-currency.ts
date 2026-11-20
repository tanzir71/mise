import {isPurchaseCommand,type ShopCommand} from './shop-commands';
import type {PurchaseCommand} from './purchase-commands';
import type {LocalRowChange} from './local-outbox';
import {validSavedCurrency} from './order-currency';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);

/** A supplier profile has no monetary unit. An invoice keeps the unit of its
 * immutable original row, including an undo grouped with its actual creation. */
export function savedPurchaseCurrency(command:ShopCommand,changes:readonly LocalRowChange[],priorCommands:readonly ShopCommand[]=[]):string|undefined {
 if(!isPurchaseCommand(command)||!('purchaseId'in command))return undefined;
 const rows=changes.filter(row=>row.table==='purchases'&&row.key===command.purchaseId);
 if(rows.length!==1)throw Error('Keep the complete original invoice.');
 const {before,after}=rows[0];
 if(!object(after)||after.id!==command.purchaseId||after.outletId!==command.outletId||!validSavedCurrency(after.currency)||
  (command.type==='purchase.record'?before!==null:before===null
   ?!priorCommands.some(prior=>prior.type==='purchase.record'&&prior.purchaseId===command.purchaseId&&prior.outletId===command.outletId)
   :!object(before)||before.id!==command.purchaseId||before.outletId!==command.outletId||before.currency!==after.currency))
  throw Error('Keep the original invoice currency.');
 return after.currency;
}

/** Check each newly prepared proposal, after genuine completed-outcome lookup.
 * Historical undo retains its invoice unit rather than the current shop unit. */
export function proposedPurchaseCurrencyMatches(command:PurchaseCommand,records:unknown,currency:unknown):boolean {
 if(!('purchaseId'in command))return true;
 if(!validSavedCurrency(currency)||!Array.isArray(records)||!records.every((row):row is {table:string;values:Record<string,unknown>}=>object(row)&&typeof row.table==='string'&&object(row.values)))return false;
 const purchases=records.filter(row=>row.table==='purchases');
 return purchases.length===1&&purchases[0].values.id===command.purchaseId&&purchases[0].values.outlet_id===command.outletId&&purchases[0].values.currency===currency;
}
