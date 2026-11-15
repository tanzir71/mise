import { ulid } from 'ulid';
import { closingPreview, dayKey, safeTotal, type TodayContext } from './today';
import { formatMoney, moneyInputValue } from './money';
import { recordSaleCommand } from './sales';
import { validateShop } from './shop-access';
import type { AuditEvent, DayClosing, Sale, SetupSnapshot } from './models';

export interface ClosingInput { id:string;day:string;fingerprint:string;countedCash:number;addDifference:boolean;note:string }
export interface ClosingChange { closing:DayClosing;sale?:Sale;events:AuditEvent[] }
export const newClosingId = (at = Date.now()) => ulid(at);
export function sameClosingRequest(input:ClosingInput, record:DayClosing):boolean {
  return input.id === record.id && input.day === record.day && input.fingerprint === record.previewFingerprint && input.countedCash === record.countedCash && input.addDifference === (record.addedWalkIn > 0) && input.note.trim() === record.note;
}
function event(setup:SetupSnapshot, closing:DayClosing, command:string, before:unknown, after:unknown, at:number):AuditEvent {
  return {id:ulid(at),outletId:closing.outletId,closingId:closing.id,actor:{type:'member',id:setup.owner.id},command,before,after,at};
}
export function closeDayCommand(input:ClosingInput, context:TodayContext, at = Date.now()):ClosingChange {
  const {setup} = context; validateShop(setup);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.id)) throw new Error('Reopen the closing review.');
  if (!Number.isSafeInteger(input.countedCash) || input.countedCash < 0) throw new Error('Enter a non-negative cash count in minor units.');
  if (typeof input.addDifference !== 'boolean') throw new Error('Choose whether to record the extra cash as sales.');
  const preview = closingPreview(context,at), {summary} = preview;
  if (input.day !== summary.day || input.fingerprint !== preview.fingerprint) throw new Error('Today changed. Review the latest totals before closing.');
  if (context.closings.some(record => record.outletId === setup.outlet.id && record.currency === summary.currency && record.day === summary.day && record.voidedAt === undefined)) throw new Error('This day is already closed. Undo the closing before counting again.');
  const difference = safeTotal([input.countedCash,-summary.expectedCash]), note = input.note.trim();
  if (note.length > 1000) throw new Error('Keep the closing note within 1,000 characters.');
  if (input.addDifference && difference <= 0) throw new Error('Only extra cash can be added as walk-in sales.');
  if (difference !== 0 && !input.addDifference && !note) throw new Error('Add a note explaining the cash difference.');
  const closing:DayClosing = {
    id:input.id,outletId:setup.outlet.id,activeKey:`${summary.currency}:${summary.day}`,day:summary.day,timezone:summary.timezone,currency:summary.currency,
    summary,countedCash:input.countedCash,expectedCash:summary.expectedCash,difference,addedWalkIn:input.addDifference ? difference : 0,note,
    previewFingerprint:preview.fingerprint,createdBy:setup.owner.id,createdByName:setup.owner.name,eventId:'',createdAt:at,updatedAt:at,
  };
  const events:AuditEvent[] = []; let sale:Sale|undefined;
  if (input.addDifference) {
    const change = recordSaleCommand({expression:moneyInputValue(difference,summary.currency).replace(',','.'),method:'cash',who:'Walk-in'}, {setup,items:[],wallets:[]},at);
    sale = {...change.sale,closingId:closing.id};closing.addedSaleId = sale.id;
    events.push({...change.event,closingId:closing.id,after:sale});
    // Keep the displayed snapshot consistent with the receipt written in the same transaction.
    closing.summary = {...summary,sales:safeTotal([summary.sales,difference]),saleCount:summary.saleCount+1,cashSales:safeTotal([summary.cashSales,difference]),expectedCash:input.countedCash,split:summary.split.map(row => row.method === 'cash' ? {...row,amount:safeTotal([row.amount,difference]),count:row.count+1} : row)};
  }
  const closingEvent = event(setup,closing,'closing.record',null,closing,at);closing.eventId = closingEvent.id;events.push(closingEvent);
  return {closing,sale,events};
}
export const canUndoClosing = (record:DayClosing, at = Date.now()) => record.voidedAt === undefined && at >= record.createdAt && dayKey(at,record.timezone) === record.day;
export function undoClosingCommand(before:DayClosing, setup:SetupSnapshot, sale:Sale|undefined, at = Date.now()):ClosingChange {
  validateShop(setup);
  if (before.outletId !== setup.outlet.id) throw new Error('Choose a closing from this shop.');
  if (!canUndoClosing(before,at)) throw new Error('A closing can be undone once, on the same shop day.');
  const closing = {...before,activeKey:undefined,voidedAt:at,updatedAt:at}, events:AuditEvent[] = [];
  let undoneSale:Sale|undefined;
  if (before.addedSaleId) {
    if (!sale || sale.id !== before.addedSaleId || sale.closingId !== before.id || sale.outletId !== before.outletId || sale.currency !== before.currency || sale.method !== 'cash' || sale.amount !== before.addedWalkIn || sale.voidedAt !== undefined || sale.orderId || sale.customerId) throw new Error('The closing’s walk-in receipt changed. Review its history.');
    undoneSale = {...sale,voidedAt:at,voidReason:'undo',updatedAt:at};
    const saleEvent = event(setup,closing,'sale.closing-undo',sale,undoneSale,at);saleEvent.undoOf = sale.eventId;events.push(saleEvent);
  }
  const closingEvent = event(setup,closing,'closing.undo',before,closing,at);closingEvent.undoOf = before.eventId;events.push(closingEvent);
  return {closing,sale:undoneSale,events};
}
export function daySummaryText(record:DayClosing):string {
  const summary = record.summary, money = (amount:number) => formatMoney(amount,record.currency);
  return [summary.shopName,summary.outletName !== summary.shopName ? summary.outletName : '',`Day summary · ${record.day} · ${record.timezone}`,record.voidedAt === undefined ? 'Closed' : 'Closing undone',
    `Sales: ${money(summary.sales)} · ${summary.saleCount} ${summary.saleCount === 1 ? 'sale' : 'sales'}`, `Orders: ${summary.orderCount}`,
    ...summary.split.map(row => `${row.method === 'wallet' ? 'Wallets' : row.method[0].toUpperCase()+row.method.slice(1)}: ${money(row.amount)}`),
    `Credit given: ${money(summary.creditGiven)}`,`Credit collected, net of khata refunds: ${money(summary.creditCollected)}`,
    `Cash receipts: ${money(summary.cashSales)}`,`Cash khata collections: ${money(summary.cashCollections)}`,`Cash refunds: ${money(summary.cashRefunds)}`,
    `Recorded cash before closing: ${money(record.expectedCash)}`,`Counted cash: ${money(record.countedCash)}`,`Difference: ${money(record.difference)}`,
    record.addedWalkIn > 0 ? `Added as walk-in sales: ${money(record.addedWalkIn)}` : '',record.note ? `Note: ${record.note}` : '',
    `Recorded by ${record.createdByName} · ${new Intl.DateTimeFormat('en-GB',{timeZone:record.timezone,dateStyle:'medium',timeStyle:'short'}).format(record.createdAt)}`,
    'Recorded cash is today’s net cash movement; opening float and unrecorded expenses are not included.',
  ].filter(Boolean).join('\n');
}
