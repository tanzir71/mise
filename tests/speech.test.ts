import { expect, test } from 'vitest';
import { speechExpression } from '../packages/core/speech';
test.each([
  ['75 plus 20','75+20'], ['seventy five plus twenty','75+20'], ['one hundred and twenty five minus five','125-5'],
  ['twenty five point five zero times two','25.50*2'], ['two hundred plus ten percent','200+10%'],
  ['one thousand divided by four','1000/4'], ['one lakh twenty five thousand','125000'], ['৭৫ plus ২০','75+20'],
  ['unknown amount',null], ['10 divided by zero',null], ['call someone',null], ['window.alert(1)',null], ['constructor',null],
] as const)('speech previews %s safely', (text, expected) => expect(speechExpression(text,'BDT')).toBe(expected));
