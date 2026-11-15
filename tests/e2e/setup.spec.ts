import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const fixture = { updatedAt: '2026-11-15T08:00:00Z', items: [
  { id: 'extension', name: 'Chrome extension', version: '0.5.0', file: '0.5.0/mise-extension-0.5.0.zip', latest: 'latest/mise-extension.zip', bytes: 421888, sha256: 'a'.repeat(64), minApp: '0.5.0' },
  { id: 'order-phone', name: 'Android order phone', version: '0.5.0', file: '0.5.0/mise-order-phone-0.5.0.apk', latest: 'latest/mise-order-phone.apk', bytes: 8808038, sha256: 'b'.repeat(64), minApp: '0.5.0', minAndroid: '8.0' },
] };

test('empty manifest is honest and app cards link to the placeholder', async ({ page }) => {
  await page.goto('setup/');
  await expect(page.locator('#manifest-status')).toHaveText('Device builds are coming in a later version.');
  await expect(page.locator('.download-link:visible')).toHaveCount(0);
  await expect(page.locator('.downloads-grid').getByRole('link', { name: 'Open the app' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Install Mise on your devices', exact: true })).toBeVisible();
  await expect(page.getByText('Allow from this source', { exact: true })).toBeVisible();
  await expect(page.locator('#android-install')).toContainText('Unknown sources');
  await page.locator('.downloads-grid').getByRole('link', { name: 'Set up kitchen' }).click();
  await expect(page.locator('#kitchen-install')).toHaveAttribute('open');
});

test('two-item manifest produces stable download URLs and copyable checksums', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/downloads/manifest.json', route => route.fulfill({ json: fixture }));
  await page.goto('setup/');
  await expect(page.locator('#manifest-status')).toHaveText('2 device builds available');
  await expect(page.locator('[data-download="extension"] .download-link')).toHaveAttribute('href', `${new URL(baseURL!).pathname}downloads/latest/mise-extension.zip`);
  await expect(page.locator('.setup-desktop [data-download="order-phone"] .download-link')).toHaveAttribute('href', `${new URL(baseURL!).pathname}downloads/latest/mise-order-phone.apk`);
  await page.locator('[data-download="extension"] .checksum summary').click();
  await page.locator('[data-download="extension"]').getByRole('button', { name: 'Copy checksum' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a'.repeat(64));
  await expect(page.locator('.setup-desktop [data-download="order-phone"] .download-meta')).toContainText('Android 8.0+');
  await page.getByRole('button', { name: 'Copy prompt for your agent' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Deploy my own copy of Mise');
});

test('manifest failure is recoverable and clipboard failure has a manual fallback', async ({ page }) => {
  let calls = 0;
  await page.route('**/downloads/manifest.json', route => ++calls === 1 ? route.abort() : route.fulfill({ json: fixture }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } }));
  await page.goto('setup/');
  await expect(page.locator('#manifest-status')).toContainText('Couldn’t check');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#manifest-status')).toHaveText('2 device builds available');
  await page.getByRole('button', { name: 'Copy prompt for your agent' }).click();
  await expect(page.locator('#copy-fallback')).toBeVisible();
  await expect(page.locator('#copy-text')).toHaveValue(/Deploy my own copy/);
});

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`setup fits ${width}px including long checksums`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/downloads/manifest.json', route => route.fulfill({ json: fixture }));
    await page.goto('setup/');
    if (width < 768) await page.locator('.setup-all-devices > summary').click();
    await expect(page.locator('#manifest-status')).toHaveText('2 device builds available');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (process.env.CAPTURE_SCREENSHOTS && [390, 1440].includes(width)) await page.screenshot({ path: `docs/screenshots/setup-sample-${width}.png`, fullPage: true });
  });
}

test('phone shows the five-step guide and a real manifest download, with all-device guides reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/downloads/manifest.json', route => route.fulfill({ json: fixture }));
  await page.goto('setup/');
  await expect(page.getByRole('heading', { name: 'Set up the order phone', exact: true })).toBeVisible();
  await expect(page.locator('.phone-steps > li')).toHaveCount(5);
  await expect(page.locator('.phone-download .download-link')).toBeVisible();
  await expect(page.locator('.setup-all-devices')).not.toHaveAttribute('open');
  await page.locator('.phone-self-host a').click();
  await expect(page.locator('.setup-all-devices')).toHaveAttribute('open');
  await expect(page.getByRole('heading', { name: 'Run your own copy on Vercel', exact: true })).toBeInViewport();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('setup is accessible and the self-hosting links are valid', async ({ page, request, baseURL }) => {
  await page.goto('setup/');
  await expect(page.locator('#manifest-status')).toContainText('later version');
  const href = await page.getByRole('link', { name: 'Deploy to Vercel' }).getAttribute('href');
  expect(new URL(href!).searchParams.get('repository-url')).toBe('https://github.com/tanzir71/mise');
  expect((await request.get(`${baseURL}docs/deploy-own-vercel.md`)).ok()).toBeTruthy();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
});
