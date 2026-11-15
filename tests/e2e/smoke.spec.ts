import { test, expect } from '@playwright/test';

test('landing and app are available', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/Mise/);
  await page.goto('app/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your next shift');
});

test('UI gallery is opt-in and renders Bengali examples', async ({ page }) => {
  await page.goto('app/_ui');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your next shift');
  await page.goto('app/_ui?flags=uiGallery');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mise UI');
  await expect(page.getByText('আপনার দোকান · ৳১,১২,৮৪০')).toBeVisible();
  await page.getByRole('button', { name: /Primary/ }).focus();
  await expect(page.getByRole('button', { name: /Primary/ })).toBeFocused();
});
