import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Dhaka visitors reach Bangladesh and query preserves campaign/hash', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Dhaka' });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page).toHaveURL(/\/bd\/$/);
  await page.goto(`${baseURL}?region=intl&utm_source=smoke#features`);
  await expect(page).toHaveURL(/\/intl\/\?region=intl&utm_source=smoke#features$/);
  expect(await page.evaluate(() => localStorage.getItem('mise.region'))).toBe('intl');
  await page.goto(baseURL!);
  await expect(page).toHaveURL(/\/intl\/$/);
  await context.close();
});

test('other timezones choose international; manual region choice is remembered', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'Europe/London', locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page).toHaveURL(/\/intl\/$/);
  await page.locator('.site-header .region-picker summary').click();
  await page.locator('.site-header [data-region="bd"]').click();
  await expect(page).toHaveURL(/\/bd\/$/);
  await page.goto(baseURL!);
  await expect(page).toHaveURL(/\/bd\/$/);
  await context.close();
});

test('root works without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page.getByRole('link', { name: 'Bangladesh · English', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'International · English', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('payment');
  await context.close();
});

test('blocked browser storage does not prevent routing or switching', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Dhaka' });
  await context.addInitScript(() => Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Blocked', 'SecurityError'); } }));
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page).toHaveURL(/\/bd\/$/);
  await page.locator('.site-header .region-picker summary').click();
  await page.locator('.site-header [data-region="intl"]').click();
  await expect(page).toHaveURL(/\/intl\/$/);
  await context.close();
});

test('international content and SEO use the same complete layout', async ({ page, baseURL }) => {
  await page.goto('intl/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('payment');
  await expect(page.locator('.hero-trust')).toContainText('DoorDash');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/intl\/$/);
  await expect(page.locator('link[hreflang="en-BD"]')).toHaveAttribute('href', /\/bd\/$/);
  await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute('href', new RegExp(new URL(baseURL!).pathname + '$'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
