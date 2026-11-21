import {expect,it} from 'vitest';
import {stockDisplayText} from '../apps/web/src/StockReviewFacts';
it('makes distinct invisible stock units and lone surrogates distinguishable without normalization',()=>{
 expect(stockDisplayText('carton\0\ud800')).toBe('carton\\u0000\\ud800');expect(stockDisplayText('carton')).not.toBe(stockDisplayText('carton\0'));expect(stockDisplayText('ＫＧ')).toBe('ＫＧ');expect(stockDisplayText('kg')).toBe('kg');
});
it('keeps Bengali names and valid supplementary characters readable',()=>{expect(stockDisplayText('চাল 📦')).toBe('চাল 📦');});
