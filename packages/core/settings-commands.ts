import {normaliseCreditMessaging} from './khata-messages';
import {exportAuditDetails,type ExportAuditDetails} from './export-audit';
import type {CreditMessaging} from './models';
export type SettingsCommand=
 |{id:string;type:'khata.wording';outletId:string;occurredAt:number;input:CreditMessaging}
 |{id:string;type:'export.prepare';outletId:string;occurredAt:number;input:ExportAuditDetails};
export interface SettingsCommandReceipt {id:string;type:SettingsCommand['type'];outletId:string;occurredAt:number;at:number;outletUpdatedAt:number|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export function isSettingsCommandType(v:unknown):v is SettingsCommand['type']{return v==='khata.wording'||v==='export.prepare';}
export function parseSettingsCommand(v:unknown):SettingsCommand {
 if(!object(v)||!exact(v,'id,type,outletId,occurredAt,input')||!id(v.id)||!id(v.outletId)||v.id===v.outletId||!time(v.occurredAt)||!object(v.input))throw new Error('Keep the original settings action, outlet and occurrence time.');
 const base={id:v.id,type:v.type,outletId:v.outletId,occurredAt:v.occurredAt},input=v.input,templates=input.templates;
 if(v.type==='khata.wording'&&exact(input,'paymentNote,templates')&&object(templates)&&exact(templates,'gentle,direct')&&['gentle','direct'].every(tone=>object(templates[tone])&&exact(templates[tone],'en,bn')))return {...base,type:v.type,input:normaliseCreditMessaging(input as unknown as CreditMessaging)};
 if(v.type==='export.prepare'&&exact(input,'format,datasets,rows,filename,capturedAt,from,to,includePhones')&&time(input.capturedAt))return {...base,type:v.type,input:exportAuditDetails(input as unknown as ExportAuditDetails,v.occurredAt)};
 throw new Error('Choose exact reminder wording or prepared-export metadata.');
}
export function settingsWritePlan(command:SettingsCommand){
 const c=parseSettingsCommand(command);
 const input=c.type==='khata.wording'?{paymentNoteJson:JSON.stringify(c.input.paymentNote),gentleEnJson:JSON.stringify(c.input.templates.gentle.en),gentleBnJson:JSON.stringify(c.input.templates.gentle.bn),directEnJson:JSON.stringify(c.input.templates.direct.en),directBnJson:JSON.stringify(c.input.templates.direct.bn)}:{format:c.input.format,datasets:c.input.datasets,rows:c.input.rows,filenameJson:JSON.stringify(c.input.filename),capturedAt:c.input.capturedAt,from:c.input.from,to:c.input.to,includePhones:c.input.includePhones};
 return {input,intentJson:JSON.stringify(c)};
}
export function parseSettingsCommandReceipt(v:unknown,c:SettingsCommand):SettingsCommandReceipt {
 if(!object(v)||!exact(v,'id,type,outletId,occurredAt,at,outletUpdatedAt')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!time(v.at)||(c.type==='khata.wording'?(!time(v.outletUpdatedAt)||v.outletUpdatedAt<Math.max(v.at,c.occurredAt)):v.outletUpdatedAt!==null))throw new Error('Invalid original settings action receipt.');
 return {id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:v.at,outletUpdatedAt:v.outletUpdatedAt as number|null};
}
