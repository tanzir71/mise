import {parseStaffDeviceAccess,isDeviceId,isDeviceToken,type StaffDeviceAccess} from './device-access';
import {parseStaffStockPage,type StaffStockItem} from './staff-stock';
import {parseStockCommand,parseStockCommandReceipt,stockBatchBodyLimit,stockWritePlan,type StockCommand,type StockCommandReceipt} from './stock-commands';
import {stockAtoms,stockNumber} from './stock-quantity';

export type StaffStockCommand=Extract<StockCommand,{type:'stock.adjust'|'stock.batch'|'stock.undo'}>;
/** Captured before sending. This is the member's reported request and original
 * read, never a substitute for current server authorization or a receipt. */
export interface StaffStockIntent {
 v:1;origin:StaffDeviceAccess;screenRevision:string;readAt:number;outletName:string;
 command:StaffStockCommand;items:StaffStockItem[];undo:StaffStockReceipt|null;
}
export interface StaffStockReviewedLine {itemId:string;revision:number;before:number;after:number;lastCountedAt:number|null}
export interface StaffStockReview {
 v:1;id:string;intentHash:string;access:StaffDeviceAccess;at:number;expiresAt:number;
 items:StaffStockItem[];lines:StaffStockReviewedLine[];withdrawn:string[];
}
export interface StaffStockReceipt {
 v:1;type:'staff.stock';businessId:string;outletId:string;deviceId:string;sessionId:string;memberId:string;
 intentHash:string;reviewHash:string;reviewed:StaffStockReviewedLine[];command:StockCommandReceipt;
}
export interface OwnStaffStockOutcome {v:1;id:string;state:'pending'|'closed'|'applied';intentHash:string;receipt:StaffStockReceipt|null;at:number|null}
export interface StaffStockPrepared {state:'review';review:StaffStockReview;reviewHash:string;token:string}
export type StaffStockActionRequest={sessionToken:string;intent:StaffStockIntent}&(
 {operation:'prepare'|'inspect'|'close'}|{operation:'commit';ticketId:string;token:string;reviewHash:string});
export const staffStockIntentLimit=50*1024*1024;
export const staffStockActionBodyLimit=64*1024*1024;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<Number.MAX_SAFE_INTEGER;
const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
const bad=()=>Error('Keep the complete original stock request and review current quantities with your own PIN.');
export function parseStaffStockCommand(value:unknown):StaffStockCommand {
 const c=parseStockCommand(value);
 if(!['stock.adjust','stock.batch','stock.undo'].includes(c.type)||bytes(c)>stockBatchBodyLimit)throw bad();
 if(stockWritePlan(c).rows.some(r=>r.reason!=='count'&&r.reason!=='undo'&&r.quantity===0))throw bad();
 return c as StaffStockCommand;
}
function sameMember(a:StaffDeviceAccess,b:Pick<StaffDeviceAccess,'businessId'|'outletId'|'memberId'>){return a.businessId===b.businessId&&a.outletId===b.outletId&&a.memberId===b.memberId;}
export function staffStockCapability(command:StaffStockCommand):'stock.adjust'|'stock.undo'{return command.type==='stock.undo'?'stock.undo':'stock.adjust';}
/** Reuses the quantity-only read validator, retaining every selected label and
 * literal code unit. The command's row order remains the review order. */
function selectedItems(value:unknown,origin:StaffDeviceAccess,readAt:number,outletName:string,c:StaffStockCommand):StaffStockItem[]{
 const rows=stockWritePlan(c).rows;
 if(!Array.isArray(value)||value.length!==rows.length||!value.every(object))throw bad();
 const ordered=[...value].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0),checked=new Map<string,StaffStockItem>();
 for(let i=0;i<ordered.length;i+=100){
  const page=parseStaffStockPage({v:1,state:'stock',access:origin,outletName,serverAt:readAt,items:ordered.slice(i,i+100),next:null},i?String(ordered[i-1].id):null,100);
  for(const item of page.items){if(checked.has(item.id))throw bad();checked.set(item.id,item);}
 }
 return rows.map(row=>{const item=checked.get(row.itemId);if(!item||item.revision!==row.revision)throw bad();return item;});
}
export function parseStaffStockIntent(value:unknown):StaffStockIntent {
 if(!object(value)||!exact(value,'v,origin,screenRevision,readAt,outletName,command,items,undo')||value.v!==1||!isDeviceId(value.screenRevision)||!time(value.readAt)||typeof value.outletName!=='string'||bytes(value)>staffStockIntentLimit)throw bad();
 const origin=parseStaffDeviceAccess(value.origin),command=parseStaffStockCommand(value.command);
 if(command.outletId!==origin.outletId||!origin.permissions.includes(staffStockCapability(command))||command.occurredAt>=origin.expiresAt)throw bad();
 const items=selectedItems(value.items,origin,value.readAt,value.outletName,command);
 const undo=value.undo===null?null:parseStaffStockReceiptShape(value.undo);
 if(command.type==='stock.undo'){
  const line=undo?.command.results.find(r=>r.stockItemId===command.stockItemId&&r.moveId===command.undoMoveId);
  if(!undo||!sameMember(origin,undo)||undo.command.type==='stock.undo'||!line||command.occurredAt<undo.command.occurredAt)throw bad();
 }else if(undo!==null)throw bad();
 return {v:1,origin,screenRevision:value.screenRevision,readAt:value.readAt,outletName:value.outletName,command,items,undo};
}
export async function staffStockHash(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');}
export async function staffStockIntentHash(value:StaffStockIntent){return staffStockHash(parseStaffStockIntent(value));}
/** The fixed server handler derives these fields; the browser never supplies
 * a plan, actor selector or unit hash independently of its original request. */
export async function staffStockRpcFields(value:StaffStockIntent,intentHash:string){
 const intent=parseStaffStockIntent(value),c=intent.command,a=intent.origin;
 if(!hash(intentHash)||await staffStockIntentHash(intent)!==intentHash)throw bad();
 return {p_scope:{businessId:a.businessId,outletId:a.outletId,deviceId:a.deviceId,sessionId:a.sessionId,memberId:a.memberId},p_command_id:c.id,p_kind:c.type,p_plan:stockWritePlan(c),
  p_facts:await Promise.all(intent.items.map(async(item,index)=>({itemId:item.id,unitHash:await staffStockHash(item.unit),createdAt:item.createdAt,noteJson:JSON.stringify(c.type==='stock.adjust'?c.change.note.trim():c.type==='stock.batch'?c.changes[index].note.trim():'')}))),
  p_undo_receipt:intent.undo,p_occurred_at:c.occurredAt,p_original_json:JSON.stringify(intent),p_source_hash:intentHash};
}
export function parseStaffStockActionRequest(value:unknown):StaffStockActionRequest {
 if(!object(value)||!isDeviceToken(value.sessionToken)||!['prepare','inspect','close','commit'].includes(value.operation as string)||!exact(value,value.operation==='commit'?'operation,sessionToken,intent,ticketId,token,reviewHash':'operation,sessionToken,intent'))throw bad();
 const intent=parseStaffStockIntent(value.intent);
 if(value.operation==='commit'){
  if(!isDeviceId(value.ticketId)||!isDeviceToken(value.token)||!hash(value.reviewHash))throw bad();
  return {operation:'commit',sessionToken:value.sessionToken,intent,ticketId:value.ticketId,token:value.token,reviewHash:value.reviewHash};
 }
 return {operation:value.operation as 'prepare'|'inspect'|'close',sessionToken:value.sessionToken,intent};
}
function reviewedLine(value:unknown):StaffStockReviewedLine {
 if(!object(value)||!exact(value,'itemId,revision,before,after,lastCountedAt')||!isDeviceId(value.itemId)||!revision(value.revision)||typeof value.before!=='number'||typeof value.after!=='number'||value.lastCountedAt!==null&&!time(value.lastCountedAt))throw bad();
 stockAtoms(value.before);stockAtoms(value.after);
 return {itemId:value.itemId,revision:value.revision,before:value.before,after:value.after,lastCountedAt:value.lastCountedAt as number|null};
}
function receiptCommand(value:unknown,lines:StaffStockReviewedLine[]):StockCommandReceipt {
 if(!object(value)||!isDeviceId(value.id)||!isDeviceId(value.outletId)||!['stock.adjust','stock.batch','stock.undo'].includes(value.type as string)||!time(value.occurredAt)||!time(value.at)||
  !exact(value,'id,type,outletId,occurredAt,at,batchId,undoOf,results')||value.batchId!==null&&!isDeviceId(value.batchId)||value.undoOf!==null&&!isDeviceId(value.undoOf)||!Array.isArray(value.results)||value.results.length!==lines.length)throw bad();
 if(value.type!=='stock.batch'&&(lines.length!==1||value.batchId!==null)||(value.type==='stock.undo'?value.undoOf===null:value.undoOf!==null))throw bad();
 const at=value.at,occurredAt=value.occurredAt;
 const results=value.results.map((r,i)=>{
  const line=lines[i];if(!object(r)||!exact(r,'stockItemId,eventId,moveId,revision,onHand,updatedAt')||r.stockItemId!==line.itemId||!isDeviceId(r.eventId)||!isDeviceId(r.moveId)||r.revision!==line.revision+1||r.onHand!==line.after||!time(r.updatedAt)||r.updatedAt<at||r.updatedAt<occurredAt)throw bad();
  return {stockItemId:line.itemId,eventId:r.eventId,moveId:r.moveId,revision:line.revision+1,onHand:line.after,updatedAt:r.updatedAt};
 });
 const allocated=[...results.flatMap(r=>[r.eventId,r.moveId]),...(value.batchId?[value.batchId]:[])];
 if(results[0].eventId!==value.id||new Set(allocated).size!==allocated.length||allocated.some(id=>lines.some(r=>r.itemId===id)||id===value.undoOf))throw bad();
 return {id:value.id,type:value.type as StaffStockCommand['type'],outletId:value.outletId,occurredAt:value.occurredAt,at:value.at,batchId:value.batchId as string|null,undoOf:value.undoOf as string|null,results};
}
/** Shape checking is not receipt authentication. Native writers additionally
 * require the live server response proof and their exact original source. */
export function parseStaffStockReceiptShape(value:unknown):StaffStockReceipt {
 if(!object(value)||!exact(value,'v,type,businessId,outletId,deviceId,sessionId,memberId,intentHash,reviewHash,reviewed,command')||value.v!==1||value.type!=='staff.stock'||
  ![value.businessId,value.outletId,value.deviceId,value.sessionId,value.memberId].every(isDeviceId)||!hash(value.intentHash)||!hash(value.reviewHash)||!Array.isArray(value.reviewed)||value.reviewed.length<1||value.reviewed.length>1000)throw bad();
 const reviewed=value.reviewed.map(reviewedLine);if(new Set(reviewed.map(r=>r.itemId)).size!==reviewed.length)throw bad();
 const command=receiptCommand(value.command,reviewed);if(command.outletId!==value.outletId)throw bad();
 return {v:1,type:'staff.stock',businessId:value.businessId as string,outletId:value.outletId as string,deviceId:value.deviceId as string,sessionId:value.sessionId as string,memberId:value.memberId as string,intentHash:value.intentHash,reviewHash:value.reviewHash,reviewed,command};
}
export function staffStockAfter(intent:StaffStockIntent,index:number,before:number):number {
 const c=intent.command,row=stockWritePlan(c).rows[index];if(!row)throw bad();const initial=stockAtoms(before);let result:bigint;
 if(c.type==='stock.undo'){
  const original=intent.undo?.reviewed.find(r=>r.itemId===c.stockItemId);if(!original)throw bad();result=initial-(stockAtoms(original.after)-stockAtoms(original.before));
 }else result=row.reason==='count'?stockAtoms(row.quantity!):row.reason==='received'?initial+stockAtoms(row.quantity!):initial-stockAtoms(row.quantity!);
 return stockNumber(result);
}
/** Only the explicit current comparison changes predecessor revisions. The
 * original request, quantities, occurrence time and allocated IDs stay intact. */
export function reviewedStaffStockCommand(intent:StaffStockIntent,lines:readonly StaffStockReviewedLine[]):StaffStockCommand {
 const c=intent.command,rows=stockWritePlan(c).rows;
 if(lines.length!==rows.length||lines.some((r,i)=>r.itemId!==rows[i].itemId||!revision(r.revision)||r.after!==staffStockAfter(intent,i,r.before)))throw bad();
 return parseStaffStockCommand(c.type==='stock.batch'?{...c,changes:c.changes.map((r,i)=>({...r,revision:lines[i].revision}))}:c.type==='stock.adjust'?{...c,change:{...c.change,revision:lines[0].revision}}:{...c,revision:lines[0].revision});
}
export function parseStaffStockReview(value:unknown,original:StaffStockIntent,intentHash:string):StaffStockReview {
 const intent=parseStaffStockIntent(original),origin=intent.origin;
 if(!object(value)||!exact(value,'v,id,intentHash,access,at,expiresAt,items,lines,withdrawn')||value.v!==1||!isDeviceId(value.id)||value.intentHash!==intentHash||!hash(intentHash)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>60000||!Array.isArray(value.lines)||!Array.isArray(value.withdrawn)||bytes(value)>staffStockActionBodyLimit)throw bad();
 const access=parseStaffDeviceAccess(value.access);
 if(!sameMember(access,origin)||access.deviceId!==origin.deviceId||!access.permissions.includes(staffStockCapability(intent.command))||access.expiresAt<=value.at||value.expiresAt>access.expiresAt)throw bad();
 const lines=value.lines.map(reviewedLine),command=reviewedStaffStockCommand(intent,lines),items=selectedItems(value.items,access,value.at,intent.outletName,command);
 if(lines.some((line,i)=>line.before!==items[i].onHand||line.lastCountedAt!==items[i].lastCountedAt||items[i].unit!==intent.items[i].unit||items[i].createdAt!==intent.items[i].createdAt)||
  value.withdrawn.some(id=>!isDeviceId(id)||!lines.some(line=>line.itemId===id))||new Set(value.withdrawn).size!==value.withdrawn.length)throw bad();
 const created=new Set(stockWritePlan(command).rows.flatMap(r=>[r.eventId,r.moveId]));if(created.has(value.id))throw bad();
 return {v:1,id:value.id,intentHash,access,at:value.at,expiresAt:value.expiresAt,items,lines,withdrawn:value.withdrawn as string[]};
}
/** reviewHash is the backend's opaque digest of its exact native JSON review.
 * Tokens remain ephemeral; a durable comparison has no commit authority. */
export function parseStaffStockPrepared(value:unknown,intent:StaffStockIntent,intentHash:string):StaffStockPrepared {
 if(!object(value)||!exact(value,'state,review,reviewHash,token')||value.state!=='review'||!hash(value.reviewHash)||!isDeviceToken(value.token))throw bad();
 return {state:'review',review:parseStaffStockReview(value.review,intent,intentHash),reviewHash:value.reviewHash,token:value.token};
}
export function parseStaffStockReceipt(value:unknown,original:StaffStockIntent,intentHash:string,review?:{value:StaffStockReview;hash:string}):StaffStockReceipt {
 const intent=parseStaffStockIntent(original),receipt=parseStaffStockReceiptShape(value),origin=intent.origin;
 if(!sameMember(origin,receipt)||receipt.deviceId!==origin.deviceId||receipt.sessionId!==origin.sessionId||receipt.intentHash!==intentHash||!hash(intentHash))throw bad();
 const command=reviewedStaffStockCommand(intent,receipt.reviewed),parsed=parseStockCommandReceipt(receipt.command,command);
 if(parsed.results.some((r,i)=>r.revision!==receipt.reviewed[i].revision+1))throw bad();
 if(review){const compared=parseStaffStockReview(review.value,intent,intentHash);if(!hash(review.hash)||receipt.reviewHash!==review.hash||JSON.stringify(receipt.reviewed)!==JSON.stringify(compared.lines)||receipt.command.at!==compared.at)throw bad();}
 return receipt;
}
export function parseOwnStaffStockOutcome(value:unknown,intent:StaffStockIntent,intentHash:string):OwnStaffStockOutcome {
 const original=parseStaffStockIntent(intent);
 if(!hash(intentHash)||!object(value)||!exact(value,'v,id,state,intentHash,receipt,at')||value.v!==1||value.id!==original.command.id||!['pending','closed','applied'].includes(value.state as string)||value.intentHash!==intentHash||
  (value.state==='pending'?value.at!==null:!time(value.at)))throw bad();
 const receipt=value.receipt===null?null:parseStaffStockReceipt(value.receipt,original,intentHash);
 if((value.state==='applied')!==(receipt!==null)||receipt&&receipt.command.at!==(value.at as number))throw bad();
 return {v:1,id:original.command.id,state:value.state as OwnStaffStockOutcome['state'],intentHash,receipt,at:value.at as number|null};
}
