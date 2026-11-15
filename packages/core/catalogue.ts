import { ulid } from 'ulid';
import type { AuditEvent, Category, Item } from './models';
import { parseMoney } from './money';
export interface ItemInput { name: string; nameLocal: string; price: number; unit: string; category: string; available: boolean; oftenBought: boolean }
export interface CatalogueContext { outletId: string; actorId: string; categories: Category[] }
export interface ItemCommand { item: Item; category?: Category; event: AuditEvent }
export function saveItemCommand(input: ItemInput, context: CatalogueContext, before: Item | null = null, at = Date.now()): ItemCommand {
  const name = input.name.trim(), unit = input.unit.trim(), categoryName = input.category.trim() || 'Uncategorised';
  if (!name || name.length > 120 || input.nameLocal.trim().length > 120) throw new Error('Use an item name between 1 and 120 characters.');
  if (!unit || unit.length > 16 || categoryName.length > 80) throw new Error('Enter a unit and a category of at most 80 characters.');
  if (!Number.isSafeInteger(input.price) || input.price < 0) throw new Error('Enter a valid non-negative price.');
  if (before && before.outletId !== context.outletId) throw new Error('This item belongs to another outlet.');
  const existing = context.categories.find(category => category.outletId === context.outletId && category.name.normalize('NFKC').toLowerCase() === categoryName.normalize('NFKC').toLowerCase());
  const category: Category = existing || { id: ulid(at), outletId: context.outletId, name: categoryName, sort: context.categories.length, createdAt: at, updatedAt: at };
  const item: Item = { id: before?.id || ulid(at), outletId: context.outletId, name, nameLocal: input.nameLocal.trim(), price: input.price, unit, categoryId: category.id, available: Boolean(input.available), oftenBought: Boolean(input.oftenBought), isSample: false, createdAt: before?.createdAt ?? at, updatedAt: at };
  return { item, category: existing ? undefined : category, event: { id: ulid(at), outletId: context.outletId, actor: { type: 'member', id: context.actorId }, command: before ? 'catalogue.update' : 'catalogue.create', before, after: { item, category: existing ? null : category }, at } };
}
export function itemAvailabilityCommand(item: Item, available: boolean, actorId: string, at = Date.now()): ItemCommand {
  const after = { ...item, available, updatedAt: at };
  return { item: after, event: { id: ulid(at), outletId: item.outletId, actor: { type: 'member', id: actorId }, command: 'catalogue.availability', before: item, after, at } };
}
export function deleteItemCommand(item: Item, actorId: string, at = Date.now()): AuditEvent {
  return { id: ulid(at), outletId: item.outletId, actor: { type: 'member', id: actorId }, command: 'catalogue.delete', before: item, after: null, at };
}
export function searchItems(items: Item[], query: string): Item[] {
  const terms = query.trim().normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? items.filter(item => { const text = `${item.name} ${item.nameLocal} ${item.unit}`.normalize('NFKC').toLowerCase(); return terms.every(term => text.includes(term)); }) : items;
}
export const orderableItems = (items: Item[]): Item[] => items.filter(item => item.available);
export interface PasteRow { line: number; name: string; price: number | null; error: string }
export function parseCataloguePaste(text: string, currency: string): PasteRow[] {
  let firstContent = true;
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const header = firstContent && /^\s*(?:name|item|product|dish)\s*,\s*price\s*$/i.test(line);
    firstContent = false;
    if (header) return [];
    const quoted = /^\s*"((?:""|[^"])*)"\s*,\s*(.*)$/.exec(line);
    const comma = line.indexOf(',');
    const name = (quoted ? quoted[1].replaceAll('""', '"') : comma >= 0 ? line.slice(0, comma) : line).trim();
    const rawPrice = (quoted ? quoted[2] : comma >= 0 ? line.slice(comma + 1) : '').trim().replace(/^"(.*)"$/, '$1');
    const price = parseMoney(rawPrice, currency);
    return [{ line: index + 1, name, price, error: !name || name.length > 120 ? 'Enter a name of at most 120 characters.' : price === null ? 'Enter a valid price after a comma.' : '' }];
  });
}
export function removeSampleCommand(item: Item, actorId: string, at = Date.now()): AuditEvent {
  if (!item.isSample) throw new Error('Only sample items can be removed during setup.');
  return { id: ulid(at), outletId: item.outletId, actor: { type: 'member', id: actorId }, command: 'catalogue.remove-sample', before: item, after: null, at };
}
