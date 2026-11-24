import type { StockItem } from './models';
import type { StockAdjustment } from './stock';
import { convertStockQuantity, stockAtoms, stockNameKey, stockNumber, stockText, stockUnit } from './stock-quantity';

export interface QuickStockChange extends StockAdjustment {name:string;unit:string;before:number;after:number;clause:string}
export interface QuickStockIssue {clause:string;message:string;candidates:string[]}
export interface QuickStockPreview {changes:QuickStockChange[];issues:QuickStockIssue[]}
export type QuickStockItem=Pick<StockItem,'id'|'outletId'|'archivedAt'|'name'|'nameLocal'|'aliases'|'unit'|'packSize'|'onHand'|'revision'>;
const actions:Record<string,StockAdjustment['reason']> = {used:'used',consumed:'used',sold:'used',got:'received',received:'received',bought:'received',added:'received',wasted:'waste',waste:'waste',spoiled:'waste',counted:'count',count:'count',have:'count',set:'count',left:'count'};
const verbs = Object.keys(actions).join('|'), prefix = new RegExp(`^(${verbs})\\s+`,'i'), infix = new RegExp(`\\s+(${verbs})\\s+`,'i');
const knownUnits = new Set(['kg','g','L','ml','pcs','hali','dozen','strip','pack']);
const errorText = (error:unknown) => error instanceof Error ? error.message : 'Edit this stock update.';

/** A local, deterministic preview. Caller must review every clause before an atomic save. */
export function quickUpdate(input:string,items:readonly QuickStockItem[],outletId:string):QuickStockPreview {
  const result:QuickStockPreview = {changes:[],issues:[]}, active = items.filter(item => item.outletId === outletId && item.archivedAt === undefined);
  if (input.length > 8000) return {changes:[],issues:[{clause:'',message:'Keep a quick update within 8,000 characters.',candidates:[]}]};
  const clauses = stockText(input).split(new RegExp(`[,;\\n]+|\\s+and\\s+(?=(?:${verbs})\\s)`,'i')).map(value => value.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 100) return {changes:[],issues:[{clause:'',message:'Enter between one and 100 stock changes.',candidates:[]}]};
  for (const clause of clauses) {
    let candidates:QuickStockItem[] = [];
    try {
      let body = clause, reason:StockAdjustment['reason'] = 'count';
      const start = body.match(prefix), middle = body.match(infix);
      if (start) {reason = actions[start[1].toLowerCase()];body = body.slice(start[0].length);}
      else if (middle) {reason = actions[middle[1].toLowerCase()];body = `${body.slice(0,middle.index)} ${body.slice(middle.index!+middle[0].length)}`;}
      else if (/^[a-z]+\s+\d/i.test(body) && !active.some(item => [item.name,item.nameLocal,...item.aliases].some(name => name && stockNameKey(body).startsWith(`${stockNameKey(name)} `)))) throw new Error('Use used, got, wasted or counted, followed by an item and quantity.');
      let quantityText:string, unit = '', name:string;
      const front = body.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(.*)$/);
      if (front) {
        quantityText = front[1];name = front[2].trim();
        const first = name.match(/^(\S+)\s+(.+)$/);
        if (first && (knownUnits.has(stockUnit(first[1])) || active.some(item => stockNameKey(item.unit) === stockNameKey(first[1])))) {unit = first[1];name = first[2].replace(/^of\s+/i,'');}
      } else {
        const end = body.match(/^(.+?)\s+(\d+(?:\.\d+)?|\.\d+)\s*([^\d]*)$/);
        if (!end) throw new Error('Enter an item and a positive quantity, such as used 2 kg chicken.');
        [,name,quantityText,unit] = end;name = name.replace(/\s+(?:to|at)$/i,'').trim();unit = unit.trim();
      }
      const key = stockNameKey(name), names = (item:QuickStockItem) => [item.name,item.nameLocal,...item.aliases].map(stockNameKey).filter(Boolean);
      candidates = active.filter(item => names(item).includes(key));
      if (!candidates.length && key.length >= 2) candidates = active.filter(item => names(item).some(name => name.includes(key)));
      if (!candidates.length) throw new Error(`No active stock item matches “${name}”. Choose an item or edit its name.`);
      if (candidates.length > 1) throw new Error(`More than one stock item matches “${name}”. Use its full name.`);
      const item = candidates[0], quantity = convertStockQuantity(stockNumber(stockAtoms(quantityText)),unit || item.unit,item.unit,item.packSize), amount = stockAtoms(quantity);
      if (!amount && reason !== 'count') throw new Error('Use a quantity greater than zero.');
      const after = reason === 'count' ? amount : stockAtoms(item.onHand)+(reason === 'received' ? amount : -amount);
      if (after < 0n) throw new Error(`There is not enough ${item.name}. Edit the amount or record a physical count.`);
      if (result.changes.some(change => change.id === item.id)) throw new Error(`“${item.name}” appears twice. Combine it into one reviewed change.`);
      result.changes.push({id:item.id,revision:item.revision,reason,quantity,source:'quick_update',note:clause,name:item.name,unit:item.unit,before:item.onHand,after:stockNumber(after),clause});
    } catch (error) {result.issues.push({clause,message:errorText(error),candidates:candidates.map(item => item.id)});}
  }
  return result;
}
