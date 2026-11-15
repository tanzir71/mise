import { test, expect } from '@playwright/test';

for (const region of ['bd', 'intl']) {
  test(`${region} product images follow the desktop reference layout`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${region}/`);
    await page.evaluate(() => document.fonts.ready);
    const detailImages = page.locator('.detail-visual img');
    for (let i = 0; i < 12; i++) {
      const image = detailImages.nth(i);
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(image => (image as HTMLImageElement).decode());
      const bounds = (await image.boundingBox())!;
      expect(Math.abs(bounds.width - 680)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.height - 500)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.x - (i % 2 === 0 ? 120 : 640))).toBeLessThanOrEqual(1);
      await expect(image.locator('..')).toHaveCSS('box-shadow', 'none');
    }
    await expect(page.locator('.day-shots figure')).toHaveCount(6);
    const dayImages = page.locator('.day-visual img');
    for (const image of await dayImages.all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(image => (image as HTMLImageElement).decode());
      expect(Math.abs((await image.boundingBox())!.width - 235.5)).toBeLessThanOrEqual(1);
    }
    const lastDayImage = (await dayImages.last().boundingBox())!;
    expect(lastDayImage.x + lastDayImage.width).toBeLessThanOrEqual(1440);
    await expect(page.locator('.day-shots')).toHaveCSS('overflow-x', 'visible');
    for (const image of await page.locator('.business-shot img').all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(image => (image as HTMLImageElement).decode());
      const bounds = (await image.boundingBox())!;
      expect(Math.abs(bounds.width - 251)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.height - 406)).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('.business-number')).toHaveCount(0);
    await expect(page.locator('.business-copy').first()).toHaveCSS('border-top-width', '0px');
  });
}

for (const width of [360, 375, 390, 414]) {
  test(`day pictures scroll within the page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('bd/');
    await page.evaluate(() => document.fonts.ready);
    const row = page.getByRole('region', { name: 'A day with Mise product images' });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toHaveCSS('scroll-snap-type', 'x mandatory');
    await expect(row).toHaveCSS('gap', '16px');
    expect(Math.abs((await page.locator('.day-visual img').first().boundingBox())!.width - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs((await page.locator('.day-shots figure').first().boundingBox())!.x - 20)).toBeLessThanOrEqual(1);
    await row.focus();
    for (let i = 0; i < 8; i++) await row.press('ArrowRight');
    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
