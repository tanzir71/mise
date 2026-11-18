import { ulid } from 'ulid';
import { waLink, normalisePhone } from './phone';
import { validateShop,type ShopSetup } from './shop-access';
import { stockQuantityText, stockToOrder } from './stock-quantity';
import type { StockContext,StockWriteContext } from './stock';
import type { AuditEvent, SupplierMessage } from './models';

export interface SupplierDraft {supplierId?:string;supplierName:string;phone?:string;stockItemIds:string[];parts:string[]}
export const newSupplierMessageId = (at = Date.now()) => ulid(at);
const oneLine = (value:string) => value.replace(/\s+/g,' ').trim();
export const supplierMessageName=oneLine;
export function supplierDrafts(context:StockContext):SupplierDraft[] {
  validateShop(context.setup);
  const groups = new Map<string,{draft:SupplierDraft;lines:string[]}>(), languages = context.setup.business.languages;
  for (const item of context.items.filter(item => item.outletId === context.setup.outlet.id && item.archivedAt === undefined).sort((a,b) => a.name.localeCompare(b.name,'en'))) {
    const quantity = stockToOrder(item);if (!quantity) continue;
    const supplier = context.suppliers.find(supplier => supplier.id === item.supplierId && supplier.outletId === item.outletId && supplier.archivedAt === undefined), key = supplier?.id || '';
    if (!groups.has(key)) groups.set(key,{draft:{supplierId:supplier?.id,supplierName:supplier?.name || 'No supplier assigned',phone:supplier?.phone,stockItemIds:[],parts:[]},lines:[]});
    const group = groups.get(key)!, name = oneLine(item.name), local = languages.includes('bn') && item.nameLocal ? ` / ${oneLine(item.nameLocal)}` : '';
    group.draft.stockItemIds.push(item.id);group.lines.push(`${name}${local}: ${stockQuantityText(quantity)} ${item.unit}`);
  }
  return [...groups.values()].map(({draft,lines}) => {
    const header = [oneLine(context.setup.business.name),languages.includes('bn') && 'অনুগ্রহ করে এই পণ্যগুলো দিন।',languages.includes('en') && 'Please supply the following items.'].filter(Boolean).join('\n');
    let part = header;
    for (const line of lines) {if (`${part}\n${line}`.length > 3500) {draft.parts.push(part);part = header;}part += `\n${line}`;}
    draft.parts.push(part);return draft;
  });
}
export const supplierDraftLink = (draft:SupplierDraft,part:number) => draft.phone && draft.parts[part] ? waLink(draft.phone,draft.parts[part]) : undefined;
export interface SupplierMessageInput {id:string;supplierId?:string;supplierName:string;phone?:string;text:string;channel:SupplierMessage['channel'];stockItemIds:string[];part:number;parts:number}
export function recordSupplierMessageCommand(input:SupplierMessageInput,context:Pick<StockWriteContext,'setup'|'items'|'suppliers'>,at = Date.now(),newId:()=>string=()=>ulid(at)):{message:SupplierMessage;event:AuditEvent} {
  validateShop(context.setup);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.id)) throw new Error('Reopen this supplier draft before marking it sent.');
  const supplier = input.supplierId ? context.suppliers.find(supplier => supplier.id === input.supplierId && supplier.outletId === context.setup.outlet.id) : undefined;
  if (input.supplierId && !supplier) throw new Error('Supplier not found in this outlet.');
  const name = oneLine(input.supplierName), phone = input.phone ? normalisePhone(input.phone,context.setup.business.marketCode) : undefined;
  if (!name || name.length > 120 || (input.phone && phone !== input.phone) || !['manual','whatsapp'].includes(input.channel) || (input.channel === 'whatsapp' && !phone)) throw new Error('Review the supplier name, phone and contact method.');
  if (!input.text.trim() || input.text.length > 4000 || !Number.isSafeInteger(input.parts) || input.parts < 1 || input.parts > 1000 || !Number.isSafeInteger(input.part) || input.part < 1 || input.part > input.parts) throw new Error('Review the message and its part number before marking it sent.');
  const ids = [...new Set(input.stockItemIds)];
  if (!ids.length || ids.length > 1000 || ids.some(id => !context.items.some(item => item.id === id && item.outletId === context.setup.outlet.id))) throw new Error('Choose stock items from this outlet.');
  const message:SupplierMessage = {id:input.id,outletId:context.setup.outlet.id,supplierId:input.supplierId,supplierName:name,phone:phone || undefined,text:input.text.trim(),channel:input.channel,stockItemIds:ids,part:input.part,parts:input.parts,createdBy:context.setup.owner.id,eventId:newId(),createdAt:at,updatedAt:at};
  const event:AuditEvent = {id:message.eventId,outletId:message.outletId,supplierId:message.supplierId,actor:{type:'member',id:context.setup.owner.id},command:'supplier.sent',before:null,after:message,at};return {message,event};
}
export function sameSupplierMessage(input:SupplierMessageInput,message:SupplierMessage):boolean {
  return input.id === message.id && input.supplierId === message.supplierId && oneLine(input.supplierName) === message.supplierName && input.phone === message.phone && input.text.trim() === message.text && input.channel === message.channel && input.part === message.part && input.parts === message.parts && JSON.stringify([...new Set(input.stockItemIds)].sort()) === JSON.stringify([...message.stockItemIds].sort());
}
export function undoSupplierMessageCommand(before:SupplierMessage,setup:ShopSetup,at = Date.now(),newId:()=>string=()=>ulid(at)) {
  validateShop(setup);if (before.outletId !== setup.outlet.id || before.voidedAt !== undefined || at < before.createdAt || at-before.createdAt > 86400000) throw new Error('A sent record can be corrected once within 24 hours.');
  const message = {...before,voidedAt:at,updatedAt:at}, event:AuditEvent = {id:newId(),outletId:message.outletId,supplierId:message.supplierId,actor:{type:'member',id:setup.owner.id},command:'supplier.sent-undo',before,after:message,at,undoOf:before.eventId};return {message,event};
}
