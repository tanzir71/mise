import {validateBackupRow} from './backup-schema';
import type {BackupTable} from './backup-tables';
import {decodeCommandRecord,decodeProposedCommandRecord,type CloudRecord} from './cloud-records';
import {canUndoClosing} from './closing';
import type {ClosingCommand} from './closing-commands';
import {reviewedClosingProposal} from './closing-review';
import {parseClosingReviewRequest,parseClosingReviewSource,type ClosingReviewRequest} from './closing-review-source';
import {replayClosingRecords} from './closing-replay';
import {closingPreview,type TodayContext} from './today';
import {syncDownloadToken} from './sync-download';
import type {NamedShopSetup} from './shop-access';
import type {Business,DayClosing,Outlet,Sale} from './models';

export const closingReviewContextLimit=16_000_000;
export const closingReviewResponseLimit=48_000_000;
export interface ClosingReviewCurrent {stateHash:string;contextJson:string;available:boolean}
export interface ClosingReviewContext {today:TodayContext<NamedShopSetup>;closing:DayClosing|null;sale:Sale|null}
export type ClosingReviewClosingProjection=Omit<DayClosing,'updatedAt'>;
export type ClosingReviewCashProjection=Omit<Sale,'updatedAt'>;
export type ClosingReviewProposal=
 |{enabled:false;reason:'unit'|'day'|'parent'|'closed'|'deadline'|'choice'|'unavailable'}
 |{enabled:true;reviewJson:string|null;closing:ClosingReviewClosingProjection;sale:ClosingReviewCashProjection|null};
export interface PreparedClosingReview {
 v:1;id:string;replacementId:string;commandId:string;commandHash:string;sourceHash:string;businessId:string;outletId:string;actorId:string;
 token:string;at:number;expiresAt:number;current:ClosingReviewCurrent;proposal:ClosingReviewProposal;
}
export type ClosingReviewMetadata=Omit<PreparedClosingReview,'current'|'proposal'>;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const tables={sales:'sales',orders:'orders',refunds:'orderRefunds',accounts:'creditAccounts',entries:'creditEntries',customers:'customers',stock:'stockItems',closings:'dayClosings'} as const satisfies Record<string,BackupTable>;
/** Admission can happen after the read. Its updatedAt is not a user choice;
 * original creation/count/undo times remain in the complete comparison. */
function withoutAdmissionStamp<T extends {updatedAt:number}>(row:T):Omit<T,'updatedAt'>{
 return Object.fromEntries(Object.entries(row).filter(([key])=>key!=='updatedAt')) as Omit<T,'updatedAt'>;
}
export function closingReviewProjection(records:readonly CloudRecord[],command:ClosingCommand):Extract<ClosingReviewProposal,{enabled:true}>{
 const closingRows=records.filter(row=>row.table==='day_closings'),saleRows=records.filter(row=>row.table==='sales'),events=records.filter(row=>row.table==='events');
 if(closingRows.length!==1||saleRows.length!==(command.saleId?1:0)||events.length!==(command.saleId?2:1)||records.length!==(command.saleId?4:2)||!events.some(e=>e.values.id===command.id)||command.saleEventId&&!events.some(e=>e.values.id===command.saleEventId))throw Error('Keep the complete reviewed closing result.');
 const closing=decodeProposedCommandRecord('dayClosings',closingRows[0]) as unknown as DayClosing,sale=saleRows.length?decodeProposedCommandRecord('sales',saleRows[0]) as unknown as Sale:null;
 validateBackupRow('dayClosings',closing,'Reviewed closing');if(sale)validateBackupRow('sales',sale,'Reviewed closing cash');
 if(closing.id!==command.closingId||closing.outletId!==command.outletId||sale&&(sale.id!==command.saleId||sale.closingId!==closing.id||sale.outletId!==closing.outletId))throw Error('Keep the reviewed closing and actual cash parent.');
 return {enabled:true,reviewJson:command.type==='closing.record'?command.input.fingerprint:null,closing:withoutAdmissionStamp(closing),sale:sale?withoutAdmissionStamp(sale):null};
}

/** This is the ordinary closing context, read through the same codecs and row
 * validation. SQL must independently scope business contacts to this outlet. */
export function readClosingReviewContext(contextJson:string,businessId:string,outletId:string,actorId:string,closingId:string):ClosingReviewContext{
 if(typeof contextJson!=='string'||new TextEncoder().encode(contextJson).length>closingReviewContextLimit)throw Error('Keep the complete bounded closing comparison.');
 const raw:unknown=JSON.parse(contextJson);
 if(!object(raw)||!exact(raw,'business,outlet,actorName,closing,sale,sales,orders,refunds,accounts,entries,customers,stock,closings')||!object(raw.business)||!object(raw.outlet)||typeof raw.actorName!=='string'||raw.actorName.length>1_000_000||!(raw.closing===null||object(raw.closing))||!(raw.sale===null||object(raw.sale)))throw Error('Keep the complete current closing context.');
 const decode=(table:BackupTable,value:Record<string,unknown>)=>{
  if(value.business_id!==businessId&&!(table==='businesses'&&value.business_id===undefined)||!['businesses','outlets','customers'].includes(table)&&value.outlet_id!==outletId)throw Error('Keep only the original scoped closing records.');
  const row=decodeCommandRecord(table,value);validateBackupRow(table,row,'Closing review '+table);return row;
 };
 const business=decode('businesses',raw.business) as unknown as Business,outlet=decode('outlets',raw.outlet) as unknown as Outlet;
 if(business.id!==businessId||outlet.id!==outletId||outlet.businessId!==businessId||!id(actorId))throw Error('Keep the original closing business, outlet and member.');
 const decoded:Record<string,unknown>={setup:{business,outlet,owner:{id:actorId,name:raw.actorName,businessId,active:true,outletIds:[outletId]}}};
 for(const [key,table] of Object.entries(tables)){
  const values=raw[key];if(!Array.isArray(values)||!values.every(object))throw Error('Keep all current closing records.');
  const rows=values.map(value=>decode(table,value));if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Keep distinct current closing records.');decoded[key]=rows;
 }
 const closing=raw.closing===null?null:decode('dayClosings',raw.closing) as unknown as DayClosing,sale=raw.sale===null?null:decode('sales',raw.sale) as unknown as Sale;
 if(closing&&closing.id!==closingId||sale&&(!closing||sale.id!==closing.addedSaleId||sale.closingId!==closing.id))throw Error('Keep the actual closing and linked cash receipt.');
 return {today:decoded as unknown as TodayContext<NamedShopSetup>,closing,sale};
}
export function closingReviewProposal(input:Pick<ClosingReviewRequest,'command'|'sourceJson'|'replacementId'>,metadata:Pick<ClosingReviewMetadata,'businessId'|'outletId'|'actorId'|'at'>,current:Pick<ClosingReviewCurrent,'contextJson'|'available'>,context:ClosingReviewContext):ClosingReviewProposal{
 const c=input.command,original=parseClosingReviewSource(input).events[0],saved=original.after;
 if(!current.available)return {enabled:false,reason:'unavailable'};
 if(c.occurredAt>metadata.at+300000)return {enabled:false,reason:'deadline'};
 let reviewJson:string|null=null;
 if(c.type==='closing.record'){
  if(context.today.setup.outlet.currency!==saved.currency)return {enabled:false,reason:'unit'};
  if(context.today.setup.outlet.timezone!==saved.timezone)return {enabled:false,reason:'day'};
  if(context.closing)return {enabled:false,reason:'parent'};
  if(context.today.closings.some(row=>row.day===saved.day&&row.currency===saved.currency&&row.voidedAt===undefined))return {enabled:false,reason:'closed'};
  try{reviewJson=closingPreview(context.today,c.occurredAt).fingerprint;}catch{return {enabled:false,reason:'unavailable'};}
 }else{
  const before=original.before,closing=context.closing,sale=context.sale,oldSale=parseClosingReviewSource(input).events[1]?.before;
  if(!before||!closing)return {enabled:false,reason:'parent'};
  if(closing.voidedAt!==undefined)return {enabled:false,reason:'closed'};
  // Server admission may stamp updatedAt and observe the member's current
  // display name. It cannot replace the original physical/financial parent.
  const closingParent=(row:DayClosing)=>({...row,updatedAt:0,createdByName:''});
  const cashParent=(row:Sale)=>({...row,updatedAt:0,shopLink:undefined});
  if(!same(closingParent(closing),closingParent(before))||(c.saleId!==null)!==(sale!==null)||c.saleId!==null&&(!sale||!oldSale||!same(cashParent(sale),cashParent(oldSale))))return {enabled:false,reason:'parent'};
  if(!canUndoClosing(closing,metadata.at))return {enabled:false,reason:'deadline'};
 }
 let selected;
 try{selected=reviewedClosingProposal(c,input.replacementId,reviewJson);}catch{return {enabled:false,reason:'choice'};}
 try{
  return closingReviewProjection(replayClosingRecords({...metadata,contextJson:current.contextJson},selected),selected);
 }catch{return {enabled:false,reason:'unavailable'};}
}
/** Structural/current-state validation only. Callers separately verify exact
 * command/source/state hashes and account scope; a comparison grants no write. */
export function parsePreparedClosingReview(value:unknown,request:ClosingReviewRequest):PreparedClosingReview{
 const input=parseClosingReviewRequest(request,false),c=input.command,source=parseClosingReviewSource(input);
 if(!object(value)||!exact(value,'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal')||value.v!==1||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||!hash(value.commandHash)||value.sourceHash!==input.sourceHash||value.businessId!==source.businessId||value.outletId!==c.outletId||value.actorId!==source.events[0].actorId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>300000||!object(value.current)||!exact(value.current,'stateHash,contextJson,available')||!hash(value.current.stateHash)||typeof value.current.contextJson!=='string'||typeof value.current.available!=='boolean'||!object(value.proposal))throw Error('Review the original closing against current records again.');
 const current:ClosingReviewCurrent={stateHash:value.current.stateHash,contextJson:value.current.contextJson,available:value.current.available},metadata:ClosingReviewMetadata={v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:source.businessId,outletId:c.outletId,actorId:value.actorId as string,token:value.token,at:value.at,expiresAt:value.expiresAt};
 const context=readClosingReviewContext(current.contextJson,source.businessId,c.outletId,metadata.actorId,c.closingId),expected=closingReviewProposal(input,metadata,current,context);
 if(!same(value.proposal,expected))throw Error('Keep the complete checked closing, cash and actual undo deadline.');
 return {...metadata,current,proposal:expected};
}
export function prepareClosingReviewView(metadata:ClosingReviewMetadata,current:ClosingReviewCurrent,input:ClosingReviewRequest):PreparedClosingReview{
 const context=readClosingReviewContext(current.contextJson,metadata.businessId,metadata.outletId,metadata.actorId,input.command.closingId);
 return parsePreparedClosingReview({...metadata,current,proposal:closingReviewProposal(input,metadata,current,context)},input);
}
