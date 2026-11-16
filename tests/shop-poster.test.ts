import { describe,expect,it } from 'vitest';
import jsQR from 'jsqr';
import { publicShopUrl } from '../packages/core/public-shop-codec';
import { encodeShopQr } from '../apps/web/src/shop-poster';
import { publicShopFixture } from './public-shop-fixture';

describe('printable shop QR data',()=>{
  for(const base of ['https://tanzir71.github.io/mise/app/','https://example.com/app/'])it(`encodes the complete immutable link under ${base}`,()=>{
    const link=publicShopUrl(base,publicShopFixture()),{qr,shop}=encodeShopQr(link),size=qr.modules.size+8,scale=4,width=size*scale,pixels=new Uint8ClampedArray(width*width*4).fill(255);
    for(let row=0;row<qr.modules.size;row++)for(let col=0;col<qr.modules.size;col++)if(qr.modules.get(row,col))for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){const at=(((row+4)*scale+y)*width+(col+4)*scale+x)*4;pixels[at]=pixels[at+1]=pixels[at+2]=20;}
    expect(jsQR(pixels,width,width)?.data).toBe(link);expect(shop).toEqual(publicShopFixture());
  });
  it('retains long links using QR level L when level M cannot hold them, and rejects overflow explicitly',()=>{
    const url=new URL(publicShopUrl('https://example.com/app/',publicShopFixture()));url.search='?source='+'a'.repeat(1800);const link=url.href,result=encodeShopQr(link);expect(result.correction).toBe('L');expect(result.qr.version).toBeLessThanOrEqual(40);expect(result.shop.items).toHaveLength(2);
    url.search='?source='+'a'.repeat(4000);expect(()=>encodeShopQr(url.href)).toThrow('too long for a QR code');
  });
  it('refuses credentials, non-web links and malformed public data',()=>{
    const valid=publicShopUrl('https://example.com/app/',publicShopFixture());for(const link of [valid.replace('https://','javascript://'),valid.replace('example.com','user:secret@example.com'),valid.replace('/app/s/','/admin/'),valid.slice(0,valid.indexOf('#'))+'#bad'])expect(()=>encodeShopQr(link)).toThrow();
  });
});
