import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  installCustomerLinks,
  startCustomerLinkService,
} from '../fixtures/install-customer-links.mjs';
import { customerViewerUrl } from '../../packages/core/customer-link-url';
let service: Awaited<ReturnType<typeof startCustomerLinkService>>;
test.describe.configure({ timeout: 90000 });
test.beforeAll(async () => {
  service = await startCustomerLinkService();
});
test.beforeEach(async () => {
  await service.reset();
});
test.afterAll(async () => {
  await service?.close();
});
async function owner(
  page: Page,
  kind: 'order' | 'khata' = 'order',
  role: 1 | 2 = 1,
) {
  await page.goto('app/?flags=customerLinks');
  await installCustomerLinks(page);
  const config = service.config(role);
  await page.evaluate((v) => window.miseCustomerLinkTest.initialize(v), config);
  await page.goto(
    kind === 'order'
      ? 'app/orders/' + config.records.order.id + '?flags=customerLinks'
      : 'app/khata/' + config.records.customer.id + '?flags=customerLinks',
  );
  const controls = page.getByLabel(
    kind === 'order' ? 'Tracking link' : 'Customer khata link',
    { exact: true },
  );
  await expect(
    controls.getByRole('button', { name: 'Create customer link', exact: true }),
  ).toBeEnabled();
  return controls;
}
async function issue(
  page: Page,
  kind: 'order' | 'khata' = 'order',
  role: 1 | 2 = 1,
) {
  const controls = await owner(page, kind, role);
  await controls
    .getByRole('button', { name: 'Create customer link', exact: true })
    .click();
  const field = controls.getByRole('textbox', {
    name:
      (kind === 'order' ? 'Tracking link' : 'Customer khata link') + ' address',
  });
  await expect(field).toHaveValue(/^http/);
  return { controls, url: await field.inputValue() };
}
test('an owner issues once, an account-free customer reads only approved data, and revocation removes the next read', async ({
  page,
  browser,
}) => {
  const { controls, url } = await issue(page),
    config = service.config();
  expect(url).not.toContain(config.publishableKey);
  expect(url).not.toContain(config.jwt);
  expect(url).not.toContain(config.records.customer.phone!);
  const journal = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('mise.customer-links.'))
      .map(([, value]) => value)
      .join(),
  );
  const token = new URL(url).pathname.split('/').at(-1)!;
  expect(journal).not.toContain(token);
  expect(journal).not.toContain(config.apiUrl);
  const context = await browser.newContext(),
    customer = await context.newPage();
  try {
    const requests: {
      path: string;
      auth: boolean;
      apikey: boolean;
      referrer: string | undefined;
    }[] = [];
    customer.on('request', (r) => {
      if (r.url().startsWith(config.apiUrl))
        requests.push({
          path: new URL(r.url()).pathname,
          auth: Boolean(r.headers().authorization),
          apikey: Boolean(r.headers().apikey),
          referrer: r.headers().referer,
        });
    });
    await customer.goto(url);
    await expect(
      customer.getByRole('heading', { name: 'Out with rider', exact: true }),
    ).toBeVisible();
    await expect(
      customer.getByText('Arrival time has not been set', { exact: true }),
    ).toBeVisible();
    for (const value of [
      'PRIVATE CUSTOMER SOURCE',
      'PRIVATE CUSTOMER ADDRESS',
      'PRIVATE CUSTOMER NOTE',
      config.user.phone,
      config.records.customer.phone!,
    ])
      await expect(customer.locator('body')).not.toContainText(value);
    await expect(
      customer.getByRole('link', { name: 'Call shop', exact: true }),
    ).toHaveAttribute('href', 'tel:+14155550199');
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (r) =>
          r.path === '/functions/v1/public-read' &&
          !r.auth &&
          !r.apikey &&
          !r.referrer,
      ),
    ).toBe(true);
    expect(
      await customer.evaluate(async () => ({
        storage: localStorage.length,
        databases: (await indexedDB.databases()).map((v) => v.name),
      })),
    ).toEqual({ storage: 0, databases: [] });
    await controls
      .getByRole('button', { name: 'Revoke this link', exact: true })
      .click();
    await expect(
      controls.getByRole('button', {
        name: 'Create replacement link',
        exact: true,
      }),
    ).toBeEnabled();
    await customer
      .getByRole('button', { name: 'Check now', exact: true })
      .click();
    await expect(
      customer.getByRole('heading', {
        name: 'This link is unavailable. Ask the shop for a current link.',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      customer.getByText(config.records.order.number, { exact: true }),
    ).toHaveCount(0);
    expect(await service.counts()).toMatchObject({
      creates: 1,
      closures: 1,
      active: 0,
    });
  } finally {
    await context.close();
  }
});
test('a committed creation with a lost reply survives reload and requires explicit closure before replacement', async ({
  page,
}) => {
  const controls = await owner(page);
  service.loseNext('create_public_link');
  await controls
    .getByRole('button', { name: 'Create customer link', exact: true })
    .click();
  await expect(
    controls.getByRole('button', { name: 'Close saved attempt', exact: true }),
  ).toBeEnabled();
  expect(await service.counts()).toMatchObject({ creates: 1, active: 1 });
  await page.reload();
  const restored = page.getByLabel('Tracking link', { exact: true });
  await expect(
    restored.getByText(
      'The one-time link secret is unavailable here. Close this link before creating a replacement.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    restored.getByRole('button', { name: 'Create customer link', exact: true }),
  ).toHaveCount(0);
  await restored
    .getByRole('button', { name: 'Close saved attempt', exact: true })
    .click();
  await expect(
    restored.getByRole('button', {
      name: 'Create replacement link',
      exact: true,
    }),
  ).toBeEnabled();
  await restored
    .getByRole('button', { name: 'Create replacement link', exact: true })
    .click();
  await expect(
    restored.getByRole('textbox', { name: 'Tracking link address' }),
  ).toHaveValue(/^http/);
  expect(await service.counts()).toMatchObject({
    creates: 2,
    closures: 1,
    active: 1,
  });
});
test('a committed closure with a lost reply retries its saved event without another closure audit', async ({
  page,
}) => {
  const { controls } = await issue(page);
  service.loseNext('close_public_link_attempt');
  await controls
    .getByRole('button', { name: 'Revoke this link', exact: true })
    .click();
  await expect(
    controls.getByRole('button', { name: 'Retry saved closure', exact: true }),
  ).toBeEnabled();
  await page.reload();
  const restored = page.getByLabel('Tracking link', { exact: true });
  await expect(
    restored.getByRole('button', {
      name: 'Create replacement link',
      exact: true,
    }),
  ).toBeEnabled();
  expect(await service.counts()).toMatchObject({
    creates: 1,
    closures: 1,
    active: 0,
  });
});
test('a reload loses the one-time secret while preserving metadata and manual order sharing', async ({
  page,
}) => {
  await issue(page);
  await page.reload();
  const controls = page.getByLabel('Tracking link', { exact: true });
  await expect(
    controls.getByRole('button', { name: 'Close saved attempt', exact: true }),
  ).toBeEnabled();
  await expect(
    controls.getByRole('textbox', { name: 'Tracking link address' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Share order / price', exact: true }),
  ).toBeEnabled();
});
test('an assigned manager can create a scoped khata link without revealing the owner or customer phone', async ({
  page,
  browser,
}) => {
  const { url } = await issue(page, 'khata', 2),
    context = await browser.newContext(),
    customer = await context.newPage();
  try {
    await customer.goto(url);
    await expect(
      customer.getByRole('heading', { name: /960.*due/ }),
    ).toBeVisible();
    await expect(
      customer.getByText('Sadia Islam', { exact: true }),
    ).toBeVisible();
    await expect(
      customer.getByText('Adjustment', { exact: true }),
    ).toBeVisible();
    await expect(customer.locator('body')).not.toContainText(
      'PRIVATE CUSTOMER NOTE',
    );
    await customer.getByRole('button', { name: 'বাংলা', exact: true }).click();
    await expect(
      customer.getByRole('heading', { name: /960.*বাকি/ }),
    ).toBeVisible();
    await expect(
      customer.getByRole('link', { name: 'দোকানে কল করুন', exact: true }),
    ).toHaveAttribute('href', 'tel:+14155550199');
  } finally {
    await context.close();
  }
});
test('the customer tracker refreshes actual native order changes and survives reopening without an account', async ({
  page,
}) => {
  const cap = await service.issue(),
    base = new URL('app/', test.info().project.use.baseURL as string).pathname,
    url = customerViewerUrl('http://127.0.0.1:4321', base, {
      apiUrl: service.config().apiUrl,
      kind: 'order',
      token: cap.token,
    });
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Out with rider', exact: true }),
  ).toBeVisible();
  await service.status('delivered');
  await expect(
    page.getByRole('heading', { name: 'Delivered', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Delivered', exact: true }),
  ).toBeVisible();
  expect(service.calls.filter((v) => v.path.startsWith('/auth/'))).toHaveLength(
    0,
  );
});
test('wrong-purpose and incomplete customer URLs never open the owner workspace or ask for a phone', async ({
  page,
}) => {
  const cap = await service.issue(),
    base = new URL('app/', test.info().project.use.baseURL as string).pathname,
    url = customerViewerUrl('http://127.0.0.1:4321', base, {
      apiUrl: service.config().apiUrl,
      kind: 'khata',
      token: cap.token,
    });
  await page.goto(url);
  await expect(
    page.getByRole('heading', {
      name: 'This link is unavailable. Ask the shop for a current link.',
      exact: true,
    }),
  ).toBeVisible();
  await page.goto('app/t/incomplete?flags=customerLinks');
  await expect(
    page.getByRole('heading', {
      name: 'This link is unavailable. Ask the shop for a current link.',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: /phone/i })).toHaveCount(0);
  expect(service.calls.filter((v) => v.path.startsWith('/auth/'))).toHaveLength(
    0,
  );
});
for (const width of [360, 390, 768, 1024, 1440]) {
  test(`owner tracking controls fit ${width}px and meet WCAG AA`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await issue(page);
    expect(
      await page.locator('.customer-link-card').evaluate((card) => {
        const notes = card.parentElement!.querySelector<HTMLElement>('.order-notes-card')!;
        return (card as HTMLElement).offsetTop < notes.offsetTop;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(report.violations).toEqual([]);
  });
  test(`customer tracking and khata fit ${width}px and meet WCAG AA`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const base = new URL('app/', test.info().project.use.baseURL as string)
      .pathname;
    for (const kind of ['order', 'khata'] as const) {
      const cap = await service.issue(kind);
      await page.goto(
        customerViewerUrl('http://127.0.0.1:4321', base, {
          apiUrl: service.config().apiUrl,
          kind,
          token: cap.token,
        }),
      );
      await expect(
        page.getByRole('link', { name: 'Call shop', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const report = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(report.violations).toEqual([]);
    }
  });
}
