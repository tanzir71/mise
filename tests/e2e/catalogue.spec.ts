import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function start(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('app/');
  await page.getByRole('radio', { name: /^Restaurant/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /^Bangladesh/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Shop name', { exact: true }).fill('Catalogue test');
  await page.getByLabel('Phone number', { exact: true }).fill('01712345482');
  await page.getByRole('button', { name: 'Open Mise', exact: true }).click();
  await page.locator('.app-sidebar a[href$="/more"]:visible,.app-bottom-nav a[href$="/more"]:visible').click();
  await page.locator('.app-main a[href$="/catalogue"]').click();
  await expect(page.locator('.catalogue-page')).toHaveAttribute('aria-busy', 'false');
}
for (const width of [390, 1440]) {
  test(`catalogue CRUD and availability work at ${width}px`, async ({ page }) => {
    await start(page, width);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const form = page.locator('.item-editor-form:visible');
    await form.getByLabel('Name', { exact: true }).fill('Lemon tea');
    await form.getByLabel('Local name', { exact: true }).fill('লেবু চা');
    await form.getByLabel('Price (BDT)', { exact: true }).fill('25.50');
    await form.getByLabel('Category', { exact: true }).fill('Drinks');
    await form.getByRole('checkbox', { name: 'Often bought', exact: true }).check();
    await form.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit item: Lemon tea', exact: true })).toContainText('৳25.50');
    const toggle = page.getByRole('switch', { name: 'Available: Lemon tea', exact: true });
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
    if (width === 390) {
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      });
      await page.context().setOffline(true);
    }
    await page.getByRole('button', { name: 'Edit item: Lemon tea', exact: true }).click();
    await form.getByLabel('Price (BDT)', { exact: true }).fill('30');
    await form.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit item: Lemon tea', exact: true })).toContainText('৳30');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Available: Lemon tea', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Edit item: Lemon tea', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: 'Delete item', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Available: Lemon tea', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
test('bulk paste previews invalid rows, adds 200 valid items and searches them', async ({ page }) => {
  await start(page, 1440);
  await page.getByRole('button', { name: 'Paste a list', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add many at once', exact: true });
  await dialog.getByRole('textbox', { name: 'Paste a list', exact: true }).fill('Tea, nope');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Add 1 items', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('Fix invalid rows');
  await dialog.getByRole('textbox', { name: 'Paste a list', exact: true }).fill(Array.from({ length: 200 }, (_, index) => `Product ${index}, ${index + 1}.50`).join('\n'));
  await dialog.getByRole('textbox', { name: 'Category', exact: true }).fill('Imported');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('region', { name: 'Preview', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => dialog.locator('.paste-preview').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Add 200 items', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(203);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('Product 125');
  await expect(page.getByRole('switch')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit item: Product 125', exact: true })).toBeVisible();
});
for (const width of [360, 390, 768, 1024, 1440]) {
  test(`catalogue and editor fit ${width}px`, async ({ page }) => {
    await start(page, width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: 'Edit item: Sample dish', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if ([390, 1440].includes(width)) {
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => ({ target: node.target, reason: node.failureSummary })) }))).toEqual([]);
    }
  });
}
