import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const stage = process.argv[2];
if (!/^r[0-5]$/.test(stage || '')) throw new Error('Choose a refinement checkpoint from r0 to r5.');
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
mkdirSync('docs/screenshots', { recursive: true });
const browser = await chromium.launch();
try {
  for (const region of ['bd', 'intl']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 1600 : 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.goto(`${origin}${region}/`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.hero img').evaluate(image => image.decode());
    const sections = stage === 'r5' ? [['operations', '#f-orders'], ['checks', '#checks'], ['basics', '#basics'], ['businesses', '#businesses']]
      : stage === 'r4'
      ? [['nav', '.site-header'], ['hero', '.hero'], ...['features', 'ai', 'ocr', 'capture', 'checks', 'detail', 'day', 'businesses', 'basics', 'compare', 'cta'].map(id => [id, '#'+id]), ['detail-first', '#f-orders'], ['footer', '.site-footer']]
      : stage === 'r3' ? [['operations', '#f-orders'], ['day', '#day'], ['businesses', '#businesses']] : [['nav', '.site-header'], ['hero', '.hero']];
    for (const [name, selector] of sections) {
      const section = page.locator(selector);
      for (const image of await section.locator('img').all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(image => image.decode());
      }
      if (name === 'day') await section.locator('.day-shots').evaluate(row => { row.scrollLeft = 0; });
      await section.screenshot({ path: `docs/screenshots/${stage}-${region}-${name}-${width}.png`, style: '.skip-link { visibility: hidden; }' + (!['nav', 'hero'].includes(name) ? '.site-header { visibility: hidden; }' : '') });
    }
    if (stage === 'r5' && width === 390) {
      await page.locator('#f-orders .detail-how > summary').click();
      await page.locator('#f-orders').screenshot({ path: `docs/screenshots/${stage}-${region}-operations-open-${width}.png`, style: '.skip-link, .site-header { visibility: hidden; }' });
      await page.locator('.more-checks > summary').click();
      await page.locator('#checks').screenshot({ path: `docs/screenshots/${stage}-${region}-checks-open-${width}.png`, style: '.skip-link, .site-header { visibility: hidden; }' });
    }
    await page.close();
  }
} finally { await browser.close(); }
