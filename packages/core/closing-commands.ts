import {closingSummaryWithOverage,type ClosingInput} from './closing';
import {dayKey,safeTotal} from './today';
import type {DaySummary} from './models';
export type ClosingCommand=
 |{id:string;type:'closing.record';outletId:string;closingId:string;occurredAt:number;saleId:string|null;saleEventId:string|null;input:Omit<ClosingInput,'id'>}
 |{id:string;type:'closing.undo';outletId:string;closingId:string;occurredAt:number;saleId:string|null;saleEventId:string|null};
export interface ClosingCommandReceipt {id:string;type:ClosingCommand['type'];outletId:string;closingId:string;occurredAt:number;at:number;day:string;difference:number;addedWalkIn:number;closingUpdatedAt:number;saleId:string|null;saleUpdatedAt:number|null;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
/** A review remains the complete canonical Today snapshot, including operational totals. */
export function parseClosingReview(value:unknown):DaySummary {
 if(typeof value!=='string'||value.length>16000)throw new Error('Keep the complete closing review.');
 const v:unknown=JSON.parse(value);
 if(!object(v)||!exact(v,'day,timezone,currency,shopName,outletName,sales,saleCount,orderCount,creditGiven,creditCollected,cashSales,cashCollections,cashRefunds,expectedCash,split,completedOrders,averageTimeMs,waitingOrders,lowStock,dueReminders')
  ||!['day','timezone','currency','shopName','outletName'].every(k=>typeof v[k]==='string')||!/^\d{4}-\d{2}-\d{2}$/.test(v.day as string)||!['sales','creditGiven','creditCollected','cashSales','cashCollections','cashRefunds','expectedCash'].every(k=>integer(v[k],-Number.MAX_SAFE_INTEGER))
  ||!['saleCount','orderCount','completedOrders','waitingOrders','lowStock','dueReminders'].every(k=>integer(v[k]))||!(v.averageTimeMs===null||integer(v.averageTimeMs))||!Array.isArray(v.split)||v.split.length!==4
  ||v.split.some((r,i)=>!object(r)||!exact(r,'method,amount,count')||r.method!==['cash','wallet','card','credit'][i]||!integer(r.amount)||!integer(r.count))||JSON.stringify(v)!==value)throw new Error('Review the complete current day totals.');
 return v as unknown as DaySummary;
}
export function isClosingCommandType(v:unknown):v is ClosingCommand['type'] {return v==='closing.record'||v==='closing.undo';}
export function parseClosingCommand(value:unknown):ClosingCommand {
 if(!object(value)||!id(value.id)||!id(value.outletId)||!id(value.closingId)||!integer(value.occurredAt,0,8640000000000000)||!(value.saleId===null||id(value.saleId))||!(value.saleEventId===null||id(value.saleEventId))||(value.saleId===null)!==(value.saleEventId===null))throw new Error('Keep the closing and related record identities.');
 const ids=[value.id,value.closingId,...(value.saleId?[value.saleId,value.saleEventId]:[])];if(new Set(ids).size!==ids.length)throw new Error('Use distinct closing, receipt and audit identities.');
 const b={id:value.id,outletId:value.outletId,closingId:value.closingId,occurredAt:value.occurredAt,saleId:value.saleId,saleEventId:value.saleEventId};
 if(value.type==='closing.undo'&&exact(value,'id,type,outletId,closingId,occurredAt,saleId,saleEventId'))return {...b,type:value.type};
 if(value.type!=='closing.record'||!exact(value,'id,type,outletId,closingId,occurredAt,saleId,saleEventId,input')||!object(value.input)||!exact(value.input,'day,fingerprint,countedCash,addDifference,note'))throw new Error('Choose a supported closing action and exact fields.');
 const p=value.input,s=parseClosingReview(p.fingerprint);
 if(p.day!==s.day||p.day!==dayKey(b.occurredAt,s.timezone)||!integer(p.countedCash)||typeof p.addDifference!=='boolean'||typeof p.note!=='string'||p.note.trim().length>1000||(p.addDifference!==(b.saleId!==null)))throw new Error('Check the reviewed count, day and walk-in choice.');
 const difference=safeTotal([p.countedCash,-s.expectedCash]);if(p.addDifference&&difference<=0||difference!==0&&!p.addDifference&&!p.note.trim())throw new Error('Explain the difference or explicitly record a positive surplus.');
 if(p.addDifference)closingSummaryWithOverage(s,difference);
 return {...b,type:'closing.record',input:{day:s.day,fingerprint:p.fingerprint as string,countedCash:p.countedCash,addDifference:p.addDifference,note:p.note}};
}
/** JSON-safe bindings; never extract fields from literal review/summary JSON in SQL. */
export function closingWritePlan(command:ClosingCommand){
 const c=parseClosingCommand(command),s=c.type==='closing.record'?parseClosingReview(c.input.fingerprint):null,difference=s&&c.type==='closing.record'?safeTotal([c.input.countedCash,-s.expectedCash]):0;
 return {closingId:c.closingId,saleId:c.saleId,saleEventId:c.saleEventId,day:s?.day??null,currency:s?.currency??null,timezone:s?.timezone??null,countedCash:c.type==='closing.record'?c.input.countedCash:null,expectedCash:s?.expectedCash??null,addDifference:c.type==='closing.record'?c.input.addDifference:null,reviewJson:c.type==='closing.record'?c.input.fingerprint:null,summaryJson:s?JSON.stringify(c.type==='closing.record'&&c.input.addDifference?closingSummaryWithOverage(s,difference):s):null,noteJson:c.type==='closing.record'?JSON.stringify(c.input.note.trim()):null,intentJson:JSON.stringify(c)};
}
export function parseClosingCommandReceipt(v:unknown,c:ClosingCommand):ClosingCommandReceipt {
 if(!object(v)||!exact(v,'id,type,outletId,closingId,occurredAt,at,day,difference,addedWalkIn,closingUpdatedAt,saleId,saleUpdatedAt,undoOf')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.closingId!==c.closingId||v.occurredAt!==c.occurredAt||!integer(v.at,0,8640000000000000)||!integer(v.closingUpdatedAt,Math.max(v.at,c.occurredAt),8640000000000000)||typeof v.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.day)||!integer(v.difference,-Number.MAX_SAFE_INTEGER)||!integer(v.addedWalkIn)||v.saleId!==c.saleId||(c.saleId===null?v.saleUpdatedAt!==null:!integer(v.saleUpdatedAt,Math.max(v.at,c.occurredAt),8640000000000000))||v.undoOf!==(c.type==='closing.undo'?c.closingId:null))throw new Error('Invalid closing receipt.');
 if((c.saleId===null)!==(v.addedWalkIn===0))throw new Error('The closing receipt is missing its linked surplus.');
 if(c.type==='closing.record'){const difference=safeTotal([c.input.countedCash,-parseClosingReview(c.input.fingerprint).expectedCash]);if(v.day!==c.input.day||v.difference!==difference||v.addedWalkIn!==(c.input.addDifference?difference:0))throw new Error('The receipt does not match the closing review.');}
 return {id:c.id,type:c.type,outletId:c.outletId,closingId:c.closingId,occurredAt:c.occurredAt,at:v.at,day:v.day,difference:v.difference,addedWalkIn:v.addedWalkIn,closingUpdatedAt:v.closingUpdatedAt,saleId:c.saleId,saleUpdatedAt:v.saleUpdatedAt as number|null,undoOf:v.undoOf as string|null};
}
