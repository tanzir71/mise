import {replayMoneyRecords} from '../../../packages/core/money-replay.ts';
import type {MoneyCommand} from '../../../packages/core/money-commands.ts';
export {moneyFingerprint,MoneyMutationInvalid,MoneyMutationConflict} from '../../../packages/core/money-replay.ts';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
/** Keep original-JWT ticket admission separate from pure domain projection. */
export function moneyWriteFields(value:unknown,c:MoneyCommand,ticketId:string):Record<string,unknown>{
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid money context.');
 return {p_ticket_id:ticketId,p_token:value.token,p_occurred_at:c.occurredAt,p_records:replayMoneyRecords(value,c)};
}
