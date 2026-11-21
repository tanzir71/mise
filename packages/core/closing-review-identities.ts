import {parseClosingCommand,type ClosingCommand} from './closing-commands';

/** Includes existing parents for collision checks, not as newly created rows. */
export function closingReviewReservedIds(original:ClosingCommand):ReadonlySet<string>{
 const c=parseClosingCommand(original);
 return new Set([c.id,c.outletId,c.closingId,...(c.saleId?[c.saleId,c.saleEventId!]:[])]);
}
