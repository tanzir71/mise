import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';
// @ts-expect-error The isolated fixture installer is JavaScript, not shipped source.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';

async function initialize(device: Page, config: Parameters<Window['miseSyncApplyTest']['initialize']>[0]) {
  await device.goto('app/');
  await installSyncApplyFixture(device);
  await device.evaluate(config => window.miseSyncApplyTest.initialize(config), config);
  await device.goto('app/counter');
  await expect(device.getByLabel('Calculation', { exact: true })).toBeVisible();
  await device.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await installSyncApplyFixture(device);
}

type DeviceState = Awaited<ReturnType<Window['miseSyncApplyTest']['inspect']>>;
function expectScopedConvergence(manager: DeviceState, owner: DeviceState, ownerId: string) {
  const { members: managerMembers, ...managerTables } = manager.backup.tables,
    { members: ownerMembers, ...ownerTables } = owner.backup.tables;
  expect(managerTables).toEqual(ownerTables);
  // A manager retains the historical owner reference without the owner's
  // contact or live authority. Assert the exact privacy projection separately.
  expect(managerMembers).toEqual(ownerMembers.map(member => {
    if (member.id !== ownerId) return member;
    const historical = { ...member, active: false };
    delete historical.phone;
    return historical;
  }));
}

test('an actual offline counter sale retains its BDT source when the owner changes the live profile to USD', async ({ page, browser }) => {
  test.setTimeout(120000);
  const server = await startConvergenceServer(), other = await browser.newContext({ baseURL: test.info().project.use.baseURL }), manager = await other.newPage();
  try {
    await initialize(page, server.config(1));
    await initialize(manager, server.config(2));
    await other.setOffline(true);
    await manager.getByLabel('Calculation', { exact: true }).fill('37');
    await manager.locator('.counter-cash').click();
    await expect(manager.getByLabel('Calculation', { exact: true })).toHaveValue('');
    const original = await manager.evaluate(() => window.miseSyncApplyTest.inspect()),
      command = original.queue[0].commands[0];
    expect(command.type).toBe('sale.record');
    if (command.type !== 'sale.record') throw Error('Expected original counter cash');
    const saleId = command.saleId;
    expect(original.backup.tables.sales.find(s => s.id === saleId)).toMatchObject({ currency: 'BDT', amount: 3700 });
    await page.evaluate(() => window.miseSyncApplyTest.setCurrency('USD'));
    await page.evaluate(() => window.miseSyncApplyTest.deliver());
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    await other.setOffline(false);
    await manager.evaluate(() => window.miseSyncApplyTest.cycle());
    const rejected = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(rejected.queue).toEqual(original.queue);
    expect(rejected.backup.tables).toEqual(original.backup.tables);
    expect(rejected.imageSizes).toEqual(original.imageSizes);
    expect(rejected.actionReviews).toHaveLength(1);
    expect(rejected.actionReviews[0]).toMatchObject({ status: 409, commandId: command.id });
    expect(await server.financialCount([saleId])).toBe(0);
    await installRealtimeFixture(manager, server.config(2).jwt);
    await manager.goto('app/settings/sync?flags=cloudSync');
    await expect(manager.getByText('Some saved work needs review. Your local records and downloaded pages are kept.')).toBeVisible();
    await expect(manager.getByRole('link', { name: 'Download a JSON backup', exact: true })).toBeVisible();
    await expect(manager.getByRole('button', { name: 'Review saved order action', exact: true })).toHaveCount(0);
    expect((await new AxeBuilder({ page: manager }).analyze()).violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    await other.setOffline(true);
    await manager.reload();
    await expect(manager.getByRole('link', { name: 'Download a JSON backup', exact: true })).toBeVisible();
    await expect(manager.getByRole('button', { name: 'Review saved order action', exact: true })).toHaveCount(0);
    await installSyncApplyFixture(manager);
    const reloaded = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(reloaded.queue).toEqual(original.queue);
    expect(reloaded.backup.tables).toEqual(original.backup.tables);
    expect(reloaded.actionReviews).toEqual(rejected.actionReviews);
    expect(reloaded.imageSizes).toEqual(original.imageSizes);
  } finally { await other.close(); await server.close(); }
});

test('an offline original BDT khata payment and undo converge after the owner changes the live profile to USD', async ({ page, browser }) => {
  test.setTimeout(120000);
  const server = await startConvergenceServer(), other = await browser.newContext({ baseURL: test.info().project.use.baseURL }), manager = await other.newPage();
  try {
    await initialize(page, server.config(1));
    await initialize(manager, server.config(2));
    await other.setOffline(true);
    const payment = await manager.evaluate(() => window.miseSyncApplyTest.payOriginalKhata(500));
    expect(payment.currency).toBe('BDT');
    const original = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    await page.evaluate(() => window.miseSyncApplyTest.setCurrency('USD'));
    await page.evaluate(() => window.miseSyncApplyTest.deliver());
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    await other.setOffline(false);
    await manager.evaluate(() => window.miseSyncApplyTest.cycle());
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    let accepted = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(accepted.queue.every(row => row.status === 'accepted')).toBe(true);
    expect(accepted.actionReviews).toEqual([]);
    expect(accepted.backup.tables.creditEntries.find(e => e.id === payment.id)).toMatchObject({ currency: 'BDT', amount: 500 });
    expect(accepted.queue[0].commands).toEqual(original.queue[0].commands);
    expect(accepted.queue[0].changes).toEqual(original.queue[0].changes);
    expectScopedConvergence(accepted, await page.evaluate(() => window.miseSyncApplyTest.inspect()), server.config(1).actorId);
    expect(accepted.backup.tables.outlets.find(o => o.id === payment.outletId)?.currency).toBe('USD');
    await other.setOffline(true);
    await manager.evaluate(id => window.miseSyncApplyTest.undoOriginalKhataPayment(id), payment.id);
    const reversed = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(reversed.backup.tables.creditEntries.find(e => e.reversalOf === payment.id)).toMatchObject({ currency: 'BDT', amount: 500 });
    await other.setOffline(false);
    await manager.evaluate(() => window.miseSyncApplyTest.cycle());
    await page.evaluate(() => window.miseSyncApplyTest.pull());
    accepted = await manager.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(accepted.queue.every(row => row.status === 'accepted')).toBe(true);
    expect(accepted.actionReviews).toEqual([]);
    expectScopedConvergence(accepted, await page.evaluate(() => window.miseSyncApplyTest.inspect()), server.config(1).actorId);
    expect(accepted.imageSizes).toEqual(original.imageSizes);
  } finally { await other.close(); await server.close(); }
});
