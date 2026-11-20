import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';
// @ts-expect-error Isolated browser fixture installer, not application source.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';

type Server = Awaited<ReturnType<typeof startConvergenceServer>>;
type DeviceState = Awaited<ReturnType<Window['miseSyncApplyTest']['inspect']>>;
async function inspect(page: Page) { return page.evaluate(() => window.miseSyncApplyTest.inspect()); }
async function initialize(page: Page, server: Server, n: 1 | 2) {
  await page.goto('app/'); await installSyncApplyFixture(page);
  await page.evaluate(config => window.miseSyncApplyTest.initialize(config), server.config(n));
  if (n === 1) await page.evaluate(() => window.miseSyncApplyTest.pull());
  await page.goto('app/counter');
  await expect(page.getByLabel('Calculation', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await installSyncApplyFixture(page);
}
async function queueOriginal(page: Page, kind: 'counter' | 'order' | 'purchase') {
  if (kind === 'counter') {
    await page.getByLabel('Calculation', { exact: true }).fill('37');
    await page.locator('.counter-cash').click();
    await expect(page.getByLabel('Calculation', { exact: true })).toHaveValue('');
  } else if(kind==='purchase')await page.evaluate(() => window.miseSyncApplyTest.queuePurchase());
  else await page.evaluate(() => window.miseSyncApplyTest.queueNewOrder());
  await page.evaluate(() => window.miseSyncApplyTest.captureImage());
}
function expectOriginal(actual: DeviceState, original: DeviceState) {
  expect(actual.backup.tables).toEqual(original.backup.tables);
  expect(actual.queue).toEqual(original.queue);
  expect(actual.binding).toEqual(original.binding);
  expect(actual.base).toEqual(original.base);
  expect(actual.applications).toEqual(original.applications);
  expect(actual.admissions).toEqual(original.admissions);
  expect(actual.imageSizes).toEqual(original.imageSizes);
}

for (const kind of ['counter', 'order', 'purchase'] as const) {
  test(`a real canonical pull retains an original BDT ${kind} action after an owner USD profile command`, async ({ page, browser }) => {
    test.setTimeout(120000);
    const server = await startConvergenceServer(), context = await browser.newContext({ baseURL: test.info().project.use.baseURL }), manager = await context.newPage();
    try {
      await initialize(page, server, 1); await initialize(manager, server, 2);
      await context.setOffline(true); await queueOriginal(manager, kind);
      const original = await inspect(manager), command = original.queue[0].commands[0];
      await page.evaluate(() => window.miseSyncApplyTest.setCurrency('USD'));
      await page.evaluate(() => window.miseSyncApplyTest.deliver()); await page.evaluate(() => window.miseSyncApplyTest.pull());
      await context.setOffline(false);
      const result = await manager.evaluate(async () => {
        try { await window.miseSyncApplyTest.pull(); return { refused: false }; }
        catch (error) { const e = error as { kind?: string; commandId?: string }; return { refused: true, kind: e.kind, commandId: e.commandId }; }
      });
      expect(result).toEqual({ refused: true, kind: 'conflict', commandId: command.id });
      expectOriginal(await inspect(manager), original);
      const ids = original.queue.flatMap(row => row.changes.filter(c => c.table === (kind==='purchase'?'purchases':'sales') && c.after !== null).map(c => c.key));
      if(kind==='purchase')expect(ids.length).toBeGreaterThan(0);
      expect(await (kind==='purchase'?server.purchaseCount(ids):server.financialCount(ids))).toBe(0);
      await context.setOffline(true); await manager.reload(); await installSyncApplyFixture(manager);
      expectOriginal(await inspect(manager), original);
    } finally { await context.close(); await server.close(); }
  });

  test(`the actual recovery review refuses to reinterpret a saved BDT ${kind} action and keeps a usable offline backup`, async ({ page, browser }) => {
    test.setTimeout(150000);
    const server = await startConvergenceServer({ originalOwner: true }), context = await browser.newContext({ baseURL: test.info().project.use.baseURL }), manager = await context.newPage();
    try {
      await initialize(page, server, 1); await initialize(manager, server, 2);
      await installRealtimeFixture(manager, server.config(2).jwt);
      await manager.goto('app/settings/sync?flags=cloudSync');
      await manager.getByRole('button', { name: 'Turn on sync', exact: true }).click();
      await expect(manager.getByRole('link', { name: 'Sync: Synced', exact: true })).toBeVisible({ timeout: 30000 });
      await manager.goto('app/counter'); await installSyncApplyFixture(manager);
      await context.setOffline(true); await queueOriginal(manager, kind);
      const original = await inspect(manager);
      await page.evaluate(() => window.miseSyncApplyTest.setCurrency('USD'));
      await page.evaluate(() => window.miseSyncApplyTest.deliver()); await page.evaluate(() => window.miseSyncApplyTest.pull());
      await server.changeEpoch(); await context.setOffline(false);
      await manager.goto('app/settings/sync?flags=cloudSync');
      await manager.getByRole('button', { name: 'Review outlet access', exact: true }).click({ timeout: 30000 });
      const check = manager.getByRole('button', { name: 'Check current access', exact: true });
      await expect(check).toBeEnabled({ timeout: 30000 }); await check.click();
      await expect(manager.getByRole('alert')).toBeVisible({ timeout: 30000 });
      await expect(manager.getByRole('button', { name: 'Apply reviewed changes', exact: true })).toHaveCount(0);
      await installSyncApplyFixture(manager); expectOriginal(await inspect(manager), original);
      expect((await inspect(manager)).recoveries.filter(row => row.kind === 'admission')).toHaveLength(0);
      expect((await new AxeBuilder({ page: manager }).analyze()).violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
      await context.setOffline(true); await manager.reload();
      await expect(manager.getByRole('button', { name: 'Download saved shop backup', exact: true })).toBeEnabled();
      await installSyncApplyFixture(manager); expectOriginal(await inspect(manager), original);
      const downloading = manager.waitForEvent('download');
      await manager.getByRole('button', { name: 'Download saved shop backup', exact: true }).click();
      const file = await downloading, path = await file.path(); expect(path).toBeTruthy();
      const backup = JSON.parse(await readFile(path!, 'utf8'));
      expect(backup.tables).toEqual(original.backup.tables);
      expect(JSON.stringify(backup)).not.toMatch(/apiUrl|publishableKey|access_token|refresh_token|Authorization/);
    } finally { await context.close(); await server.close(); }
  });
}
