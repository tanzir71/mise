import { describe, expect, it } from 'vitest';
import { parseDownloadsManifest } from '../packages/core/downloads';

const extension = { id: 'extension', name: 'Chrome extension', version: '0.5.0', file: '0.5.0/mise-extension-0.5.0.zip', latest: 'latest/mise-extension.zip', bytes: 421888, sha256: 'a'.repeat(64), minApp: '0.5.0' };
describe('download manifest trust boundary', () => {
  it('accepts the phase-zero empty manifest and published metadata', () => {
    expect(parseDownloadsManifest({ updatedAt: null, items: [] }).items).toEqual([]);
    expect(parseDownloadsManifest({ updatedAt: '2026-11-15T08:00:00Z', items: [extension] }).items[0].latest).toBe('latest/mise-extension.zip');
  });
  it('rejects external URLs, traversal, unsafe checksums, sizes and duplicates', () => {
    for (const item of [ { ...extension, file: '../bad.zip' }, { ...extension, latest: 'https://bad.test/app.zip' }, { ...extension, sha256: '<script>' }, { ...extension, bytes: 0 }, { ...extension, bytes: 51 * 1024 * 1024 } ]) {
      expect(() => parseDownloadsManifest({ updatedAt: null, items: [item] })).toThrow();
    }
    expect(() => parseDownloadsManifest({ updatedAt: null, items: [extension, extension] })).toThrow();
    expect(() => parseDownloadsManifest({ updatedAt: 'invalid', items: [] })).toThrow();
  });
});
