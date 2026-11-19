import {replayHandoffRecords} from '../../../packages/core/handoff-replay.ts';
import {parseHandoffCommand,type HandoffCommand} from '../../../packages/core/handoff-commands.ts';
export {handoffFingerprint,HandoffMutationInvalid,HandoffMutationConflict} from '../../../packages/core/handoff-replay.ts';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
/** Keep original-JWT ticket admission separate from tentative domain projection. */
export function handoffWriteFields(value:unknown,c:HandoffCommand,ticketId:string):Record<string,unknown>{
 c=parseHandoffCommand(c);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid message preparation.');
 return {p_ticket_id:ticketId,p_token:value.token,p_records:replayHandoffRecords(value,c)};
}
