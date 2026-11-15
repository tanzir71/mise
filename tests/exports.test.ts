import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('required Figma exports CLI', () => {
  it('fails for missing or empty landing exports, while allowing other folders to be filtered', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mise-exports-'));
    try {
      mkdirSync(join(temporary, 'scripts'));
      mkdirSync(join(temporary, 'exports/landing'), { recursive: true });
      const script = join(temporary, 'scripts/export-figma.mjs');
      copyFileSync(resolve('handover/scripts/export-figma.mjs'), script);
      writeFileSync(join(temporary, 'exports/manifest.json'), JSON.stringify({ jobs: [{ items: [{ out: 'landing/hero.png' }, { out: 'screens/not-required.png' }] }] }));
      const check = () => spawnSync(process.execPath, [script, '--check', '--only=landing'], { encoding: 'utf8' });
      expect(check().status).toBe(1);
      expect(check().stderr).toContain('landing/hero.png');
      writeFileSync(join(temporary, 'exports/landing/hero.png'), '');
      expect(check().status).toBe(1);
      writeFileSync(join(temporary, 'exports/landing/hero.png'), 'fixture bytes');
      expect(check().status).toBe(0);
    } finally {
      const absolute = realpathSync(temporary);
      if (!absolute.startsWith(realpathSync(tmpdir()) + sep) || !absolute.includes('mise-exports-')) throw new Error('Unsafe fixture cleanup path');
      rmSync(absolute, { recursive: true });
    }
  });
});
