import {expect,it} from 'vitest';
import {customerDisplayText} from '../apps/web/src/CustomerReviewFacts';
it('keeps distinct invisible customer text distinguishable without normalization',()=>{expect(customerDisplayText('Name\0\ud800')).toBe('Name\\u0000\\ud800');expect(customerDisplayText('Name')).not.toBe(customerDisplayText('Name\0'));expect(customerDisplayText('Ｋarim')).toBe('Ｋarim');});
it('keeps Bengali names and valid supplementary characters readable',()=>{expect(customerDisplayText('করিম 📒')).toBe('করিম 📒');});
