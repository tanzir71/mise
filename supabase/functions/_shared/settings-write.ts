import {decodeCommandRecord} from '../../../packages/core/cloud-records.ts';
import {parseSettingsCommand,type SettingsCommand} from '../../../packages/core/settings-commands.ts';
import {saveCreditMessagingCommand} from '../../../packages/core/khata-messages.ts';
import {exportPreparedCommand} from '../../../packages/core/export-audit.ts';
import type {Business,Outlet} from '../../../packages/core/models.ts';
import type {ShopSetup} from '../../../packages/core/shop-access.ts';
export class SettingsMutationInvalid extends Error {}
export class SettingsMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function settingsFingerprint(c:SettingsCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseSettingsCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
/** SQL commits only the bound normalized wording or export-audit metadata. */
export function settingsWriteFields(value:unknown,command:SettingsCommand,ticketId:string):Record<string,unknown>{
 const c=parseSettingsCommand(command);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!id(value.businessId)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid settings preparation.');
 const raw:unknown=JSON.parse(value.contextJson);if(!object(raw)||!object(raw.business)||!object(raw.outlet))throw new Error('Invalid settings source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet;
 if(business.id!==value.businessId||outlet.businessId!==business.id||outlet.id!==c.outletId)throw new Error('Invalid settings scope.');
 const setup:ShopSetup={business,outlet,owner:{id:value.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}};
 if(c.occurredAt>value.at+300000)throw new SettingsMutationConflict('Check the device clock and retain the original settings action.');
 try{
  const input=c.type==='khata.wording'?saveCreditMessagingCommand(c.input,setup,c.occurredAt,()=>c.id).outlet.creditMessaging:exportPreparedCommand({...c.input,outletId:outlet.id,actorId:value.actorId},setup,c.occurredAt,()=>c.id).after;
  return {p_ticket_id:ticketId,p_token:value.token,p_input_json:JSON.stringify(input)};
 }catch{throw new SettingsMutationInvalid('Review the reminder wording or original prepared-export details.');}
}
