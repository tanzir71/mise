import { expect, test } from 'vitest';
import { calculateAmount } from '../packages/core/calc';

test.each([
  ['75+150+20', 24500], ['2+3*4', 1400], ['(2+3)*4', 2000], ['10/4', 250],
  ['.1+.2', 30], ['0.1*0.2', 2], ['1/3*3', 100], ['0.005', 1], ['-0.005', -1],
  ['10/6', 167], ['1/8', 13], ['200+10%', 22000], ['200-10%', 18000], ['200*10%', 2000],
  ['200/10%', 200000], ['10%', 10], ['200+10%+10%', 24200], ['200-(10%)', 18000],
  ['200+10%*2', 20020], ['1000-10%-5%', 85500], ['-2*-3', 600], ['2--3', 500],
  ['2++3', 500], ['+2', 200], ['12.', 1200], ['00.50', 50], ['৭৫×২−৫০÷২', 12500],
  ['3*(2+4)/2', 900], ['1/(2+3)', 20], ['(10+10)%*50', 1000], ['0', 0],
  ['90071992547409.91', Number.MAX_SAFE_INTEGER], ['90071992547409.92', null],
  ['1/0', null], ['0/0', null], ['(1+2', null], ['1+2)', null], ['1..2', null],
  ['2**3', null], ['10%%', null], ['1,000', null], ['1e3', null], ['2+', null],
  ['alert(1)', null], ['NaN', null], ['', null], ['.', null], ['()', null],
] as const)('calculator %s → %s minor units', (expression, expected) => {
  expect(calculateAmount(expression, 'BDT')).toBe(expected);
});
test('calculator limits input length and rounds in the chosen currency', () => {
  expect(calculateAmount('1+'.repeat(100) + '1', 'BDT')).toBeNull();
  expect(calculateAmount('25.005', 'IDR')).toBe(2501);
});
