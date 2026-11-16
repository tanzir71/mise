import { expect,test } from 'vitest';
import { handoffParts } from '../packages/core/handoff-parts';
test('long receipts retain all literal lines, whitespace and Bengali when split',()=>{const text='  '+Array.from({length:200},(_,i)=>`${i+1} × চাল · ৳120\r\n${'Long item '.repeat(20)}`).join('\n')+'  ',parts=handoffParts(text);expect(parts.join('')).toBe(text);expect(parts.length).toBeGreaterThan(1);expect(parts.every(part=>part.length<=3500)).toBe(true);});
test('a hard split never severs an emoji surrogate pair',()=>{const text='x'.repeat(3499)+'🛒'+'y'.repeat(3500),parts=handoffParts(text);expect(parts[0]).toHaveLength(3499);expect(parts[1].startsWith('🛒')).toBe(true);expect(parts.join('')).toBe(text);});
test('bounded parts reject empty and excessive messages instead of truncating them',()=>{expect(handoffParts('x'.repeat(350000))).toHaveLength(100);for(const text of ['', ' \n ', 'x'.repeat(350001),'\n'+'x'.repeat(350000-1)])expect(()=>handoffParts(text)).toThrow();});
