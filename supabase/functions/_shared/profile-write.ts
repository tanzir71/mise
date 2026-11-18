import {decodeCommandRecord} from '../../../packages/core/cloud-records.ts';
import {parseProfileCommand,type ProfileCommand} from '../../../packages/core/profile-commands.ts';
import {setupCommand,normaliseSetupInput} from '../../../packages/core/setup.ts';
import type {Business,Outlet,Member} from '../../../packages/core/models.ts';
export class ProfileMutationInvalid extends Error {}
export class ProfileMutationConflict extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export async function profileFingerprint(c:ProfileCommand){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseProfileCommand(c))))),b=>b.toString(16).padStart(2,'0')).join('');}
/** A shop-contact edit never changes Auth identity, permissions or outlet assignments. */
export function profileWriteFields(value:unknown,command:ProfileCommand,ticketId:string):Record<string,unknown>{
 const c=parseProfileCommand(command);
 if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||value.businessId!==c.businessId||value.outletId!==c.outletId||value.actorId!==c.ownerId||!time(value.at)||typeof value.contextJson!=='string')throw new Error('Invalid owner profile preparation.');
 const raw:unknown=JSON.parse(value.contextJson);if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!object(raw.owner)||!Array.isArray(raw.outletIds)||!raw.outletIds.every(x=>typeof x==='string'))throw new Error('Invalid owner profile source.');
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,owner={...decodeCommandRecord('members',raw.owner),outletIds:raw.outletIds} as unknown as Member;
 if(business.id!==c.businessId||outlet.businessId!==business.id||outlet.id!==c.outletId||owner.businessId!==business.id||owner.id!==c.ownerId||owner.role!=='owner'||!owner.active)throw new Error('Invalid owner profile scope.');
 if(c.occurredAt>value.at+300000)throw new ProfileMutationConflict('Check the device clock and retain the original profile action.');
 try{const change=setupCommand(c.input,{business,outlet,owner},c.occurredAt,()=>c.id);if(change.items.length||change.categories.length||change.event.command!=='setup.update')throw new Error('Unexpected setup replacement.');return {p_ticket_id:ticketId,p_token:value.token,p_input_json:JSON.stringify(normaliseSetupInput(c.input))};}
 catch{throw new ProfileMutationInvalid('Review the original business, contact and market settings.');}
}
