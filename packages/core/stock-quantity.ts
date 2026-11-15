export const MAX_STOCK_QUANTITY = 1_000_000_000;
const MAX_ATOMS = BigInt(MAX_STOCK_QUANTITY)*1000n;
export const stockText = (text:string) => text.replace(/[০-৯]/g,digit => String(digit.charCodeAt(0)-0x09e6)).normalize('NFKC').trim();
export const stockNameKey = (text:string) => stockText(text).toLocaleLowerCase('en').replace(/\s+/g,' ');
/** Quantities remain readable in JSON. All arithmetic uses integer thousandths. */
export function stockAtoms(value:number|string,signed = false):bigint {
  let text = stockText(String(value));if (text.startsWith('.')) text = `0${text}`;if (text.startsWith('-.')) text = text.replace('-.','-0.');
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(text)) throw new Error('Use a quantity with at most three decimal places.');
  const negative = text.startsWith('-'), [whole,fraction = ''] = text.replace(/^-/,'').split('.');
  const result = (BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0')))*(negative ? -1n : 1n);
  if (result > MAX_ATOMS || result < (signed ? -MAX_ATOMS : 0n)) throw new Error('The stock quantity is outside the supported range.');return result;
}
export function stockNumber(atoms:bigint,signed = false):number {
  if (atoms > MAX_ATOMS || atoms < (signed ? -MAX_ATOMS : 0n)) throw new Error('The stock quantity is outside the supported range.');return Number(atoms)/1000;
}
export function parseStockQuantity(text:string):number|null {try{return stockNumber(stockAtoms(text));}catch{return null;}}
export const stockQuantityText = (value:number) => new Intl.NumberFormat('en',{maximumFractionDigits:3}).format(value);
const aliases:Record<string,string> = {
  kg:'kg',kgs:'kg',kilo:'kg',kilos:'kg',kilogram:'kg',kilograms:'kg',g:'g',gm:'g',gms:'g',gram:'g',grams:'g',
  l:'L',lt:'L',ltr:'L',litre:'L',litres:'L',liter:'L',liters:'L',ml:'ml',millilitre:'ml',millilitres:'ml',milliliter:'ml',milliliters:'ml',
  pc:'pcs',pcs:'pcs',piece:'pcs',pieces:'pcs',unit:'pcs',units:'pcs',hali:'hali',halis:'hali',dozen:'dozen',dozens:'dozen',dz:'dozen',strip:'strip',strips:'strip',pack:'pack',packs:'pack',
};
export const stockUnit = (unit:string):string => aliases[stockNameKey(unit)] || stockText(unit);
const units:Record<string,{family:string;factor:bigint}> = {kg:{family:'mass',factor:1000n},g:{family:'mass',factor:1n},L:{family:'volume',factor:1000n},ml:{family:'volume',factor:1n},pcs:{family:'count',factor:1n},hali:{family:'count',factor:4n},dozen:{family:'count',factor:12n}};
export function convertStockQuantity(quantity:number,from:string,to:string,packSize?:number):number {
  const source = stockUnit(from), target = stockUnit(to), amount = stockAtoms(quantity);
  if (source === target) return stockNumber(amount);
  let numerator:bigint, denominator:bigint;
  if (source === 'pack' && packSize !== undefined) {numerator = amount*stockAtoms(packSize);denominator = 1000n;}
  else {const left = units[source], right = units[target];if (!left || !right || left.family !== right.family) throw new Error(`Choose a quantity in ${target}; ${source} cannot be converted automatically.`);numerator = amount*left.factor;denominator = right.factor;}
  if (numerator%denominator) throw new Error(`This amount needs more than three decimals in ${target}. Enter it manually in the stock unit.`);
  return stockNumber(numerator/denominator);
}
export function stockToOrder(item:{onHand:number;target:number;packSize:number}):number {
  const have = stockAtoms(item.onHand), target = stockAtoms(item.target), pack = stockAtoms(item.packSize);
  if (pack <= 0n) throw new Error('Use a pack size greater than zero.');const deficit = target > have ? target-have : 0n;
  // The rounded recommendation can be larger than the storage limit; never silently truncate it.
  return stockNumber(((deficit+pack-1n)/pack)*pack);
}
