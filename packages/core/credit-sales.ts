import { recordSaleCommand, undoSaleCommand, type SaleContext, type SaleInput } from './sales';
import { ulid } from 'ulid';
import { chargeCreditCommand, undoCreditEntryCommand, type CustomerLedgerContext, type OverLimitConfirmation } from './khata';
import type { CreditEntry, Sale } from './models';

export interface CreditSaleInput extends Pick<SaleInput,'expression'|'items'> { customerId: string; accountId: string; confirmation?: OverLimitConfirmation }
export function recordCreditSaleCommand(input: CreditSaleInput, ledger: CustomerLedgerContext, context: SaleContext, at = Date.now(), newId:(kind:'sale'|'entry'|'event'|'creditEvent')=>string=()=>ulid(at)) {
  if (input.customerId !== ledger.customer.id || input.accountId !== ledger.account.id || context.setup.outlet.id !== ledger.setup.outlet.id || context.setup.business.id !== ledger.setup.business.id || context.setup.outlet.currency !== ledger.setup.outlet.currency || context.setup.owner.id !== ledger.setup.owner.id) throw new Error('Choose the customer’s khata for this shop.');
  const result = recordSaleCommand({expression:input.expression,items:input.items,method:'cash',who:ledger.customer.nickname || ledger.customer.name},context,at,newId);
  const charge = chargeCreditCommand(result.sale.amount,ledger,{confirmation:input.confirmation,saleId:result.sale.id,note:input.expression},at,kind=>newId(kind==='event'?'creditEvent':'entry'));
  const sale: Sale = {...result.sale,method:'credit',methodName:context.setup.business.marketCode === 'BD' ? 'Baki' : 'Credit',given:undefined,change:undefined,customerId:ledger.customer.id,creditAccountId:ledger.account.id};
  return {sale,event:{...result.event,customerId:ledger.customer.id,after:sale},entry:charge.entry,creditEvent:charge.event};
}
export function undoCreditSaleCommand(sale: Sale, entry: CreditEntry, context: CustomerLedgerContext, at = Date.now(), newId:(kind:'entry'|'event'|'creditEvent')=>string=()=>ulid(at)) {
  const stored = context.entries.find(value => value.id === entry.id);
  if (!stored) throw new Error('Credit charge not found.');
  entry = stored;
  if (sale.method !== 'credit' || sale.creditAccountId !== context.account.id || sale.customerId !== context.customer.id || entry.saleId !== sale.id || entry.type !== 'charge') throw new Error('Credit sale and khata entry do not match.');
  const undo = undoSaleCommand(sale,context.setup.owner.id,at,()=>newId('event')), reverse = undoCreditEntryCommand(entry,context,at,true,kind=>newId(kind==='event'?'creditEvent':'entry'));
  return {sale:undo.sale,event:{...undo.event,customerId:context.customer.id},entry:reverse.entry,creditEvent:reverse.event};
}
