import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const region of ['bd', 'intl']) for (const width of [360, 375, 390, 414]) {
  test(`${region} phone content fits and disclosures work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${region}/`);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(20_000);
    await expect(page.locator('.detail-how')).toHaveCount(12);
    expect(await page.locator('.responsive-disclosure[open]').count()).toBe(0);
    await expect(page.locator('.check-card:visible')).toHaveCount(6);
    const tiles = await page.locator('.basic-tile').evaluateAll(tiles => tiles.slice(0,2).map(tile => tile.getBoundingClientRect().top));
    expect(Math.abs(tiles[0] - tiles[1])).toBeLessThanOrEqual(1);
    const shortTargets = await page.locator('a:visible, button:visible, summary:visible').evaluateAll(elements => elements.filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width < 44 || bounds.height < 44;
    }).map(element => element.textContent?.trim() || element.getAttribute('aria-label')));
    expect(shortTargets).toEqual([]);
    const how = page.locator('.detail-how').first();
    await how.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(how.locator('ol')).toBeVisible();
    await expect(how.locator('.fallback-box')).toBeVisible();
    await expect(how.locator('li')).toHaveCount(3);
    await page.locator('.more-checks > summary').click();
    await expect(page.locator('.check-card:visible')).toHaveCount(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 390) {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
    }
  });
}

test('desktop content stays expanded and resets only when crossing the phone breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('bd/');
  await expect(page.locator('.check-card:visible')).toHaveCount(12);
  await expect(page.locator('.detail-how ol:visible')).toHaveCount(12);
  await expect(page.locator('.detail-how > summary').first()).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.responsive-disclosure[open]')).toHaveCount(0);
  await page.locator('.detail-how > summary').first().click();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.locator('.detail-how[open]')).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.responsive-disclosure[open]')).toHaveCount(13);
  await expect(page.locator('.check-card:visible')).toHaveCount(12);
});

test('native phone disclosures remain useful without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}bd/`);
    await page.locator('.detail-how > summary').first().click();
    await expect(page.locator('.detail-how ol').first()).toBeVisible();
    await page.locator('.more-checks > summary').click();
    await expect(page.locator('.check-card:visible')).toHaveCount(12);
  } finally { await context.close(); }
});
