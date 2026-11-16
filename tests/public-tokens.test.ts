import { expect,test } from 'vitest';
import { publicTokens } from '../apps/web/public-tokens';
test('public styles retain exact resolved shared values without unrelated tokens or constant aliases',()=>{expect(publicTokens(':root{--ink:var(--neutral);--neutral:#141414;--font:"Geist", "Hind Siliguri";--unused:red;}','.button{color:var(--ink);font-family:var(--font)}')).toBe(':root{--font:"Geist", "Hind Siliguri";--ink:#141414;}');});
test('nested fallbacks and alias cycles stay complete, and missing tokens fail the build',()=>{expect(publicTokens(':root{--a:var(--b,var(--c));--b:var(--a);--c:3px;}','x{width:var(--a)}')).toContain('--c:3px;');expect(()=>publicTokens(':root{--a:var(--missing);}','x{width:var(--a)}')).toThrow('Missing shared public token');});
