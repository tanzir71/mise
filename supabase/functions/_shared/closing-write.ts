import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from '../../../packages/core/cloud-records.ts';
import type {BackupTable} from '../../../packages/core/backup-tables.ts';
import {parseClosingCommand,type ClosingCommand} from '../../../packages/core/closing-commands.ts';
import {closeDayCommand,undoClosingCommand,type ClosingIds} from '../../../packages/core/closing.ts';
import {closingPreview,dayKey,type TodayContext} from '../../../packages/core/today.ts';
import type {NamedShopSetup} from '../../../packages/core/shop-access.ts';
import type {Business,DayClosing,Outlet,Sale} from '../../../packages/core/models.ts';
export class ClosingMutationInvalid extends Error {}
export class ClosingMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function closingFingerprint(c:ClosingCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseClosingCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
const tables={sales:'sales',orders:'orders',refunds:'orderRefunds',accounts:'creditAccounts',entries:'creditEntries',customers:'customers',stock:'stockItems',closings:'dayClosings'} as const satisfies Record<string,BackupTable>;
/** Recompute the complete reviewed Today state with the original confirmed caller. */
export function closingWriteFields(value:unknown,command:ClosingCommand,ticketId:string):Record<string,unknown>{
 const c=parseClosingCommand(command);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid closing preparation.');
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||typeof raw.actorName!=='string'||![raw.closing,raw.sale].every(r=>r===null||object(r)))throw new Error('Invalid closing source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id)throw new Error('Invalid closing scope.');
 const setup:NamedShopSetup={business,outlet,owner:{id:value.actorId,name:raw.actorName,businessId:business.id,active:true,outletIds:[outlet.id]}};
 const decoded:Record<string,unknown>={setup};
 for(const [key,table] of Object.entries(tables)){
  const rows=raw[key];if(!Array.isArray(rows)||!rows.every(r=>object(r)&&r.business_id===business.id&&(key==='customers'||r.outlet_id===outlet.id)))throw new Error('Invalid closing records.');
  decoded[key]=rows.map(r=>decodeCommandRecord(table,r));
 }
 const context=decoded as unknown as TodayContext<NamedShopSetup>;
 const before=raw.closing?decodeCommandRecord('dayClosings',raw.closing as Record<string,unknown>) as unknown as DayClosing:undefined,sale=raw.sale?decodeCommandRecord('sales',raw.sale as Record<string,unknown>) as unknown as Sale:undefined;
 if(before&&(before.id!==c.closingId||before.outletId!==outlet.id)||sale&&(!before||sale.id!==before.addedSaleId||sale.closingId!==before.id||sale.outletId!==outlet.id))throw new Error('Invalid original closing scope.');
 const ids:ClosingIds=kind=>{const v=kind==='event'?c.id:kind==='sale'?c.saleId:c.saleEventId;if(!v)throw new Error('Unplanned closing identity.');return v;};
 let change;
 try{
  if(c.occurredAt>value.at+300000)throw new ClosingMutationConflict('Check the device clock. Keep the original closing review.');
  if(c.type==='closing.record'){
   if(before)throw new ClosingMutationConflict('This closing identity already exists.');
   if(closingPreview(context,c.occurredAt).fingerprint!==c.input.fingerprint)throw new ClosingMutationConflict('Today changed. Review the latest totals and retain the original count.');
   change=closeDayCommand({...c.input,id:c.closingId},context,c.occurredAt,ids);
  }else{
   if(!before||(before.addedSaleId??null)!==c.saleId||c.occurredAt<before.createdAt||dayKey(c.occurredAt,before.timezone)!==before.day)throw new Error('Keep the original closing and receipt.');
   change=undoClosingCommand(before,setup,sale,value.at,ids);change.closing.voidedAt=c.occurredAt;if(change.sale)change.sale.voidedAt=c.occurredAt;
  }
 }catch(error){if(error instanceof ClosingMutationConflict)throw error;throw new ClosingMutationInvalid('Review the day totals, cash difference, original receipt and same-day undo.');}
 change.closing.updatedAt=Math.max(value.at,c.occurredAt,change.closing.createdAt);if(change.sale)change.sale.updatedAt=Math.max(value.at,c.occurredAt,change.sale.createdAt);
 for(const e of change.events)e.at=value.at;
 if(!change.events.some(e=>e.id===c.id)||change.events.some(e=>e.actor.id!==value.actorId||e.closingId!==c.closingId))throw new Error('Invalid closing audit identity.');
 const records:CloudRecord[]=[encodeCommandRecord('dayClosings',change.closing,business.id)];
 if(change.sale)records.push(encodeCommandRecord('sales',change.sale,business.id));
 records.push(...change.events.map(e=>encodeCommandRecord('events',e,business.id)));
 return {p_ticket_id:ticketId,p_token:value.token,p_records:records};
}
