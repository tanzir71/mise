import { test, expect } from '@playwright/test';
import copyBD from '../../handover/copy/landing.bd.json';
import copyIntl from '../../handover/copy/landing.intl.json';

for (const copy of [copyBD, copyIntl]) {
  test(`${copy.region} calm desktop hero matches the reference geometry`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${copy.region}/`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.hero h1')).toHaveText(copy.hero.headline);
    await expect(page.locator('.hero-lead')).toHaveText(copy.hero.lead);
    await expect(page.locator('.hero-trust')).toHaveText(copy.hero.trustLine);
    await expect(page.locator('.hero')).toHaveCSS('background-color', 'rgb(237, 237, 236)');
    await expect(page.locator('.site-header')).toHaveCSS('background-color', 'rgb(237, 237, 236)');
    await expect(page.locator('.hero h1')).toHaveCSS('font-size', '56px');
    await expect(page.locator('.hero h1')).toHaveCSS('font-weight', '400');
    await expect(page.locator('.hero h1')).toHaveCSS('line-height', '62px');
    const nav = (await page.locator('.site-header').boundingBox())!;
    const hero = (await page.locator('.hero').boundingBox())!;
    const headline = (await page.locator('.hero h1').boundingBox())!;
    const visual = (await page.locator('.hero img').boundingBox())!;
    expect(Math.abs(nav.height - 89)).toBeLessThanOrEqual(1);
    expect(Math.abs(hero.height - 774)).toBeLessThanOrEqual(8);
    expect(Math.abs(headline.x - 120)).toBeLessThanOrEqual(8);
    expect(Math.abs(visual.x + visual.width / 2 - 1030)).toBeLessThanOrEqual(8);
    expect(Math.abs(visual.y - hero.y - 52)).toBeLessThanOrEqual(1);
    await expect(page.locator('.hero picture')).toHaveCount(1);
    await expect(page.locator('.hero .new-chip, .hero .partners, .hero .preview-label')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('®');
    expect(await page.locator('.site-header').evaluate(header => getComputedStyle(header, '::after').opacity)).toBe('0');
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
    await expect(page.locator('.site-header')).toHaveClass(/is-scrolled/);
    expect((await page.locator('.site-header').boundingBox())!.y).toBe(0);
  });
}

for (const width of [360, 390, 768, 1024]) {
  test(`calm hero fits ${width}px with the right device size`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('bd/');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width < 768) {
      await expect(page.locator('.hero h1')).toHaveCSS('font-size', '40px');
      const image = (await page.locator('.hero img').boundingBox())!;
      const actions = (await page.locator('.hero-actions').boundingBox())!;
      const trust = (await page.locator('.hero-trust').boundingBox())!;
      expect(Math.abs(image.width - 240)).toBeLessThanOrEqual(1);
      expect(image.y).toBeGreaterThanOrEqual(actions.y + actions.height);
      expect(trust.y).toBeGreaterThanOrEqual(image.y + image.height);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.locator('#mobile-nav')).toHaveCSS('background-color', 'rgb(237, 237, 236)');
      await expect(page.locator('#mobile-nav nav a').first()).toHaveCSS('font-size', '20px');
      await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
    } else if (width < 1024) {
      await expect(page.locator('.hero h1')).toHaveCSS('font-size', '48px');
      expect(Math.abs((await page.locator('.hero img').boundingBox())!.width - 260)).toBeLessThanOrEqual(1);
    }
  });
}
