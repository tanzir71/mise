import { test, expect } from '@playwright/test';
import assets from '../../handover/exports/landing-assets.json';

declare global { interface Window { miseCLS: number; } }

for (const region of ['bd', 'intl'] as const) {
  test(`${region} uses the complete Figma picture set with sharp source variants`, async ({ page }) => {
    await page.addInitScript(() => {
      const state = window;
      state.miseCLS = 0;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) { const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!shift.hadRecentInput) state.miseCLS += shift.value; } }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${region}/`);
    const expected = assets[region];
    const definitions = [expected.hero, ...expected.detail, ...expected.day, ...expected.businesses];
    await expect(page.locator('picture img[data-shot]')).toHaveCount(23);
    expect(await page.locator('svg').count()).toBeLessThanOrEqual(120);
    const pictures = await page.locator('picture img[data-shot]').evaluateAll(images => images.map(element => {
      const image = element as HTMLImageElement;
      return { slot: image.dataset.shot, alt: image.alt, decoding: image.decoding, loading: image.loading,
        width: Number(image.getAttribute('width')), height: Number(image.getAttribute('height')),
        sources: Array.from(image.parentElement!.querySelectorAll('source')).map(source => ({ type: source.type, variants: source.srcset.split(',').length })) };
    }));
    for (const definition of definitions) {
      const picture = pictures.find(image => image.slot === `${region}/${definition.slot}`)!;
      expect(picture).toBeDefined();
      expect(picture.alt).toBe(definition.alt);
      expect(picture.decoding).toBe('async');
      expect(picture.loading).toBe(definition.slot === 'hero.visual' ? 'eager' : 'lazy');
      expect(picture.width).toBeGreaterThan(0);
      expect(picture.height).toBeGreaterThan(0);
      expect(picture.sources).toEqual([{ type: 'image/avif', variants: 2 }, { type: 'image/webp', variants: 2 }]);
    }
    const hero = page.locator(`img[data-shot="${region}/hero.visual"]`);
    await expect(hero).toHaveAttribute('fetchpriority', 'high');
    await expect(hero).toBeVisible();
    expect(await hero.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await hero.evaluate(image => (image as HTMLImageElement).decode());
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => window.miseCLS)).toBeLessThan(0.05);
  });
}
