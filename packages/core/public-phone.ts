import lengths from './public-phone-lengths.json';
import type { MarketCode } from './packs';
const callingCodes:Record<string,readonly number[]>=lengths;
const localCodes:Partial<Record<MarketCode,string>>={BD:'880',IN:'91',ID:'62',KE:'254'};
function international(digits:string):string|null{
  if(!/^[1-9]\d{6,14}$/.test(digits))return null;
  for(let width=1;width<=3;width++){const code=digits.slice(0,width),national=digits.slice(width);if(callingCodes[code]?.includes(national.length))return '+'+digits;}
  return null;
}
/** A customer contact number, not proof of phone ownership or WhatsApp availability. */
export function normalisePublicPhone(input:string,market:MarketCode):string|null{
  const raw=input.replace(/[০-৯]/g,digit=>String(digit.charCodeAt(0)-0x09e6)).trim().replace(/^00/,'+');
  if(!/^\+?[\d ().-]+$/.test(raw))return null;const digits=raw.replace(/\D/g,'');
  if(raw.startsWith('+'))return international(digits);
  const code=localCodes[market];if(!code)return null;
  const national=digits.replace(/^0/,'');
  if(callingCodes[code].includes(national.length))return international(code+national);
  return digits.startsWith(code)?international(digits):null;
}
