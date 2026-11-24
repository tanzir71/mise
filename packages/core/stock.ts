import { ulid } from 'ulid';
import { validateShop,type ShopSetup } from './shop-access';
import { normalisePhone } from './phone';
import { stockAtoms, stockNameKey, stockNumber, stockUnit } from './stock-quantity';
import type { AuditEvent, SetupSnapshot, StockItem, StockMove, StockReason, Supplier } from './models';

export type StockIds=(kind:'item'|'move'|'event'|'batch',itemId?:string)=>string;
export interface StockContext<S extends ShopSetup=SetupSnapshot> {setup:S;items:StockItem[];suppliers:Supplier[];moves:StockMove[]}
export type StockWriteContext=StockContext<ShopSetup>;
export interface StockInput {name:string;nameLocal?:string;unit:string;category?:string;aliases?:string[];onHand:number;target:number;packSize:number;lowAt?:number;supplierId?:string}
export interface StockChange {items:StockItem[];moves:StockMove[];events:AuditEvent[]}
export interface StockAdjustment {id:string;revision:number;reason:Exclude<StockReason,'undo'>;quantity:number;source?:StockMove['source'];note?:string}
function event(setup:ShopSetup,command:string,before:unknown,after:unknown,at:number,newId:()=>string=()=>ulid(at)):AuditEvent {return {id:newId(),outletId:setup.outlet.id,actor:{type:'member',id:setup.owner.id},command,before,after,at};}
function text(value:string,max:number,label:string):string {const clean = value.trim();if (clean.length > max || /[\r\n]/.test(clean)) throw new Error(`Keep ${label} on one line within ${max} characters.`);return clean;}
export function validateStockItem(item:StockItem,setup:ShopSetup,revision:number,active = true) {
  validateShop(setup);if (item.outletId !== setup.outlet.id) throw new Error('Choose a stock item from this outlet.');
  if (item.revision !== revision) throw new Error('This stock item changed. Review the latest amount before saving.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('The stock revision exceeds the supported range.');
  if (active && item.archivedAt !== undefined) throw new Error('Restore this stock item first.');
}
function uniqueName(name:string,context:StockWriteContext,id?:string) {if (context.items.some(item => item.id !== id && item.outletId === context.setup.outlet.id && item.archivedAt === undefined && stockNameKey(item.name) === stockNameKey(name))) throw new Error('An active stock item already has this name. Use a distinct name.');}
function stockEvent(item:StockItem,setup:ShopSetup,command:string,before:StockItem|null,at:number,newId:StockIds) {
  const audit = event(setup,command,before,item,at,()=>newId('event',item.id));audit.stockItemId = item.id;audit.stockRevision = item.revision;item.eventId = audit.id;return audit;
}
function move(item:StockItem,before:number,reason:StockReason,source:StockMove['source'],note:string,setup:ShopSetup,at:number,newId:StockIds,countBatchId?:string,undoOf?:string):StockMove {
  if (note.trim().length > 1000) throw new Error('Keep the stock note within 1,000 characters.');
  return {id:newId('move',item.id),outletId:item.outletId,stockItemId:item.id,revision:item.revision,name:item.name,unit:item.unit,before,after:item.onHand,delta:stockNumber(stockAtoms(item.onHand)-stockAtoms(before),true),reason,source,note:note.trim(),createdBy:setup.owner.id,eventId:item.eventId,countBatchId,undoOf,createdAt:at,updatedAt:at};
}
export const activeStockMoves = (moves:StockMove[]) => {const reversed = new Set(moves.map(move => move.undoOf).filter(Boolean));return moves.filter(move => !move.undoOf && !reversed.has(move.id));};
export const stockIsLow = (item:Pick<StockItem,'archivedAt'|'target'|'onHand'|'lowAt'>) => item.archivedAt === undefined && item.target > 0 && stockAtoms(item.onHand) <= stockAtoms(item.lowAt);
function saveStockValue(input:StockInput,context:StockWriteContext,before:StockItem|null,revision:number,at:number,newId:StockIds,metadataOnly=false,forceCount=false):StockChange {
  const {setup} = context;validateShop(setup);if (before) validateStockItem(before,setup,revision,!metadataOnly);
  const name = text(input.name,120,'the stock name'), nameLocal = text(input.nameLocal || '',120,'the local name'), unit = text(stockUnit(input.unit),24,'the unit'), category = text(input.category || '',80,'the category');
  if (!name || !unit) throw new Error('Enter the stock name and unit.');if(before?.archivedAt===undefined)uniqueName(name,context,before?.id);
  if (before && before.unit !== unit) throw new Error('Stock history keeps its unit. Create a new stock item to use another unit.');
  const onHand = stockNumber(stockAtoms(input.onHand)), target = stockNumber(stockAtoms(input.target)), packSize = stockNumber(stockAtoms(input.packSize)), lowAt = input.lowAt === undefined ? stockNumber(stockAtoms(target)/2n) : stockNumber(stockAtoms(input.lowAt));
  if (packSize <= 0 || lowAt > target) throw new Error('Use a positive pack size and a low threshold no higher than the target.');
  const aliases = [...new Set((input.aliases || []).map(alias => text(alias,120,'each alias')).filter(Boolean))];if (aliases.length > 10) throw new Error('Use at most ten aliases.');
  if (input.supplierId) {const supplier = context.suppliers.find(supplier => supplier.id === input.supplierId && supplier.outletId === setup.outlet.id);if (!supplier || (supplier.archivedAt !== undefined && before?.supplierId !== supplier.id)) throw new Error('Choose an active supplier from this outlet.');}
  const counted = forceCount || !before || onHand !== before.onHand;
  const item:StockItem = {id:before?.id || newId('item'),outletId:setup.outlet.id,revision:(before?.revision || 0)+1,name,nameLocal,activeKey:before?.archivedAt===undefined?stockNameKey(name):undefined,unit,category,aliases,onHand,target,packSize,lowAt,supplierId:input.supplierId || undefined,lastCountedAt:counted ? at : before?.lastCountedAt,eventId:'',createdAt:before?.createdAt ?? at,updatedAt:at,...(before?.archivedAt===undefined?{}:{archivedAt:before.archivedAt})};
  const audit = stockEvent(item,setup,before ? 'stock.item-update' : 'stock.item-create',before,at,newId), countedMove = counted ? move(item,before?.onHand || 0,'count','manual',before ? 'On hand edited by owner' : 'Opening physical count',setup,at,newId) : undefined;
  audit.after = {item,...(countedMove ? {move:countedMove} : {})};return {items:[item],moves:countedMove ? [countedMove] : [],events:[audit]};
}
export function saveStockItemCommand(input:StockInput,context:StockWriteContext,before:StockItem|null = null,revision = 0,at = Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  return saveStockValue(input,context,before,revision,at,newId);
}
/** A saved description edit never changes a current physical quantity or archive state. */
export function saveStockMetadataCommand(input:Omit<StockInput,'onHand'>,before:StockItem,context:StockWriteContext,at=Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  if(!before)throw new Error('Choose the existing stock item.');
  return saveStockValue({...input,onHand:before.onHand},context,before,before.revision,at,newId,true);
}
/** A command with a reserved physical-count movement keeps that movement even
 * when the checked current quantity now equals the recorded absolute count. */
export function saveStockCountCommand(input:StockInput,before:StockItem,context:StockWriteContext,at=Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  if(!before)throw new Error('Choose the existing stock item.');
  return saveStockValue(input,context,before,before.revision,at,newId,false,true);
}
export function adjustStockCommand(input:StockAdjustment,context:StockWriteContext,at = Date.now(),countBatchId?:string,newId:StockIds=()=>ulid(at)):StockChange {
  const before = context.items.find(item => item.id === input.id);if (!before) throw new Error('Stock item not found.');validateStockItem(before,context.setup,input.revision);
  if (!['used','received','count','waste'].includes(input.reason) || (input.source && !['manual','quick_update','count'].includes(input.source))) throw new Error('Choose a supported stock action.');
  const quantity = stockAtoms(input.quantity);if (!quantity && input.reason !== 'count') throw new Error('Enter a quantity greater than zero.');
  const after = input.reason === 'count' ? quantity : stockAtoms(before.onHand)+(input.reason === 'received' ? quantity : -quantity);
  if (after < 0n) throw new Error(`There is not enough ${before.name}. Check its count or edit the proposed quantity.`);
  const item = {...before,onHand:stockNumber(after),revision:before.revision+1,updatedAt:at,lastCountedAt:input.reason === 'count' ? at : before.lastCountedAt};
  const audit = stockEvent(item,context.setup,`stock.${input.reason}`,before,at,newId), recorded = move(item,before.onHand,input.reason,input.source || 'manual',input.note || '',context.setup,at,newId,countBatchId);
  audit.after = {item,move:recorded};return {items:[item],moves:[recorded],events:[audit]};
}
export function stockBatchCommand(inputs:StockAdjustment[],context:StockWriteContext,at = Date.now(),count = false,newId:StockIds=()=>ulid(at)):StockChange {
  if (!inputs.length || inputs.length > 1000) throw new Error('Review between one and 1,000 stock changes.');
  const batch = count ? newId('batch') : undefined,result:StockChange = {items:[],moves:[],events:[]}, ids = new Set<string>();
  for (const input of inputs) {
    if (count && input.reason !== 'count') throw new Error('A night count records physical counts only.');
    if (ids.has(input.id)) throw new Error('Combine each stock item into one reviewed change.');ids.add(input.id);
    const change = adjustStockCommand({...input,source:count ? 'count' : input.source},context,at,batch,newId);result.items.push(...change.items);result.moves.push(...change.moves);result.events.push(...change.events);
  }
  return result;
}
export function canUndoStockMove(record:StockMove,moves:StockMove[],at = Date.now()):boolean {
  return !record.undoOf && at >= record.createdAt && at-record.createdAt <= 86400000 && !moves.some(move => move.undoOf === record.id) && !activeStockMoves(moves).some(move => move.stockItemId === record.stockItemId && move.reason === 'count' && move.revision > record.revision);
}
export function undoStockMoveCommand(record:StockMove,revision:number,context:StockWriteContext,at = Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  const before = context.items.find(item => item.id === record.stockItemId), original = context.moves.find(move => move.id === record.id);
  if (!before || !original || original.stockItemId !== before.id || original.outletId !== context.setup.outlet.id) throw new Error('Stock movement not found in this outlet.');validateStockItem(before,context.setup,revision);
  if (!canUndoStockMove(original,context.moves,at)) throw new Error('Undo is available once within 24 hours. Undo any later physical count first, or enter a new count.');
  const amount = stockAtoms(before.onHand)-stockAtoms(original.delta,true);if (amount < 0n) throw new Error('This stock has since been used. Record a corrected physical count instead.');
  const remainingCounts = activeStockMoves(context.moves.filter(move => move.id !== original.id)).filter(move => move.stockItemId === before.id && move.reason === 'count');
  const latest = remainingCounts.sort((a,b) => b.revision-a.revision)[0];
  const item = {...before,onHand:stockNumber(amount),revision:before.revision+1,updatedAt:at,lastCountedAt:latest?.createdAt};
  const audit = stockEvent(item,context.setup,'stock.undo',before,at,newId);audit.undoOf = original.eventId;
  const recorded = move(item,before.onHand,'undo','manual',`Undo ${original.reason}`,context.setup,at,newId,original.countBatchId,original.id);audit.after = {item,move:recorded};return {items:[item],moves:[recorded],events:[audit]};
}
function stockArchiveValue(before:StockItem,archive:boolean,revision:number,context:StockWriteContext,at:number,newId:StockIds,allowSameState=false):StockChange {
  validateStockItem(before,context.setup,revision,false);if (!allowSameState&&(before.archivedAt !== undefined) === archive) throw new Error('This stock item already has that archive state.');if (!archive) uniqueName(before.name,context,before.id);
  const item = {...before,revision:before.revision+1,activeKey:archive ? undefined : stockNameKey(before.name),archivedAt:archive ? at : undefined,updatedAt:at};
  const audit = stockEvent(item,context.setup,archive ? 'stock.archive' : 'stock.restore',before,at,newId);return {items:[item],moves:[],events:[audit]};
}
export function archiveStockItemCommand(before:StockItem,archive:boolean,revision:number,context:StockWriteContext,at=Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  return stockArchiveValue(before,archive,revision,context,at,newId);
}
/** Last admitted explicit archive intent records its actual predecessor, including a same-state set. */
export function setStockArchiveCommand(before:StockItem,archive:boolean,context:StockWriteContext,at=Date.now(),newId:StockIds=()=>ulid(at)):StockChange {
  return stockArchiveValue(before,archive,before.revision,context,at,newId,true);
}
export interface SupplierInput {name:string;phone:string;note:string}
export type SupplierIds=(kind:'supplier'|'event')=>string;
export function saveSupplierCommand(input:SupplierInput,setup:ShopSetup,before:Supplier|null = null,revision = 0,at = Date.now(),newId:SupplierIds=()=>ulid(at)) {
  validateShop(setup);if (before && (before.outletId !== setup.outlet.id || before.revision !== revision)) throw new Error('This supplier changed or belongs to another outlet. Reopen it.');
  if (before && (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER)) throw new Error('The supplier revision exceeds the supported range.');
  const name = text(input.name,120,'the supplier name'), phone = input.phone.trim() ? normalisePhone(input.phone,setup.business.marketCode) : undefined;
  if (!name || (input.phone.trim() && !phone) || input.note.trim().length > 2000) throw new Error('Enter a supplier name, a complete phone number if given, and a note within 2,000 characters.');
  const supplier:Supplier = {id:before?.id || newId('supplier'),outletId:setup.outlet.id,revision:(before?.revision || 0)+1,name,phone:phone || undefined,note:input.note.trim(),archivedAt:before?.archivedAt,eventId:'',createdAt:before?.createdAt ?? at,updatedAt:at};
  const audit = event(setup,before ? 'supplier.update' : 'supplier.create',before,supplier,at,()=>newId('event'));audit.supplierId = supplier.id;supplier.eventId = audit.id;return {supplier,event:audit};
}
export function archiveSupplierCommand(before:Supplier,archive:boolean,revision:number,setup:ShopSetup,at = Date.now(),newId:SupplierIds=()=>ulid(at)) {
  validateShop(setup);if (before.outletId !== setup.outlet.id || before.revision !== revision || (before.archivedAt !== undefined) === archive) throw new Error('Reopen this supplier before changing its archive state.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('The supplier revision exceeds the supported range.');
  const supplier = {...before,revision:before.revision+1,archivedAt:archive ? at : undefined,updatedAt:at}, audit = event(setup,archive ? 'supplier.archive' : 'supplier.restore',before,supplier,at,()=>newId('event'));audit.supplierId = supplier.id;supplier.eventId = audit.id;return {supplier,event:audit};
}
