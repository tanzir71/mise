import { test, expect } from '@playwright/test';

test('landing and app are available', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/Mise/);
  await page.goto('app/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your next shift');
});
