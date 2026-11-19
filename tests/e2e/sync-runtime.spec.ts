import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';
// @ts-expect-error The isolated installer is JavaScript, not shipped source.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';
test.describe.configure({ mode: 'serial' });
let server: Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeAll(async () => {
  server = await startConvergenceServer({ originalOwner: true });
});
test.afterAll(async () => {
  await server?.close();
});
async function initialize(page: Page, n: 1 | 2) {
  const socket = await installRealtimeFixture(page, server.config(n).jwt);
  await page.goto('app/');
  await installSyncApplyFixture(page);
  await page.evaluate(
    (config) => window.miseSyncApplyTest.initialize(config),
    server.config(n),
  );
  await page.goto('app/settings/sync?flags=cloudSync');
  const turnOn = page.getByRole('button', {
    name: 'Turn on sync',
    exact: true,
  });
  await expect(turnOn).toBeEnabled();
  await turnOn.click();
  await expect(
    page.getByRole('link', { name: 'Sync: Synced', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect.poll(() => socket.joins.length).toBeGreaterThan(0);
  expect(socket.joins.every((j) => j.tokenMatches)).toBe(true);
  expect(socket.joins[0].filters).toEqual([
    {
      event: 'INSERT',
      schema: 'public',
      table: 'events',
      filter: 'outlet_id=eq.' + server.config(n).outletId,
    },
  ]);
  return socket;
}
async function counter(page: Page) {
  await page.goto('app/counter');
  await installSyncApplyFixture(page);
  await expect(page.getByLabel('Calculation', { exact: true })).toBeVisible();
}
async function cash(page: Page, value: string) {
  await page.getByLabel('Calculation', { exact: true }).fill(value);
  await page.locator('.counter-cash').click();
  await expect(page.getByLabel('Calculation', { exact: true })).toHaveValue('');
}
test('the actual app reconnects two offline browsers and converges cash and customers without manual delivery calls', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const ownerSocket = await initialize(page, 1),
    other = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    }),
    manager = await other.newPage();
  try {
    await initialize(manager, 2);
    await counter(page);
    await counter(manager);
    await page.context().setOffline(true);
    await other.setOffline(true);
    await cash(page, '41');
    await cash(manager, '43');
    const customer = await manager.evaluate(() =>
      window.miseSyncApplyTest.customer('Offline app customer'),
    );
    await expect(
      page.getByRole('link', { name: /^Sync: Offline/ }),
    ).toBeVisible();
    await expect(
      manager.getByRole('link', { name: /^Sync: Offline/ }),
    ).toBeVisible();
    const ownerBefore = await page.evaluate(() =>
        window.miseSyncApplyTest.inspect(),
      ),
      managerBefore = await manager.evaluate(() =>
        window.miseSyncApplyTest.inspect(),
      );
    await page.context().setOffline(false);
    await expect(
      page.getByRole('link', { name: 'Sync: Synced', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await other.setOffline(false);
    await expect(
      manager.getByRole('link', { name: 'Sync: Synced', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    ownerSocket.notify();
    await expect
      .poll(async () => {
        const value = await page.evaluate(() =>
          window.miseSyncApplyTest.inspect(),
        );
        return value.backup.tables.customers.some((c) => c.id === customer.id);
      })
      .toBe(true);
    const a = await page.evaluate(() => window.miseSyncApplyTest.inspect()),
      b = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    for (const value of [a, b]) {
      expect(value.backup.tables.sales.some((s) => s.amount === 4100)).toBe(
        true,
      );
      expect(value.backup.tables.sales.some((s) => s.amount === 4300)).toBe(
        true,
      );
      expect(value.queue.every((q) => q.status === 'accepted')).toBe(true);
      expect(value.backup.tables.sales.some((s) => s.amount === 99999999)).toBe(
        false,
      );
    }
    expect(a.queue.map((q) => q.commands)).toEqual(
      ownerBefore.queue.map((q) => q.commands),
    );
    expect(b.queue.map((q) => q.commands)).toEqual(
      managerBefore.queue.map((q) => q.commands),
    );
    expect(a.binding?.version).toBe(1);
    expect(b.binding?.version).toBe(2);
  } finally {
    await page.context().setOffline(false);
    await other.setOffline(false);
    await other.close();
  }
});
test('pausing stops automatic delivery and an explicit resume drains the original queue', async ({
  page,
}) => {
  await initialize(page, 1);
  await page.getByRole('button', { name: 'Pause sync', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Sync: Paused', exact: true }),
  ).toBeVisible();
  await installSyncApplyFixture(page);
  await page.evaluate(() => window.miseSyncApplyTest.leaveExpiredPausedLease());
  await page.reload();
  await installSyncApplyFixture(page);
  await expect(
    page.getByRole('button', { name: 'Resume sync', exact: true }),
  ).toBeEnabled();
  const calls = server.calls.commands;
  await page.evaluate(() => window.miseSyncApplyTest.cash('47'));
  await expect(
    page.getByRole('link', { name: /^Sync: Paused, 1 unsent/ }),
  ).toBeVisible();
  await page.waitForTimeout(700);
  expect(server.calls.commands).toBe(calls);
  await page.getByRole('button', { name: 'Resume sync', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Sync: Synced', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect(
    (await page.evaluate(() => window.miseSyncApplyTest.inspect())).queue[0]
      .status,
  ).toBe('accepted');
});
test('the flagged sync controls remain accessible at phone and desktop widths', async ({
  page,
}) => {
  test.setTimeout(60000);
  await initialize(page, 1);
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('link', { name: /^Sync:/ })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page }).analyze();
    expect(
      result.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      ),
    ).toEqual([]);
    if ([360, 768, 1440].includes(width))
      await test.info().attach(`synced-controls-${width}`, {
        body: await page.screenshot({
          fullPage: true,
          style:
            '.app-shell{position:relative}.app-sidebar{position:absolute;top:0;bottom:0}.app-bottom-nav{position:absolute}.app-skip{visibility:hidden}',
        }),
        contentType: 'image/png',
      });
  }
});
