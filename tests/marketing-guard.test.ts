import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('marketing source guard', () => {
  it('rejects an app-screen redraw and accepts normal image markup', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mise-marketing-'));
    try {
      const path = join(temporary, 'example.astro');
      const check = () => spawnSync(process.execPath, [resolve('scripts/check-marketing.mjs'), temporary], { encoding: 'utf8' });
      writeFileSync(path, '<div class="phone-preview">A hand-drawn screen</div>');
      expect(check().status).toBe(1);
      expect(check().stderr).toContain('example.astro:1');
      writeFileSync(path, '<picture><img src="phone.png" width="310" height="638" alt="Orders" /></picture>');
      expect(check().status).toBe(0);
    } finally {
      const absolute = realpathSync(temporary);
      if (!absolute.startsWith(realpathSync(tmpdir()) + sep) || !absolute.includes('mise-marketing-')) throw new Error('Unsafe fixture cleanup path');
      rmSync(absolute, { recursive: true });
    }
  });
});
