import { describe, expect, it } from 'vitest';
import { normalizeBase, sitePath } from '../packages/core/paths';

describe('portable deployment paths', () => {
  it('builds root and project URLs without duplicate slashes', () => {
    expect(sitePath('/', 'app/')).toBe('/app/');
    expect(sitePath('/mise', '/setup/')).toBe('/mise/setup/');
    expect(normalizeBase()).toBe('/');
  });
  it('rejects external URLs and traversal', () => {
    expect(() => normalizeBase('https://bad.example')).toThrow();
    expect(() => normalizeBase('/../')).toThrow();
  });
});
