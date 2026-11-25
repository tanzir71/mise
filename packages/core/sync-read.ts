import {cloudRecordMaps,decodeCommandRecord} from './cloud-records';
import type {BackupTable} from './backup-tables';
import {parseSyncSnapshot} from './sync-snapshot';
export const syncReadHeader='X-Mise-Sync-Outlet',syncReadBodyLimit=256000,syncPartBudget=196608,syncPageLimit=524288,syncWireLimit=786432;
export type SyncTable=typeof cloudRecordMaps[keyof typeof cloudRecordMaps]['table']|'member_outlets'|'customer_outlets'|'inbox_images'|'member_refs';
export const syncRecordColumns:Readonly<Record<SyncTable,readonly string[]>>=Object.freeze({
 ...Object.fromEntries(Object.entries(cloudRecordMaps).map(([key,map])=>[map.table,Object.freeze([...new Set([...Object.keys(map.fields),...(key==='businesses'?[]:['business_id'])])])])),
 member_refs:Object.freeze(['id','business_id','created_at','updated_at','name','role']),
 member_outlets:Object.freeze(['business_id','member_id','outlet_id']),customer_outlets:Object.freeze(['business_id','outlet_id','customer_id']),inbox_images:Object.freeze(['id','business_id','outlet_id','inbox_item_id','position','name','type','size','sha256','created_at','updated_at','uploaded_at'])
}) as Readonly<Record<SyncTable,readonly string[]>>;
export interface SyncScope {businessId:string;outletId:string;actorId:string;accountHash:string;role:'owner'|'manager';epoch:string;scopeVersion:string}
export interface SyncReadCursor extends SyncScope {v:1;snapshot:string}
export interface SyncReadWindow extends SyncScope {v:1;id:string;createdAt:number;expiresAt:number}
export interface SyncReadPart {changeId:string;table:SyncTable;id:string;operation:'upsert'|'delete';offset:number;totalBytes:number;sha256:string;data:string}
export interface SyncReadPage extends SyncScope {v:1;id:string;index:number;parts:SyncReadPart[];done:boolean;cursor:string|null}
export type SyncReadRequest={type:'begin';id:string;outletId:string;cursor:string|null}|{type:'page';id:string;outletId:string;index:number};
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const scopeKeys='businessId,outletId,actorId,accountHash,role,epoch,scopeVersion';
export function parseSyncScope(v:unknown):SyncScope {
 if(!object(v)||![v.businessId,v.outletId,v.actorId].every(id)||!hash(v.accountHash)||!uuid(v.epoch)||!uuid(v.scopeVersion)||!['owner','manager'].includes(v.role as string))throw new Error('Keep the original authenticated sync scope.');
 return {businessId:v.businessId as string,outletId:v.outletId as string,actorId:v.actorId as string,accountHash:v.accountHash,role:v.role as SyncScope['role'],epoch:v.epoch,scopeVersion:v.scopeVersion};
}
export function parseSyncCursor(v:unknown):SyncReadCursor {
 if(!object(v)||!exact(v,scopeKeys+',v,snapshot')||v.v!==1)throw new Error('Keep the complete accepted sync cursor.');
 return {...parseSyncScope(v),v:1,snapshot:parseSyncSnapshot(v.snapshot).text};
}
export function parseSyncReadRequest(v:unknown):SyncReadRequest {
 if(!object(v)||!id(v.id)||!id(v.outletId))throw new Error('Keep the sync review and outlet identities.');
 if(v.type==='begin'&&exact(v,'type,id,outletId,cursor')&&(v.cursor===null||typeof v.cursor==='string'&&v.cursor.length<=131072))return {type:v.type,id:v.id,outletId:v.outletId,cursor:v.cursor};
 if(v.type==='page'&&exact(v,'type,id,outletId,index')&&integer(v.index,0,1000000))return {type:v.type,id:v.id,outletId:v.outletId,index:v.index};
 throw new Error('Keep the original sync review and page position.');
}
export function parseSyncWindow(v:unknown,request:Extract<SyncReadRequest,{type:'begin'}>):SyncReadWindow {
 if(!object(v)||!exact(v,scopeKeys+',v,id,createdAt,expiresAt')||v.v!==1||v.id!==request.id||v.outletId!==request.outletId||!integer(v.createdAt,0,8640000000000000)||!integer(v.expiresAt,v.createdAt+1,8640000000000000))throw new Error('The sync review is unconfirmed.');
 return {...parseSyncScope(v),v:1,id:request.id,createdAt:v.createdAt,expiresAt:v.expiresAt};
}
export function decodeSyncBase64(v:unknown,maximum:number):Uint8Array {
 if(typeof v!=='string'||v.length>Math.ceil(maximum/3)*4||v.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v))throw new Error('Invalid sync fragment encoding.');
 let raw:string;try{raw=atob(v);}catch{throw new Error('Invalid sync fragment encoding.');}if(raw.length>maximum||btoa(raw)!==v)throw new Error('Keep the exact sync fragment bytes.');return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export function parseSyncPage(v:unknown,window:SyncReadWindow,index:number):SyncReadPage {
 if(!object(v)||!exact(v,scopeKeys+',v,id,index,parts,done,cursor')||v.v!==1||v.id!==window.id||v.index!==index||!Array.isArray(v.parts)||v.parts.length>256||typeof v.done!=='boolean'||(v.done?typeof v.cursor!=='string'||!v.cursor||v.cursor.length>131072:v.cursor!==null))throw new Error('The sync page is unconfirmed.');
 const scope=parseSyncScope(v);if(Object.keys(scope).some(k=>scope[k as keyof SyncScope]!==window[k as keyof SyncScope]))throw new Error('The original sync account or outlet changed.');
 let bytes=0;let previousPart:(SyncReadPart&{end:number})|undefined;const parts=v.parts.map((p):SyncReadPart=>{if(!object(p)||!exact(p,'changeId,table,id,operation,offset,totalBytes,sha256,data')||typeof p.changeId!=='string'||!/^[1-9][0-9]{0,18}$/.test(p.changeId)||BigInt(p.changeId)>9223372036854775807n||typeof p.table!=='string'||!Object.hasOwn(syncRecordColumns,p.table)||!id(p.id)||!['upsert','delete'].includes(p.operation as string)||!integer(p.offset,0,1073741824)||!integer(p.totalBytes,1,1073741824)||!hash(p.sha256))throw new Error('Keep every original sync fragment.');const raw=decodeSyncBase64(p.data,syncPartBudget);if(!raw.length||p.offset+raw.length>p.totalBytes)throw new Error('Keep the complete fragment position.');if(previousPart){if(p.changeId===previousPart.changeId){if(p.offset!==previousPart.end||previousPart.end>=previousPart.totalBytes||['table','id','operation','totalBytes','sha256'].some(k=>p[k]!==previousPart![k as keyof SyncReadPart]))throw new Error('Keep contiguous original record fragments.');}else if(BigInt(p.changeId)<=BigInt(previousPart.changeId)||p.offset!==0||previousPart.end!==previousPart.totalBytes)throw new Error('Keep sync records in their original page order.');}bytes+=raw.length;previousPart={changeId:p.changeId,table:p.table as SyncTable,id:p.id,operation:p.operation as 'upsert'|'delete',offset:p.offset,totalBytes:p.totalBytes,sha256:p.sha256,data:p.data as string,end:p.offset+raw.length};return {changeId:p.changeId,table:p.table as SyncTable,id:p.id,operation:p.operation as 'upsert'|'delete',offset:p.offset,totalBytes:p.totalBytes,sha256:p.sha256,data:p.data as string};});
 if(bytes>syncPartBudget||!v.done&&!parts.length)throw new Error('Keep a bounded, advancing sync page.');
 return {...scope,v:1,id:window.id,index,parts,done:v.done,cursor:v.cursor as string|null};
}
export async function syncHash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');}
/** References are validated after staging the whole window; integrity is checked before decoding. */
export async function decodeSyncRecord(part:SyncReadPart,bytes:Uint8Array,scope:SyncScope):Promise<Record<string,unknown>|null> {
 part={...part};scope=parseSyncScope(scope);bytes=new Uint8Array(bytes);if(bytes.length!==part.totalBytes||await syncHash(bytes)!==part.sha256)throw new Error('Keep the complete original sync record.');const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(part.operation==='delete'){if(v!==null)throw new Error('A tombstone cannot replace another record.');return null;}
 const columns=syncRecordColumns[part.table];if(!object(v)||Object.keys(v).sort().join(',')!==[...columns].sort().join(','))throw new Error('Unexpected fields in the sync projection.');
 if((part.table==='businesses'?v.id:v.business_id)!==scope.businessId||(part.table==='outlets'?v.id!==scope.outletId:Object.hasOwn(v,'outlet_id')&&v.outlet_id!==scope.outletId))throw new Error('The downloaded row belongs to another shop or outlet.');
 const key=part.table==='member_outlets'?'member_id':part.table==='customer_outlets'?'customer_id':'id';if(v[key]!==part.id)throw new Error('The downloaded row identity changed.');
 const local=Object.entries(cloudRecordMaps).find(([,m])=>m.table===part.table)?.[0] as BackupTable|undefined;return local?decodeCommandRecord(local,v):v;
}
