import { test, expect } from '@playwright/test';
import assets from '../../handover/exports/landing-assets.json';

for (const region of ['bd', 'intl'] as const) {
  test(`${region} uses the complete Figma picture set with sharp source variants`, async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as Window & { miseCLS: number };
      state.miseCLS = 0;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) { const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!shift.hadRecentInput) state.miseCLS += shift.value; } }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${region}/`);
    const expected = assets[region];
    const definitions = [expected.hero, ...expected.detail, ...expected.day, ...expected.businesses];
    await expect(page.locator('picture img[data-shot]')).toHaveCount(23);
    expect(await page.locator('svg').count()).toBeLessThanOrEqual(120);
    for (const definition of definitions) {
      const image = page.locator(`img[data-shot="${region}/${definition.slot}"]`);
      await expect(image).toHaveAttribute('alt', definition.alt);
      await expect(image).toHaveAttribute('decoding', 'async');
      await expect(image).toHaveAttribute('loading', definition.slot === 'hero.visual' ? 'eager' : 'lazy');
      expect(Number(await image.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(await image.getAttribute('height'))).toBeGreaterThan(0);
      const sources = image.locator('..').locator('source');
      await expect(sources).toHaveCount(2);
      await expect(sources.nth(0)).toHaveAttribute('type', 'image/avif');
      await expect(sources.nth(1)).toHaveAttribute('type', 'image/webp');
      expect((await sources.nth(0).getAttribute('srcset'))?.split(',')).toHaveLength(2);
    }
    const hero = page.locator(`img[data-shot="${region}/hero.visual"]`);
    await expect(hero).toHaveAttribute('fetchpriority', 'high');
    await expect(hero).toBeVisible();
    expect(await hero.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await hero.evaluate(image => (image as HTMLImageElement).decode());
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => (window as Window & { miseCLS: number }).miseCLS)).toBeLessThan(0.05);
  });
}
