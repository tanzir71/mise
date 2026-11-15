import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function onboard(page: Page, business = 'Corner shop', market = 'Bangladesh') {
  await page.goto('app/?flags=localApp');
  await page.getByRole('radio', { name: new RegExp(`^${business}`) }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: new RegExp(`^${market}`) }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Shop name', { exact: true }).fill('Rahman Store');
  await page.getByLabel('Phone number', { exact: true }).fill('01712345482');
  await page.getByRole('button', { name: 'Open Mise', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

test('three-step first run stores a profile and adapts the phone navigation to the business', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await onboard(page, 'Restaurant');
  await expect(page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link')).toHaveText(['Today', 'Orders', 'Inbox', 'Stock', 'More']);
  await page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('link', { name: 'More', exact: true }).click();
  await page.getByRole('link', { name: /Business data/ }).click();
  await expect(page.getByRole('heading', { name: 'Business data', exact: true })).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(3);
  await page.getByRole('button', { name: 'Edit item: Sample dish', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete item', exact: true }).click();
  await expect(page.getByRole('switch')).toHaveCount(2);
});

test('desktop settings preserve the shop, change pack nouns and retain samples across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await onboard(page);
  expect(await page.locator('.app-sidebar').evaluate(element => element.getBoundingClientRect().width)).toBe(240);
  await expect(page.locator('.app-sidebar').getByRole('link', { name: 'Price list', exact: true })).toBeVisible();
  await page.locator('.app-sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Business type', exact: true }).selectOption('restaurant');
  await page.getByLabel('Shop name', { exact: true }).fill('Shorshe Kitchen');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved on this device.');
  await expect(page.locator('.app-sidebar').getByRole('link', { name: 'Menu', exact: true })).toBeVisible();
  await page.goto('app/settings/business?flags=localApp');
  await expect(page.getByLabel('Shop name', { exact: true })).toHaveValue('Shorshe Kitchen');
  await expect(page.getByLabel('Phone number', { exact: true })).toHaveValue('+8801712345482');
  await expect(page.getByText('৳1,12,840', { exact: true })).toBeVisible();
});

test('the first loaded app can navigate, reload and save profile changes offline', async ({ page, context, baseURL }) => {
  test.setTimeout(45000);
  await onboard(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  await page.goto(`${baseURL}app/settings/business?flags=localApp`);
  await page.getByLabel('Shop name', { exact: true }).fill('Offline shop');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved on this device.');
  await page.reload();
  await expect(page.getByLabel('Shop name', { exact: true })).toHaveValue('Offline shop');
});

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`app shell fits ${width}px and meets automated AA checks`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await onboard(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if ([390, 1440].includes(width)) {
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => ({ target: node.target, reason: node.failureSummary })) }))).toEqual([]);
    }
  });
}

test('onboarding and profile forms meet automated AA checks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('app/');
  await expect(page.getByRole('radio', { name: /^Corner shop/ })).toBeVisible();
  let result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
  await onboard(page);
  await page.locator('.app-sidebar .sidebar-bottom a[href$="/settings/business"]:visible,.phone-app-header a[href$="/settings/business"]:visible').click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
});
