import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const stage = process.argv[2];
if (!/^r[0-3]$/.test(stage || '')) throw new Error('Choose a refinement checkpoint: r0, r1, r2 or r3.');
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
mkdirSync('docs/screenshots', { recursive: true });
const browser = await chromium.launch();
try {
  for (const region of ['bd', 'intl']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 1600 : 1000 }, deviceScaleFactor: 1 });
    await page.goto(`${origin}${region}/`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.hero img').evaluate(image => image.decode());
    const sections = stage === 'r3' ? [['operations', '#f-orders'], ['day', '#day'], ['businesses', '#businesses']] : [['nav', '.site-header'], ['hero', '.hero']];
    for (const [name, selector] of sections) {
      const section = page.locator(selector);
      for (const image of await section.locator('img').all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(image => image.decode());
      }
      await section.screenshot({ path: `docs/screenshots/${stage}-${region}-${name}-${width}.png`, style: stage === 'r3' ? '.site-header { visibility: hidden; }' : '' });
    }
    await page.close();
  }
} finally { await browser.close(); }
