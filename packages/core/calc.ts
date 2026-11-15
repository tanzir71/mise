import { currencyDigits } from './money';

interface Fraction { n: bigint; d: bigint; percent?: boolean }
function fraction(n: bigint, d = 1n, percent = false): Fraction {
  if (!d) throw new Error('Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / (a || 1n), d: d / (a || 1n), percent };
}
const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
const add = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export function normalizeExpression(text: string): string {
  return text.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6)).replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').replace(/\s+/g, '');
}
/** Exact fractions internally; round once to minor units, half away from zero. */
export function calculateAmount(text: string, currency: string): number | null {
  try {
    const input = normalizeExpression(text);
    if (!input || input.length > 160 || /[^\d.+\-*/%()]/.test(input)) return null;
    let position = 0;
    function primary(): Fraction {
      let result: Fraction;
      if (input[position] === '(') {
        position++; result = sum();
        if (input[position++] !== ')') throw new Error('Missing closing bracket');
      } else {
        const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(input.slice(position));
        if (!match || match[0].replace('.', '').length > 30) throw new Error('Enter a number');
        position += match[0].length;
        const [whole, decimal = ''] = match[0].split('.');
        result = fraction(BigInt((whole || '0') + decimal), 10n ** BigInt(decimal.length));
      }
      if (input[position] === '%') { position++; result = fraction(result.n, result.d * 100n, true); }
      return result;
    }
    function unary(): Fraction {
      if (input[position] === '+') { position++; return unary(); }
      if (input[position] === '-') { position++; const value = unary(); return { ...value, n: -value.n }; }
      return primary();
    }
    function product(): Fraction {
      let result = unary();
      while (input[position] === '*' || input[position] === '/') {
        const operator = input[position++], right = unary();
        result = operator === '*' ? multiply(result, right) : multiply(result, fraction(right.d, right.n));
      }
      return result;
    }
    function sum(): Fraction {
      let result = product();
      while (input[position] === '+' || input[position] === '-') {
        const operator = input[position++]; let right = product();
        // Commercial calculator convention: 200 + 10% = 220; 200 × 10% = 20.
        if (right.percent) right = multiply(result, right);
        result = add(result, operator === '+' ? right : { ...right, n: -right.n });
      }
      return result;
    }
    const value = sum();
    if (position !== input.length) return null;
    const scaled = (value.n < 0n ? -value.n : value.n) * 10n ** BigInt(currencyDigits(currency));
    const rounded = (scaled / value.d + (scaled % value.d * 2n >= value.d ? 1n : 0n)) * (value.n < 0n ? -1n : 1n);
    return rounded >= -BigInt(Number.MAX_SAFE_INTEGER) && rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
  } catch { return null; }
}
