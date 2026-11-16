import { expect,test } from 'vitest';
import fc from 'fast-check';
import { compressToUint8Array,decompressFromUint8Array } from 'lz-string';
import { parsePublicShop,PUBLIC_SHOP_MAX_PAYLOAD,PUBLIC_SHOP_MAX_TEXT } from '../packages/core/public-shop';
import { decodeShopPayload,encodeShopPayload,publicShopUrl } from '../packages/core/public-shop-codec';
import { decompressLzBounded } from '../packages/core/lz-bounded';
import { publicShopFixture } from './public-shop-fixture';

const encoded=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64url');
test('the public packet is LZ-String Uint8Array plus canonical base64url, preserving Bengali and prices',()=>{
  const source=publicShopFixture(),payload=encodeShopPayload(source),bytes=Uint8Array.from(Buffer.from(payload,'base64url'));expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);expect(payload.length).toBeLessThanOrEqual(PUBLIC_SHOP_MAX_PAYLOAD);expect(decodeShopPayload(payload)).toEqual(source);expect(JSON.parse(decompressFromUint8Array(bytes)!)).toEqual(source);
  const independent=encoded(compressToUint8Array(JSON.stringify(source)));expect(decodeShopPayload(independent)).toEqual(source);expect(encodeShopPayload(Object.fromEntries(Object.entries(source).reverse()))).toBe(payload);
});
test('only whitelisted public fields can be published; private records and unsafe values are rejected',()=>{
  const source=publicShopFixture();for(const value of [{...source,customers:[]},{...source,ownerPin:'1234'},{...source,items:[{...source.items[0],creditLimit:1}]},JSON.parse('{"__proto__":{"polluted":true}}')])expect(()=>encodeShopPayload(value)).toThrow();
  for(const price of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>parsePublicShop({...source,items:[{...source.items[0],price}]})).toThrow(/minor-unit/);
  expect(()=>parsePublicShop({...source,items:[source.items[0],source.items[0]]})).toThrow(/unique/);expect(()=>parsePublicShop({...source,mode:'menu',items:[]})).toThrow(/Choose an item/);expect(()=>parsePublicShop({...source,items:Array.from({length:21},(_,i)=>({...source.items[0],id:`item-${i}`}))})).toThrow(/at most 20/);
  expect(()=>parsePublicShop({...source,name:'bad\u0000text'})).toThrow();expect(()=>parsePublicShop({...source,name:'bad\ud800text'})).toThrow();expect(()=>parsePublicShop({...source,timezone:'not/a-zone'})).toThrow();expect(()=>parsePublicShop({...source,v:2})).toThrow(/version/);
});
test('empty, corrupt, noncanonical and oversized links fail before becoming shop data',()=>{
  for(const payload of ['', '!', 'x'.repeat(PUBLIC_SHOP_MAX_PAYLOAD+1),'A','AQ','__=','AAAB'])expect(()=>decodeShopPayload(payload)).toThrow();
  expect(()=>decodeShopPayload(encoded(compressToUint8Array('not JSON')))).toThrow(/valid public data/);
  const bomb=encoded(compressToUint8Array('x'.repeat(100000)));expect(bomb.length).toBeLessThan(PUBLIC_SHOP_MAX_PAYLOAD);expect(()=>decodeShopPayload(bomb)).toThrow(/expanded.*large/);
  const source=publicShopFixture();let seed=41;const random=()=>{let out='';for(let i=0;i<80;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;out+=String.fromCharCode(33+(seed>>>24)%90);}return out;};const large={...source,items:Array.from({length:20},(_,i)=>({...source.items[0],id:`item-${i}`,name:random(),nameLocal:random()}))};expect(()=>encodeShopPayload(large)).toThrow(/link is too long/);
});
test('bounded decoding agrees with the independent encoder for arbitrary UTF-16 and dictionary boundaries',()=>{
  fc.assert(fc.property(fc.array(fc.integer({min:0,max:65535}),{maxLength:400}),units=>{const text=String.fromCharCode(...units),bytes=compressToUint8Array(text);expect(decompressLzBounded(bytes,Math.max(1,text.length))).toBe(text);}),{numRuns:250});
  for(const text of ['','ABABABA'.repeat(1000),'চিনি, চাল, ডিম '.repeat(200),'🙂'.repeat(200)])expect(decompressLzBounded(compressToUint8Array(text),PUBLIC_SHOP_MAX_TEXT)).toBe(text);
  expect(()=>decompressLzBounded(compressToUint8Array('x'.repeat(16001)),16000)).toThrow(/expanded/);expect(()=>decompressLzBounded(new Uint8Array([1]),100)).toThrow();expect(()=>decompressLzBounded(new Uint8Array([0,0]),0)).toThrow();
});
test.each(['https://example.com/app/','https://tanzir71.github.io/mise/app/','http://127.0.0.1:5173/app/'])('shop URLs keep the public data in the fragment under %s',base=>{
  const url=new URL(publicShopUrl(base+'?privateFlag=never-share',publicShopFixture()));expect(url.pathname).toBe(new URL('s/',base).pathname);expect(url.search).toBe('');expect(decodeShopPayload(url.hash.slice(1))).toEqual(publicShopFixture());
});
test('shop URL construction refuses credentials and non-web destinations',()=>{for(const base of ['javascript:alert(1)','https://secret:password@example.com/app/','https://example.com/elsewhere/'])expect(()=>publicShopUrl(base,publicShopFixture())).toThrow();});
