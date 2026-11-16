import {expect,test} from 'vitest';
import {normalisePublicPhone} from '../packages/core/public-phone';
import {normalisePhone} from '../packages/core/phone';
import lengths from '../packages/core/public-phone-lengths.json';
import metadata from '../packages/core/node_modules/libphonenumber-js/metadata.min.json';
import type {MarketCode} from '../packages/core/packs';

test.each<[MarketCode,string]>([['BD','01712-345482'],['BD','০১৭১২৩৪৫৪৮২'],['BD','1712345482'],['BD','8801712345482'],['IN','09876543210'],['IN','98765 43210'],['ID','0812-3456-7890'],['KE','0712 345678'],['OTHER','+1 (202) 555-0100'],['OTHER','0044 20 7946 0123'],['BD','+254 712345678'],['BD','+80012345678']])('public contact formatting agrees with the owner for %s %s',(market,input)=>{expect(normalisePublicPhone(input,market)).toBe(normalisePhone(input,market));expect(normalisePublicPhone(input,market)).toMatch(/^\+[1-9]\d{6,14}$/);});
test('unknown calling codes, extensions, missing international prefixes and impossible lengths are rejected',()=>{
  for(const [market,input] of [['BD','123'],['OTHER','2025550100'],['BD','+999123456789'],['BD','+88001712345482'],['BD','01712345482 ext 1'],['BD','+1234567890123456'],['BD','+88017<script>']] as [MarketCode,string][])expect(normalisePublicPhone(input,market)).toBeNull();
});
test('the compact calling-code lengths exactly match the installed metadata source',()=>{
  const source=metadata as unknown as {country_calling_codes:Record<string,string[]>;countries:Record<string,unknown[]>;nonGeographic:Record<string,unknown[]>};
  for(const [code,countries] of Object.entries(source.country_calling_codes))expect((lengths as Record<string,number[]>)[code]).toEqual([...new Set(countries.flatMap(country=>source.countries[country][3] as number[]))].sort((a,b)=>a-b));
  for(const [code,plan] of Object.entries(source.nonGeographic))expect((lengths as Record<string,number[]>)[code]).toEqual(plan[3]);
});
