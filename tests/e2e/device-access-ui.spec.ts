import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error The existing PNG verification dependency has no declarations.
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import {
  installDeviceUi,
  startDeviceUiService,
} from '../fixtures/install-device-ui.mjs';
import type { startDeviceUiService as ServiceFactory } from '../fixtures/device-ui-service';
let service: Awaited<ReturnType<typeof ServiceFactory>>;
const fixtureOrigin = 'http://127.0.0.1:4321';
test.beforeAll(async () => {
  service = await startDeviceUiService();
});
test.beforeEach(async () => {
  await service.reset();
});
test.afterAll(async () => {
  await service?.close();
});
async function owner(page: Page, role: 1 | 2 = 1) {
  await page.goto('app/?flags=deviceAccess');
  await installDeviceUi(page);
  await page.evaluate(
    (config) => window.miseDeviceUiTest.initialize(config),
    service.config(role),
  );
  await page.goto('app/settings/devices?flags=deviceAccess');
  await expect(
    page.getByRole('button', { name: 'Create pairing code' }),
  ).toBeEnabled();
}
async function invitation(page: Page) {
  await page.getByLabel('Screen name', { exact: true }).fill('Kitchen tablet');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await expect(page.getByLabel('Pairing code', { exact: true })).toBeVisible();
  const image = page.getByAltText('Setup QR for this shared screen');
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  const source = (await image.getAttribute('src'))!,
    png = PNG.sync.read(Buffer.from(source.split(',')[1], 'base64')),
    qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(qr).not.toBeNull();
  return qr!.data;
}
async function approve(owner: Page, screen: Page) {
  await screen.getByRole('button', { name: 'Request pairing' }).click();
  await expect(screen.getByLabel('Screen verification')).toBeVisible();
  await expect(owner.getByLabel('Verification to compare')).toHaveText(
    await screen.getByLabel('Screen verification').innerText(),
  );
  await expect(
    owner.getByRole('button', { name: 'Approve this screen' }),
  ).toBeDisabled();
  await owner.getByLabel('Every group matches the new screen').check();
  await owner.getByRole('button', { name: 'Approve this screen' }).click();
  await expect(
    screen.getByRole('combobox', { name: 'Your name', exact: true }),
  ).toBeVisible();
  await expect(
    screen
      .getByRole('combobox', { name: 'Your name', exact: true })
      .getByRole('option', { name: 'Member 105', exact: true }),
  ).toHaveCount(1);
}
async function signIn(screen: Page, pin = '0042') {
  await screen
    .getByRole('combobox', { name: 'Your name', exact: true })
    .selectOption({ label: 'Member 105' });
  await screen.getByLabel('Four-digit PIN', { exact: true }).fill(pin);
  await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    screen.getByRole('heading', {
      name: 'Kitchen access verified',
      exact: true,
    }),
  ).toBeVisible();
}
test('owner comparison, staff PIN and live revocation work across separate browser profiles without owner Auth on the screen', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await owner(page);
  const url = await invitation(page),
    context = await browser.newContext(),
    screen = await context.newPage(),
    requests: string[] = [];
  screen.on('request', (request) => {
    if (request.url().startsWith(service.config().apiUrl))
      requests.push(request.url());
  });
  try {
    await screen.goto(url);
    await expect(screen).not.toHaveURL(/#mise-screen=/);
    await approve(page, screen);
    await signIn(screen);
    expect(requests.some((url) => url.includes('/auth/'))).toBe(false);
    expect(
      await screen.evaluate(async () => {
        const names = await indexedDB.databases();
        return names.some((d) => d.name?.startsWith('mise-local'));
      }),
    ).toBe(false);
    await screen.goto(
      new URL('.', url).href.replace(/screen\/$/, '') + '?flags=deviceAccess',
    );
    await expect(
      screen.getByRole('heading', { name: 'This profile is a shared screen.' }),
    ).toBeVisible();
    await screen.getByRole('link', { name: 'Open shared screen' }).click();
    await expect(
      screen.getByRole('heading', { name: 'Kitchen access verified' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Revoke screen', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Revoke screen', exact: true })
      .click();
    await expect(
      page.getByText('Screen access revoked.', { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole('heading', { name: 'Kitchen access verified' }),
    ).toHaveCount(0, { timeout: 20000 });
    await expect(screen.getByRole('alert')).toBeVisible();
  } finally {
    await context.close();
  }
});
test('lost owner pairing replies retain the original retry across reload and never create a second invitation', async ({
  page,
}) => {
  await owner(page);
  service.loseNext('start');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await expect(
    page.getByRole('heading', { name: 'A device change is unconfirmed' }),
  ).toBeVisible();
  expect((await service.counts()).starts).toBe(1);
  // Follow a normal in-app URL without the original opt-in query before reload.
  await page.evaluate(() =>
    history.replaceState(history.state, '', location.pathname),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Retry saved device change' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry saved device change' }).click();
  await expect(page.getByLabel('Pairing code', { exact: true })).toBeVisible();
  expect(await service.counts()).toMatchObject({ starts: 1, pending: 1 });
});
test('a lost successful PIN response shows recovery and closes the orphaned session before a fresh explicit sign-in', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await owner(page);
  const url = await invitation(page),
    context = await browser.newContext(),
    screen = await context.newPage();
  try {
    await screen.goto(url);
    await approve(page, screen);
    service.loseNext('pin');
    await screen
      .getByRole('combobox', { name: 'Your name', exact: true })
      .selectOption({ label: 'Member 105' });
    await screen.getByLabel('Four-digit PIN', { exact: true }).fill('0042');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      screen.getByRole('heading', { name: 'Recover the previous sign-in' }),
    ).toBeVisible();
    expect((await service.counts()).sessions).toBe(1);
    await screen.reload();
    await expect(
      screen.getByRole('button', { name: 'Retry sign-out' }),
    ).toBeVisible();
    await screen.getByRole('button', { name: 'Retry sign-out' }).click();
    await expect(
      screen.getByRole('combobox', { name: 'Your name', exact: true }),
    ).toBeVisible();
    expect((await service.counts()).sessions).toBe(0);
    await signIn(screen);
  } finally {
    await context.close();
  }
});
test('a manager can pair screens but cannot see PIN administration or bypass outlet and PIN SQL roles', async ({
  page,
  request,
}) => {
  await owner(page, 2);
  await expect(
    page.getByRole('heading', { name: 'Staff PINs', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'As the assigned manager, you can pair and revoke screens for this outlet.',
      { exact: false },
    ),
  ).toBeVisible();
  const config = service.config(2),
    headers = {
      Authorization: 'Bearer ' + config.jwt,
      apikey: config.publishableKey,
      Origin: fixtureOrigin,
    };
  const denied = await request.post(
    config.apiUrl + '/rest/v1/rpc/read_device_admin',
    {
      headers,
      data: {
        p_outlet_id: '00000000000000000000000012',
        p_kind: 'devices',
        p_after_id: null,
        p_limit: 50,
      },
    },
  );
  expect(denied.status()).toBe(403);
  const pin = await request.post(config.apiUrl + '/functions/v1/staff-pin', {
    headers,
    data: {
      action: 'set',
      outletId: config.setup.outlet.id,
      memberId: '00000000000000000000000105',
      pin: '1234',
    },
  });
  expect(pin.status()).toBe(403);
  expect(await invitation(page)).toContain(
    '/screen/setup?flags=deviceAccess#mise-screen=',
  );
});
test('opening a setup QR in the owner profile preserves its shop and sign-in, and focus checks retain unsaved forms', async ({
  page,
}) => {
  await owner(page);
  await page
    .getByLabel('Screen name', { exact: true })
    .fill('Unsaved screen name');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Screen name', { exact: true })).toHaveValue(
    'Unsaved screen name',
  );
  const before = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith('mise.cloud.auth.'),
      ),
    ),
    url = await invitation(page);
  await page.goto(url);
  await expect(
    page.getByRole('heading', {
      name: 'Keep the owner’s shop in this profile',
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith('mise.cloud.auth.'),
      ),
    ),
  ).toEqual(before);
  expect((await service.counts()).devices).toBe(0);
  await page.getByRole('link', { name: 'Return to your shop' }).click();
  await expect(
    page.getByRole('link', { name: 'More', exact: true }).first(),
  ).toBeVisible();
});
test('a disabled screen route does not import or create an owner workspace', async ({
  page,
}) => {
  await page.goto('app/screen/setup');
  await expect(
    page.getByRole('heading', { name: 'Shared screen setup is unavailable.' }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const names = await indexedDB.databases();
      return names.some((d) => d.name?.startsWith('mise-local'));
    }),
  ).toBe(false);
});

test('the owner sets a transient PIN that works on the screen, then clearing it stops that live staff access', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await owner(page);
  await page
    .getByRole('combobox', { name: 'Staff member', exact: true })
    .selectOption('00000000000000000000000105');
  await page.getByLabel('New four-digit PIN', { exact: true }).fill('9017');
  await page.getByLabel('Repeat PIN', { exact: true }).fill('9017');
  await page
    .getByRole('button', { name: 'Save staff PIN', exact: true })
    .click();
  await expect(
    page.getByText(
      'Staff PIN saved. Previous PIN sessions are no longer valid.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel('New four-digit PIN', { exact: true }),
  ).toHaveValue('');
  await expect(page.getByLabel('Repeat PIN', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) => value.includes('"pin":')),
    ),
  ).toBe(false);
  const url = await invitation(page),
    context = await browser.newContext(),
    screen = await context.newPage();
  try {
    await screen.goto(url);
    await approve(page, screen);
    await signIn(screen, '9017');
    await page
      .getByRole('combobox', { name: 'Staff member', exact: true })
      .selectOption('00000000000000000000000105');
    await page
      .getByRole('button', { name: 'Clear staff PIN', exact: true })
      .click();
    await expect(
      page.getByText(
        'Staff PIN cleared. Its existing sessions are no longer valid.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      screen.getByRole('heading', { name: 'Kitchen access verified' }),
    ).toHaveCount(0, { timeout: 20000 });
  } finally {
    await context.close();
  }
});

test('revoking an assigned manager hides an already-open pairing and its privileged screen controls', async ({
  page,
}) => {
  await owner(page, 2);
  await invitation(page);
  await service.revokeManager();
  await expect(
    page.getByRole('heading', {
      name: 'Verify your phone account',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create pairing code' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Pairing code', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeVisible();
});
