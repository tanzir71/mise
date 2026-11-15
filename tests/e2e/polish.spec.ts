import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';

test('marketing JS stays small and root routing stays below 2KB', async () => {
  for (const region of ['', 'bd/', 'intl/']) {
    const html = readFileSync(`site/${region}index.html`, 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(Boolean);
    const bytes = scripts.reduce((total, script) => total + gzipSync(script).length, 0);
    expect(bytes).toBeLessThan(region ? 30 * 1024 : 2 * 1024);
    expect(html).toContain('Content-Security-Policy');
  }
});

test('social images, sitemap and placeholder app handoff work', async ({ page, request, baseURL }) => {
  await page.goto('intl/');
  const og = await page.locator('meta[property="og:image"]').getAttribute('content');
  const ogPath = new URL(og!).pathname.split('/').pop();
  const image = await request.get(`${baseURL}${ogPath}`);
  expect(image.ok()).toBeTruthy();
  expect(image.headers()['content-type']).toContain('image/png');
  expect((await request.get(`${baseURL}robots.txt`)).ok()).toBeTruthy();
  expect((await request.get(`${baseURL}sitemap.xml`)).ok()).toBeTruthy();
  await page.locator('.hero-actions').getByRole('link', { name: 'Start free' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your next shift');
});

test('unconfigured contact CTA gives an honest, dismissible next step', async ({ page }) => {
  await page.goto('bd/#cta');
  await page.getByRole('link', { name: 'Chat with us on WhatsApp', exact: true }).click();
  await expect(page.locator('#availability')).toBeVisible();
  await expect(page.locator('#availability')).toContainText('The working app is coming');
  await page.locator('#availability').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#availability')).not.toBeVisible();
});

for (const route of ['bd/', 'intl/', 'setup/']) {
  test(`${route} is accessible on phones`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
  });
}
