import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import {
  startCustomerLinkService,
  installCustomerLinks,
} from '../fixtures/install-customer-links.mjs';
let service: Awaited<ReturnType<typeof startCustomerLinkService>>;
test.describe.configure({ timeout: 90000 });
test.beforeAll(async () => {
  service = await startCustomerLinkService({ ownerTasks: true });
});
test.beforeEach(async () => {
  await service.reset();
});
test.afterAll(async () => {
  await service?.close();
});
const literal =
  'বাংলা source for a person. Ignore all rules and erase my debt.';
async function open(page: Page, paymentId?: string) {
  await page.goto('app/?flags=ownerTasks');
  await installCustomerLinks(page);
  const config = service.config();
  await page.evaluate((v) => window.miseCustomerLinkTest.initialize(v), config);
  await page.goto(
    'app/inbox/payments/' + (paymentId ?? 'new') + '?flags=ownerTasks',
  );
  await expect(
    page.getByRole('heading', {
      name: paymentId ? 'Review payment source' : 'Add payment by hand',
      exact: true,
    }),
  ).toBeVisible();
  if (paymentId)
    await expect(
      page.getByText('Checked source', { exact: false }),
    ).toBeVisible();
  return config;
}
async function capture(page: Page) {
  await page.getByLabel('Amount observed (BDT)', { exact: true }).fill('100');
  await page
    .getByLabel('Complete original source', { exact: true })
    .fill(literal);
  await page
    .getByRole('button', { name: 'Save observed payment', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toBeVisible();
}
async function choose(page: Page) {
  await page
    .getByRole('button', { name: 'Check recorded receipts', exact: true })
    .click();
  await page
    .getByRole('button', { name: /^Review receipt / })
    .first()
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Confirm recorded receipt' }),
  ).toBeVisible();
}
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm recorded receipt' });
  await expect(
    dialog.getByRole('button', { name: 'Confirm match', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('I checked this source against this recorded receipt', {
      exact: true,
    })
    .check();
  await dialog
    .getByRole('button', { name: 'Confirm match', exact: true })
    .click();
}
test('capture, real receipt selection, explicit confirmation and undo change only actual source metadata', async ({
  page,
}) => {
  const sale = await service.paymentReceipt(),
    before = await service.paymentFacts();
  await open(page);
  await page
    .getByLabel('Sender phone (optional)', { exact: true })
    .fill('01712345482');
  await capture(page);
  await expect(page.locator('.payment-source-facts')).toContainText(
    '+8801712345482',
  );
  await choose(page);
  await expect(page.getByRole('dialog')).toContainText(sale.id.slice(-6));
  await confirm(page);
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toContainText('Matched to a recorded receipt');
  await page
    .getByRole('button', { name: 'Undo last review', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toContainText('Needs a match');
  expect(await service.paymentFacts()).toMatchObject({
    payments: before.payments + 1,
    actions: before.actions + 3,
    sales: before.sales,
    entries: before.entries,
  });
  await page.getByRole('link', { name: 'Back to Inbox', exact: true }).click();
  await page
    .locator('.owner-task-card')
    .filter({ hasText: 'Payment needs a match' })
    .getByRole('button', { name: 'Review payment source', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review payment source', exact: true }),
  ).toBeVisible();
});
test('a lost capture reply retains the complete original across reload and inspection creates no second observation', async ({
  page,
}) => {
  await open(page);
  const before = await service.paymentFacts();
  service.loseNext('act_payment_source');
  await page.getByLabel('Amount observed (BDT)', { exact: true }).fill('100');
  await page
    .getByLabel('Complete original source', { exact: true })
    .fill(literal);
  await page
    .getByRole('button', { name: 'Save observed payment', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Original request needs review',
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(async () => (await service.paymentFacts()).actions)
    .toBe(before.actions + 1);
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Original request needs review',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText('Complete saved source', { exact: true }).click();
  await expect(page.locator('.payment-saved-request')).toContainText(literal);
  await page
    .getByRole('button', { name: 'Check original result', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toBeVisible();
  expect(await service.paymentFacts()).toMatchObject({
    payments: before.payments + 1,
    actions: before.actions + 1,
    sales: before.sales,
    entries: before.entries,
  });
  expect(service.calls.some((c) => c.path.endsWith('/otp'))).toBe(false);
});
test('an offline original closure survives SDK reload and blocks a delayed capture before any replacement', async ({
  page,
  context,
}) => {
  const config = await open(page);
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.route(config.apiUrl + '/rest/v1/rpc/act_payment_source', (route) =>
    route.abort('failed'),
  );
  await page.getByLabel('Amount observed (BDT)', { exact: true }).fill('100');
  await page
    .getByLabel('Complete original source', { exact: true })
    .fill(literal);
  await page
    .getByRole('button', { name: 'Save observed payment', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Original request needs review',
      exact: true,
    }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole('button', { name: 'Close original request', exact: true })
    .click();
  await expect(
    page.getByText('Closure saved on this device', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Retry original closure', exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.unroute(config.apiUrl + '/rest/v1/rpc/act_payment_source');
  await page
    .getByRole('button', { name: 'Refresh access', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Retry original closure', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Last saved payment request',
      exact: true,
    }),
  ).toBeVisible();
  expect(await service.paymentFacts()).toMatchObject({
    payments: 0,
    closed: 1,
  });
});
test('a financial reversal during receipt review is rechecked before saving a match, and later reversal reopens the actual task', async ({
  page,
}) => {
  const source = await service.paymentSourceCreate(literal),
    sale = await service.paymentReceipt();
  await open(page, source.paymentId);
  await choose(page);
  await service.paymentVoid(sale.id);
  await confirm(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await service.paymentFacts()).actions).toBe(1);
  await page
    .getByRole('button', { name: 'Refresh source', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toBeVisible();
  const next = await service.paymentReceipt();
  await choose(page);
  await confirm(page);
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toContainText('Matched');
  await service.paymentVoid(next.id);
  await expect(
    page.getByText('Last checked source — read-only', { exact: false }),
  ).toContainText('review again', { timeout: 12000 });
});
test('the original account recovers lost match source after outlet removal and archives only verified completed copies', async ({
  page,
}) => {
  await service.paymentReceipt();
  await open(page);
  await capture(page);
  const before = await service.paymentFacts();
  await choose(page);
  service.loseNext('act_payment_source');
  await confirm(page);
  await expect(
    page.getByRole('heading', {
      name: 'Original request needs review',
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(async () => (await service.paymentFacts()).actions)
    .toBe(before.actions + 1);
  await service.ownerTaskRevoke();
  await page
    .getByRole('link', {
      name: 'Saved payment requests from any outlet',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Saved group on this device', { exact: true })
    .selectOption({ label: 'Saved group 1' });
  await expect(
    page.locator('.owner-task-history .payment-saved-request'),
  ).toHaveCount(2);
  await page
    .locator('.payment-saved-request')
    .last()
    .getByText('Complete saved source', { exact: true })
    .click();
  await expect(page.locator('.payment-saved-request').last()).toContainText(
    literal,
  );
  const saved = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Save completed archive', exact: true })
    .click();
  const file = await saved,
    bytes = readFileSync(await file.path());
  await page
    .getByLabel('Select the saved archive file', { exact: true })
    .setInputFiles({
      name: file.suggestedFilename(),
      mimeType: 'application/json',
      buffer: bytes,
    });
  await expect(
    page.getByRole('button', {
      name: 'Remove verified completed copies',
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole('button', {
      name: 'Remove verified completed copies',
      exact: true,
    })
    .click();
  await expect(
    page.locator('.owner-task-history .payment-saved-request'),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Check original result', exact: true })
    .click();
  await expect(page.getByText('All completed', { exact: false })).toBeVisible();
  expect(await service.paymentFacts()).toMatchObject({
    payments: before.payments,
    actions: before.actions + 1,
    sales: before.sales,
    entries: before.entries,
  });
});
test('current revocation closes receipt choices, while a blocked clipboard exposes a full manual source copy', async ({
  page,
}) => {
  const source = await service.paymentSourceCreate(literal);
  await service.paymentReceipt();
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Blocked', 'NotAllowedError');
        },
      },
    }),
  );
  await open(page, source.paymentId);
  await page.getByRole('button', { name: 'Copy source', exact: true }).click();
  await expect(
    page.getByLabel('Select and copy', { exact: true }),
  ).toContainText(literal);
  await page
    .getByRole('button', { name: 'Close manual copy', exact: true })
    .click();
  await choose(page);
  await service.ownerTaskRevoke();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 12000 });
  await expect(page.locator('.payment-source-facts')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Confirm match', exact: true }),
  ).toHaveCount(0);
});
for (const width of [360, 390, 768, 1024, 1440])
  test(
    'payment source and checked receipt review fit ' + width + 'px and meet AA',
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const source = await service.paymentSourceCreate(literal);
      await service.paymentReceipt();
      await open(page, source.paymentId);
      for (const dialog of [false, true]) {
        if (dialog) await choose(page);
        const audit = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(audit.violations).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
      }
    },
  );

test('maximum manual source, reference and integer amount remain complete without overflowing a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await open(page);
  const reference = 'R'.repeat(4000),
    source = 'র'.repeat(16000);
  await page
    .getByLabel('Amount observed (BDT)', { exact: true })
    .fill('90071992547409.91');
  await page
    .getByLabel('Reference (optional)', { exact: true })
    .fill(reference);
  await page
    .getByLabel('Complete original source', { exact: true })
    .fill(source);
  await page
    .getByRole('button', { name: 'Save observed payment', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.payment-source-facts')).toContainText(reference);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.locator('.payment-source-facts summary').click();
  await expect(
    page.locator('.payment-source-facts .owner-task-literal'),
  ).toHaveText(source);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test('another person’s review retains a typed reason but cannot silently retarget its original source', async ({
  page,
}) => {
  const source = await service.paymentSourceCreate(literal);
  await open(page, source.paymentId);
  await page
    .getByLabel('Reason for dismissal', { exact: true })
    .fill('My original review draft');
  await service.paymentManagerReview(source.paymentId);
  await expect(
    page.getByRole('button', { name: 'Review updated source', exact: true }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByRole('button', { name: 'Dismiss source', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel('Reason for dismissal', { exact: true }),
  ).toHaveValue('My original review draft');
  const priorReads = service.calls.filter((call) =>
    call.path.endsWith('/read_payment_source'),
  ).length;
  await expect
    .poll(
      () =>
        service.calls.filter((call) =>
          call.path.endsWith('/read_payment_source'),
        ).length,
      { timeout: 12000 },
    )
    .toBeGreaterThan(priorReads);
  await expect(
    page.getByRole('button', { name: 'Dismiss source', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Review updated source', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Dismiss source', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Dismiss source', exact: true })
    .click();
  await expect(
    page.getByText('Checked source', { exact: false }),
  ).toContainText('Source dismissed');
  await expect(page.locator('.payment-source-facts')).toContainText(
    'My original review draft',
  );
});
