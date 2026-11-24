import {parseMoney} from './money';
import {orderLineTotal} from './order-lines';
import {parseStockQuantity,stockUnit} from './stock-quantity';
import {ocrLineNeedsReview,type OcrRead,type OcrLine} from './ocr';

export interface OcrInvoiceItem {
 sourceIndex:number;source:OcrLine;name:string;quantity:number;unit:string;unitPrice:number;printedAmount:number;computedAmount:number;warnings:string[];
}
export interface OcrInvoiceDraft {
 sourceText:string;items:OcrInvoiceItem[];otherLines:{sourceIndex:number;source:OcrLine}[];
 totals:{sourceIndex:number;source:OcrLine;amount:number}[];sum:number|null;totalCheck:'matches'|'differs'|'missing'|'ambiguous';
}
const units:Record<string,string>={কেজি:'kg',কিলো:'kg',গ্রাম:'g',লিটার:'L',মিলি:'ml',টি:'pcs',টা:'pcs',প্যাকেট:'pack',হালি:'hali',ডজন:'dozen'};
const knownUnits=['kilograms','kilogram','millilitres','millilitre','milliliters','milliliter','litres','litre','liters','liter','pieces','piece','dozen','strips','strip','packs','pack','kgs','kg','gms','gm','grams','gram','ml','ltr','lt','pcs','pc','hali','dz','g','l',...Object.keys(units)].join('|');
const number='[0-9০-৯]+(?:\\.[0-9০-৯]{1,3})?';
const money='(?:(?:BDT|INR|USD|IDR|KES|৳|₹|\\$|Rp|KSh)\\s*)?[0-9০-৯,]+(?:\\.[0-9০-৯]+)?';
const itemPattern=new RegExp(`^(.+?)\\s+(${number})\\s*(${knownUnits})\\s+(${money})\\s+(${money})$`,'i');
const totalPattern=new RegExp(`^(?:total|grand total|মোট|সর্বমোট)\\s*[:：]?\\s*(${money})(?:\\s+টাকা)?$`,'i');

/** A conservative proposal, never a command. Read explicitly printed quantity,
 * unit, unit price and amount; keep unknown/ambiguous lines beside the proposal.
 * In particular, an OCR '101' must never be guessed to mean '10 L'. */
export function parseOcrInvoice(read:OcrRead,currency:string):OcrInvoiceDraft{
 const items:OcrInvoiceItem[]=[],otherLines:OcrInvoiceDraft['otherLines']=[],totals:OcrInvoiceDraft['totals']=[];
 read.lines.forEach((source,sourceIndex)=>{
  const text=source.text.trim();if(!text)return;
  const total=totalPattern.exec(text),amount=total?parseMoney(total[1],currency):null;
  if(total&&amount!==null){totals.push({sourceIndex,source,amount});return;}
  const match=itemPattern.exec(text);
  if(match){
   const name=match[1].trim(),quantity=parseStockQuantity(match[2]),unit=units[match[3]]||stockUnit(match[3]),unitPrice=parseMoney(match[4],currency),printedAmount=parseMoney(match[5],currency);
   if(name&&name.length<=120&&quantity!==null&&quantity>0&&unitPrice!==null&&printedAmount!==null){
    try{
     const computedAmount=orderLineTotal(unitPrice,quantity),warnings:string[]=[];
     if(ocrLineNeedsReview(source))warnings.push('Handwriting unclear, check');
     if(computedAmount!==printedAmount)warnings.push('Line amount does not match quantity × unit price.');
     items.push({sourceIndex,source,name,quantity,unit,unitPrice,printedAmount,computedAmount,warnings});return;
    }catch{/* Unsupported prices/quantities remain literal manual lines. */}
   }
  }
  otherLines.push({sourceIndex,source});
 });
 const exactSum=items.reduce((sum,item)=>sum+BigInt(item.computedAmount),0n),sum=exactSum<=BigInt(Number.MAX_SAFE_INTEGER)?Number(exactSum):null;
 const totalCheck=totals.length===0?'missing':totals.length!==1?'ambiguous':sum===null||sum!==totals[0].amount||items.some(item=>item.printedAmount!==item.computedAmount)?'differs':'matches';
 return {sourceText:read.text,items,otherLines,totals,sum,totalCheck};
}
