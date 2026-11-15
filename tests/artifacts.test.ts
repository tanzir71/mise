import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseDownloadsManifest } from '../packages/core/downloads';

describe('artifact publication', () => {
  it('publishes exact checksums, stable files and valid manifest metadata', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mise-artifacts-'));
    const script = resolve('scripts/update-downloads-manifest.mjs');
    try {
      const folder = join(temporary, 'downloads', '0.5.0');
      mkdirSync(folder, { recursive: true });
      const bytes = Buffer.from('fixture device build');
      writeFileSync(join(folder, 'mise-extension-0.5.0.zip'), bytes);
      execFileSync(process.execPath, [script, '0.5.0'], { cwd: temporary });
      const manifest = parseDownloadsManifest(JSON.parse(readFileSync(join(temporary, 'downloads/manifest.json'), 'utf8')));
      expect(manifest.items[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(readFileSync(join(temporary, 'downloads/latest/mise-extension.zip'))).toEqual(bytes);
      expect(readFileSync(join(folder, 'SHA256SUMS.txt'), 'utf8')).toContain(manifest.items[0].sha256);
    } finally {
      const absolute = realpathSync(temporary);
      if (!absolute.startsWith(realpathSync(tmpdir()) + sep) || !absolute.includes('mise-artifacts-')) throw new Error('Unsafe fixture cleanup path');
      rmSync(absolute, { recursive: true });
    }
  });
});
