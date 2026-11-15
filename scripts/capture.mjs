import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
const browser = await chromium.launch();
mkdirSync('docs/screenshots', { recursive: true });
try {
  for (const region of ['bd', 'intl']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(`${origin}${region}/`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `apps/landing/public/og-${region}.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: `docs/screenshots/${region}-1440.png`, fullPage: true });
    await page.screenshot({ path: `docs/screenshots/${region}-hero.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/screenshots/${region}-390.png`, fullPage: true });
    await page.close();
  }
  const setup = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await setup.goto(`${origin}setup/`);
  await setup.locator('#manifest-status').filter({ hasText: 'Device builds are coming' }).waitFor();
  await setup.screenshot({ path: 'docs/screenshots/setup-1440.png', fullPage: true });
  await setup.screenshot({ path: 'docs/screenshots/setup-hero.png' });
  await setup.setViewportSize({ width: 390, height: 844 });
  await setup.screenshot({ path: 'docs/screenshots/setup-390.png', fullPage: true });
} finally { await browser.close(); }
