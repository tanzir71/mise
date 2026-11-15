import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
const fixture = { updatedAt: '2026-11-15T08:00:00Z', items: [
  { id: 'extension', name: 'Chrome extension', version: '0.5.0', file: '0.5.0/mise-extension-0.5.0.zip', latest: 'latest/mise-extension.zip', bytes: 421888, sha256: 'a'.repeat(64), minApp: '0.5.0' },
  { id: 'order-phone', name: 'Android order phone', version: '0.5.0', file: '0.5.0/mise-order-phone-0.5.0.apk', latest: 'latest/mise-order-phone.apk', bytes: 8808038, sha256: 'b'.repeat(64), minApp: '0.5.0', minAndroid: '8.0' },
] };
const browser = await chromium.launch();
mkdirSync('docs/screenshots', { recursive: true });
try {
  for (const sample of [false, true]) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    if (sample) await page.route('**/downloads/manifest.json', route => route.fulfill({ json: fixture }));
    await page.goto(`${origin}setup/`);
    await page.locator('#manifest-status').filter({ hasText: sample ? '2 device builds' : 'coming in a later version' }).waitFor({ state: 'attached' });
    await page.evaluate(() => document.fonts.ready);
    const prefix = `docs/screenshots/r6-setup-${sample ? 'sample' : 'live'}`;
    await page.screenshot({ path: `${prefix}-${width}.png`, fullPage: true });
    if (width === 1440) await page.screenshot({ path: `${prefix}-hero.png` });
    console.log(JSON.stringify({ sample, width, ...await page.evaluate(() => ({ height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth })) }));
    await page.close();
  }
} finally { await browser.close(); }
