import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';
// @ts-expect-error Shared isolated browser installer is JavaScript.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';

test('an offline BDT order stays original after a real owner currency change and can be deliberately withdrawn', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const server = await startConvergenceServer(),
    managerContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    }),
    manager = await managerContext.newPage();
  async function initialize(device: Page, n: 1 | 2) {
    await device.goto('app/');
    await installSyncApplyFixture(device);
    await device.evaluate(
      (config) => window.miseSyncApplyTest.initialize(config),
      server.config(n),
    );
    await device.goto('app/counter');
    await expect(
      device.getByLabel('Calculation', { exact: true }),
    ).toBeVisible();
    await device.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => resolve(),
            { once: true },
          ),
        );
    });
    await installSyncApplyFixture(device);
  }
  try {
    await initialize(page, 1);
    await initialize(manager, 2);
    await managerContext.setOffline(true);
    const saved = await manager.evaluate(() =>
        window.miseSyncApplyTest.queueNewOrder(),
      ),
      original = await manager.evaluate(() =>
        window.miseSyncApplyTest.inspect(),
      );
    expect(saved.currency).toBe('BDT');
    await page.evaluate(() => window.miseSyncApplyTest.setCurrency('USD'));
    await page.evaluate(() => window.miseSyncApplyTest.deliver());
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    await managerContext.setOffline(false);
    await manager.evaluate(() => window.miseSyncApplyTest.cycle());
    const rejected = await manager.evaluate(() =>
      window.miseSyncApplyTest.inspect(),
    );
    expect(rejected.queue).toEqual(original.queue);
    expect(rejected.backup.tables).toEqual(original.backup.tables);
    expect(rejected.actionReviews).toHaveLength(1);
    await installRealtimeFixture(manager, server.config(2).jwt);
    await manager.goto('app/settings/sync?flags=cloudSync');
    await manager
      .getByRole('button', { name: 'Review saved order action', exact: true })
      .click();
    const review = manager.getByRole('region', { name: 'Saved order review' });
    await review
      .getByRole('button', { name: 'Check current values', exact: true })
      .click();
    await expect(
      review.getByRole('button', {
        name: 'Withdraw saved action',
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      review.getByRole('button', {
        name: 'Apply reviewed action',
        exact: true,
      }),
    ).toBeDisabled();
    expect(
      (await new AxeBuilder({ page: manager }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    await managerContext.setOffline(true);
    await manager.reload();
    await manager
      .getByRole('button', { name: 'Review saved order action', exact: true })
      .click();
    await expect(
      review.getByRole('button', {
        name: 'Apply reviewed action',
        exact: true,
      }),
    ).toBeDisabled();
    await installSyncApplyFixture(manager);
    expect(
      (await manager.evaluate(() => window.miseSyncApplyTest.inspect())).queue,
    ).toEqual(original.queue);
    await managerContext.setOffline(false);
    // The read-only check revalidates the original phone account on reconnect.
    await expect(
      review.getByRole('button', {
        name: 'Check current values again',
        exact: true,
      }),
    ).toBeEnabled({ timeout: 20000 });
    await review
      .getByRole('button', { name: 'Check current values again', exact: true })
      .click();
    await expect(
      review.getByRole('button', {
        name: 'Withdraw saved action',
        exact: true,
      }),
    ).toBeEnabled();
    await review
      .getByRole('button', { name: 'Withdraw saved action', exact: true })
      .click();
    await expect(review.locator('.review-outcome')).toContainText(
      'saved action was withdrawn',
    );
    await expect
      .poll(
        async () => {
          await installSyncApplyFixture(manager);
          const state = await manager.evaluate(() => window.miseSyncApplyTest.inspect()),
            applicationHash = state.base?.version === 2 ? state.base.applicationHash : null,
            current = state.applications.find(application => application.hash === applicationHash);
          // A receipt can arrive before the original overlay is retired. Wait
          // for the actual canonical audit/coverage, not just the local ACK.
          return state.queue.every(row => row.status === 'accepted') &&
            current?.covered.some(intent => intent.id === original.queue[0].commands[0].id) === true;
        },
        { timeout: 20000 },
      )
      .toBe(true);
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    const actual = await manager.evaluate(() =>
        window.miseSyncApplyTest.inspect(),
      ),
      owner = await page.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(actual.queue.map((row) => row.commands)).toEqual(
      original.queue.map((row) => row.commands),
    );
    expect(actual.queue.map((row) => row.changes)).toEqual(
      original.queue.map((row) => row.changes),
    );
    expect(
      actual.backup.tables.orders.some((order) => order.id === saved.id),
    ).toBe(false);
    expect(owner.backup.tables.orders).toEqual(actual.backup.tables.orders);
    expect(actual.backup.tables.outlets[0].currency).toBe('USD');
    expect(actual.backup.tables.inboxItems).toEqual(
      original.backup.tables.inboxItems,
    );
    expect(actual.orderReviews[0].receipt).toMatchObject({
      type: 'command.resolved',
      outcome: 'withdrawn',
    });
    await expect(
      review.getByRole('link', {
        name: 'Create correct order manually',
        exact: true,
      }),
    ).toHaveAttribute('href', /\/orders\/new$/);
  } finally {
    await managerContext.setOffline(false);
    await managerContext.close();
    await server.close();
  }
});
