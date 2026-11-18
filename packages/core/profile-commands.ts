import {normaliseSetupInput} from './setup';
import type {SetupInput,SetupCommand} from './models';
export interface ProfileCommand {id:string;type:'setup.update';businessId:string;outletId:string;ownerId:string;occurredAt:number;input:Required<SetupInput>}
export interface ProfileCommandReceipt {id:string;type:'setup.update';businessId:string;outletId:string;ownerId:string;occurredAt:number;at:number;businessUpdatedAt:number;outletUpdatedAt:number;ownerUpdatedAt:number}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export function parseProfileCommand(v:unknown):ProfileCommand {
 if(!object(v)||!exact(v,'id,type,businessId,outletId,ownerId,occurredAt,input')||v.type!=='setup.update'||![v.id,v.businessId,v.outletId,v.ownerId].every(id)||new Set([v.id,v.businessId,v.outletId,v.ownerId]).size!==4||!time(v.occurredAt)||!object(v.input)||!exact(v.input,'businessType,marketCode,name,phone,outletName,address,language,timezone,currency')||!Object.values(v.input).every(x=>typeof x==='string'))throw new Error('Keep the original profile action, shop identities and time.');
 const p=v.input as Required<SetupInput>;
 if(p.name.trim().length>80||p.outletName.trim().length>80||p.address.trim().length>250||p.phone.length>80||p.timezone.length>80||p.currency.length>3||!['en','bn','both'].includes(p.language))throw new Error('Keep profile fields within the shop settings limits.');
 return {id:v.id as string,type:'setup.update',businessId:v.businessId as string,outletId:v.outletId as string,ownerId:v.ownerId as string,occurredAt:v.occurredAt,input:normaliseSetupInput(p)};
}
export function profileIntent(change:SetupCommand):ProfileCommand {
 if(change.event.command!=='setup.update')throw new Error('Initial setup belongs to the reviewed shop upload.');
 const {business,outlet,owner}=change.snapshot;
 return parseProfileCommand({id:change.event.id,type:'setup.update',businessId:business.id,outletId:outlet.id,ownerId:owner.id,occurredAt:change.event.at,input:{businessType:business.businessType,marketCode:business.marketCode,name:business.name,phone:owner.phone??'',outletName:outlet.name,address:outlet.address,language:business.languages.length===2?'both':business.languages[0],timezone:outlet.timezone,currency:outlet.currency}});
}
export function profileWritePlan(command:ProfileCommand){const c=parseProfileCommand(command),p=c.input;return {input:{businessType:p.businessType,marketCode:p.marketCode,nameJson:JSON.stringify(p.name),phone:p.phone,outletNameJson:JSON.stringify(p.outletName),addressJson:JSON.stringify(p.address),language:p.language,timezone:p.timezone,currency:p.currency},intentJson:JSON.stringify(c)};}
export function parseProfileCommandReceipt(v:unknown,c:ProfileCommand):ProfileCommandReceipt {
 if(!object(v)||!exact(v,'id,type,businessId,outletId,ownerId,occurredAt,at,businessUpdatedAt,outletUpdatedAt,ownerUpdatedAt')||v.id!==c.id||v.type!==c.type||v.businessId!==c.businessId||v.outletId!==c.outletId||v.ownerId!==c.ownerId||v.occurredAt!==c.occurredAt||!time(v.at)||![v.businessUpdatedAt,v.outletUpdatedAt,v.ownerUpdatedAt].every(t=>time(t)&&t>=Math.max(v.at as number,c.occurredAt)))throw new Error('Invalid original profile action receipt.');
 return {id:c.id,type:c.type,businessId:c.businessId,outletId:c.outletId,ownerId:c.ownerId,occurredAt:c.occurredAt,at:v.at,businessUpdatedAt:v.businessUpdatedAt as number,outletUpdatedAt:v.outletUpdatedAt as number,ownerUpdatedAt:v.ownerUpdatedAt as number};
}
