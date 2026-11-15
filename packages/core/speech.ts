import { calculateAmount, normalizeExpression } from './calc';
const small: Record<string, number> = Object.fromEntries(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'].map((word, index) => [word, index]));
const tens: Record<string, number> = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const scales: Record<string, number> = { thousand:1000, lakh:100000, million:1000000 };
/** Speech is always previewed in the calculator; it never records a sale. */
export function speechExpression(transcript: string, currency: string): string | null {
  const words = transcript.toLowerCase().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6)).replace(/(?<=[a-z])-(?=[a-z])/g,' ').replace(/\b(?:taka|rupees?|dollars?|rupiah|shillings?|and)\b/g,' ').replace(/\b(?:multiplied by|times)\b/g,'*').replace(/\bdivided by\b/g,'/').replace(/\bplus\b/g,'+').replace(/\bminus\b/g,'-').replace(/\b(?:percent|per cent)\b/g,'%').replace(/\bpoint\b/g,'.').replace(/,(?=\d{3}\b)/g,'');
  const compact = normalizeExpression(words);
  if (calculateAmount(compact,currency) !== null) return compact;
  if (/[^a-z\d\s.+\-*/%()]/.test(words)) return null;
  const tokens = words.match(/[a-z]+|\d+|[.+\-*/%()]/g) || [];
  let result = '', index = 0, decimal = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[.+\-*/%()]$/.test(token)) { result += token; decimal = token === '.'; index++; continue; }
    if (/^\d+$/.test(token)) { result += token; index++; continue; }
    let group = 0n, total = 0n;
    while (index < tokens.length && /^[a-z]+$/.test(tokens[index])) {
      const word = tokens[index++];
      if (decimal) { if (!(Object.hasOwn(small,word)) || small[word] > 9) return null; result += small[word]; continue; }
      if (Object.hasOwn(small,word)) group += BigInt(small[word]);
      else if (Object.hasOwn(tens,word)) group += BigInt(tens[word]);
      else if (word === 'hundred') group = (group || 1n) * 100n;
      else if (Object.hasOwn(scales,word)) { total += (group || 1n) * BigInt(scales[word]); group = 0n; }
      else return null;
    }
    if (!decimal) result += total + group;
  }
  return calculateAmount(result,currency) === null ? null : result;
}
