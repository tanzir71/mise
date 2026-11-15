import { test, expect } from '@playwright/test';

const surfaces = {
  features: 'rgb(255, 255, 255)', ai: 'rgb(255, 255, 255)', ocr: 'rgb(237, 237, 236)',
  capture: 'rgb(20, 20, 20)', checks: 'rgb(255, 255, 255)', detail: 'rgb(255, 255, 255)',
  day: 'rgb(20, 20, 20)', businesses: 'rgb(255, 255, 255)', basics: 'rgb(237, 237, 236)',
  compare: 'rgb(255, 255, 255)', cta: 'rgb(20, 20, 20)',
};
for (const region of ['bd', 'intl']) {
  test(`${region} follows the refinement type and surface rules`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${region}/`);
    for (const [id, color] of Object.entries(surfaces)) {
      await expect(page.locator('#'+id)).toHaveCSS('background-color', color);
      if (id !== 'features') {
        await expect(page.locator(`#${id} h2`)).toHaveCSS('font-size', id === 'cta' ? '48px' : '40px');
        await expect(page.locator(`#${id} h2`)).toHaveCSS('font-weight', '400');
      }
    }
    const gradients = await page.locator('body *').evaluateAll(elements => elements.filter(element => getComputedStyle(element).backgroundImage.includes('gradient(')).map(element => element.className));
    expect(gradients).toEqual([]);
    expect(await page.locator('h1, h2, .detail-copy h3').evaluateAll(elements => Math.max(...elements.map(element => parseFloat(getComputedStyle(element).fontSize))))).toBeLessThanOrEqual(56);
    await expect(page.locator('.permissions-top, .permissions-footer, .cta-mark, .footer-brand')).toHaveCount(0);
    const before = (await page.locator('.ocr-input').first().boundingBox())!;
    const after = (await page.locator('.ocr-output').first().boundingBox())!;
    expect(after.x).toBeGreaterThan(before.x + before.width);
    await expect(page.locator('.capture-table')).toHaveCSS('border-top-width', '1px');
    await expect(page.locator('.site-footer a', { hasText: 'Setup and downloads' })).toHaveCount(1);
  });
}
