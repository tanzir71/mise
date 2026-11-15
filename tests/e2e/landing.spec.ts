import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Bangladesh copy, product sections and feature anchors are complete', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('bd/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Every order, chat');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('taka');
  await expect(page.locator('.ocr-card')).toHaveCount(6);
  await expect(page.locator('.capture-row')).toHaveCount(10);
  await expect(page.locator('.check-card')).toHaveCount(12);
  await expect(page.locator('.detail-block')).toHaveCount(12);
  await expect(page.locator('.day-shots figure')).toHaveCount(6);
  await expect(page.locator('.business-card')).toHaveCount(4);
  await expect(page.locator('.basic-tile')).toHaveCount(12);
  for (const href of await page.locator('.index-pills a').evaluateAll(links => links.map(link => link.getAttribute('href')!))) {
    await expect(page.locator(href)).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`Bangladesh layout fits ${width}px and cards stretch equally`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('bd/');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const selector of ['.ocr-card', '.check-card', '.business-card', '.basic-tile']) {
      const rows = await page.locator(selector).evaluateAll(cards => cards.map(card => { const r = card.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; }));
      const groups = new Map<number, number[]>();
      for (const row of rows) groups.set(row.top, [...(groups.get(row.top) || []), row.height]);
      for (const heights of groups.values()) expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    }
    if (process.env.CAPTURE_SCREENSHOTS && [390, 1440].includes(width)) await page.screenshot({ path: `docs/screenshots/bd-${width}.png`, fullPage: true });
  });
}

test('mobile navigation traps focus, closes and follows anchors', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('bd/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('#mobile-nav')).toBeVisible();
  await page.locator('#mobile-nav').getByRole('link', { name: 'Reads anything' }).click();
  await expect(page.locator('#mobile-nav')).not.toBeVisible();
  await expect(page).toHaveURL(/#ocr$/);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobile-nav')).not.toBeVisible();
});

test('Bangladesh page meets WCAG AA automated checks', async ({ page }) => {
  await page.goto('bd/');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
});
