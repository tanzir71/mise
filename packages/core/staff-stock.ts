import {isDeviceId,isDeviceToken,parseStaffDeviceAccess,type SharedDevice,type StaffDeviceSession,type StaffDeviceAccess} from './device-access';
import {stockAtoms} from './stock-quantity';

/** A quantity-only projection. Supplier contacts, purchases, prices, customer
 * data and the owner's portable database never enter a shared-screen reader. */
export interface StaffStockItem {
 id:string;outletId:string;revision:number;name:string;nameLocal:string;unit:string;category:string;aliases:string[];
 onHand:number;target:number;packSize:number;lowAt:number;lastCountedAt:number|null;eventId:string;createdAt:number;updatedAt:number;
}
export interface StaffStockRequest {operation:'read';sessionToken:string;after:string|null;limit:number}
export interface StaffStockPage {v:1;state:'stock';access:StaffDeviceAccess;outletName:string;serverAt:number;items:StaffStockItem[];next:string|null}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,fields:string)=>Object.keys(v).sort().join(',')===fields.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const size=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=100;
const bad=()=>Error('Check the current stock, outlet and your own PIN before continuing.');
export function parseStaffStockRequest(v:unknown):StaffStockRequest {
 if(!object(v)||!exact(v,'operation,sessionToken,after,limit')||v.operation!=='read'||!isDeviceToken(v.sessionToken)||v.after!==null&&!isDeviceId(v.after)||!size(v.limit))throw bad();
 return {operation:'read',sessionToken:v.sessionToken,after:v.after as string|null,limit:v.limit};
}
/** Runtime and cache parsing are structural only; a page never grants writing
 * authority. The SQL reader checks the actual current Team permission. */
export function parseStaffStockPage(v:unknown,after:string|null=null,limit=50,expected?:{device:SharedDevice;session:StaffDeviceSession}):StaffStockPage {
 if(after!==null&&!isDeviceId(after)||!size(limit)||!object(v)||!exact(v,'v,state,access,outletName,serverAt,items,next')||
  v.v!==1||v.state!=='stock'||!time(v.serverAt)||!Array.isArray(v.items)||v.items.length>limit||v.next!==null&&!isDeviceId(v.next))throw bad();
 const access=parseStaffDeviceAccess(v.access,expected),outletName=v.outletName;
 if(!access.permissions.includes('stock.read')||access.expiresAt<=v.serverAt||typeof outletName!=='string')throw bad();
 let previous=after??'';
 const items=v.items.map(row=>{
  if(!object(row)||!exact(row,'id,outletId,revision,name,nameLocal,unit,category,aliases,onHand,target,packSize,lowAt,lastCountedAt,eventId,createdAt,updatedAt')||
   !isDeviceId(row.id)||row.id<=previous||row.outletId!==access.outletId||typeof row.revision!=='number'||!Number.isSafeInteger(row.revision)||row.revision<1||
   !isDeviceId(row.eventId)||!time(row.createdAt)||!time(row.updatedAt)||row.updatedAt<row.createdAt||row.lastCountedAt!==null&&(!time(row.lastCountedAt)||row.lastCountedAt>row.updatedAt))throw bad();
  const {name,nameLocal,unit,category,aliases}=row;
  if(typeof name!=='string'||typeof nameLocal!=='string'||typeof unit!=='string'||typeof category!=='string'||!Array.isArray(aliases)||!aliases.every(a=>typeof a==='string'))throw bad();
  for(const key of ['onHand','target','packSize','lowAt'] as const){if(typeof row[key]!=='number')throw bad();stockAtoms(row[key]);}
  if((row.packSize as number)<=0)throw bad();previous=row.id;
  return {id:row.id,outletId:access.outletId,revision:row.revision,name,nameLocal,unit,category,aliases:[...aliases] as string[],
   onHand:row.onHand as number,target:row.target as number,packSize:row.packSize as number,lowAt:row.lowAt as number,
   lastCountedAt:row.lastCountedAt as number|null,eventId:row.eventId,createdAt:row.createdAt,updatedAt:row.updatedAt};
 });
 // A complete item is never cut to fit a byte budget. A nonempty short page
 // may continue at its actual last item; an empty continuation cannot advance.
 if(v.next!==null&&(!items.length||v.next!==previous))throw bad();
 return {v:1,state:'stock',access,outletName,serverAt:v.serverAt,items,next:v.next as string|null};
}
