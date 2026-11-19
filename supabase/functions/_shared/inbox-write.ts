import {replayInboxRecords} from '../../../packages/core/inbox-replay.ts';
import {parseInboxCommand,type InboxCommand} from '../../../packages/core/inbox-commands.ts';
export {inboxFingerprint,InboxMutationInvalid,InboxMutationConflict} from '../../../packages/core/inbox-replay.ts';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
/** Keep original-JWT ticket admission separate from tentative domain projection. */
export function inboxWriteFields(value:unknown,c:InboxCommand,ticketId:string):Record<string,unknown>{
 c=parseInboxCommand(c);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid Inbox preparation.');
 return {p_ticket_id:ticketId,p_token:value.token,p_records:replayInboxRecords(value,c)};
}
