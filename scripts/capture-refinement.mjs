import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const stage = process.argv[2];
if (!/^r[0-2]$/.test(stage || '')) throw new Error('Choose a refinement checkpoint: r0, r1 or r2.');
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
mkdirSync('docs/screenshots', { recursive: true });
const browser = await chromium.launch();
try {
  for (const region of ['bd', 'intl']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 1600 : 1000 }, deviceScaleFactor: 1 });
    await page.goto(`${origin}${region}/`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.hero img').evaluate(image => image.decode());
    for (const [name, selector] of [['nav', '.site-header'], ['hero', '.hero']]) {
      await page.locator(selector).screenshot({ path: `docs/screenshots/${stage}-${region}-${name}-${width}.png` });
    }
    await page.close();
  }
} finally { await browser.close(); }
