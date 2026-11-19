import {replayPurchaseRecords} from '../../../packages/core/purchase-replay.ts';
import {type PurchaseCommand} from '../../../packages/core/purchase-commands.ts';
export {purchaseFingerprint,PurchaseMutationInvalid,PurchaseMutationConflict} from '../../../packages/core/purchase-replay.ts';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
/** Keep original-JWT ticket admission separate from tentative domain projection. */
export function purchaseWriteFields(value:unknown,c:PurchaseCommand,ticketId:string):Record<string,unknown>{

 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid supplier/invoice context.');
 return {p_ticket_id:ticketId,p_token:value.token,p_records:replayPurchaseRecords(value,c)};
}
