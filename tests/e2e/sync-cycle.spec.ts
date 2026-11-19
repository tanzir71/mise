import { expect, test, type Page } from '@playwright/test';
import { startConvergenceServer } from '../sync-convergence-server';
// @ts-expect-error The isolated native installer is JavaScript, not shipped code.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';
test.describe.configure({ mode: 'serial' });
let server: Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeAll(async () => {
  server = await startConvergenceServer({ originalOwner: true });
});
test.afterAll(async () => {
  await server?.close();
});
async function initialize(page: Page, n: 1 | 2 = 1) {
  await page.goto('app/');
  await installSyncApplyFixture(page);
  await page.evaluate(
    (config) => window.miseSyncApplyTest.initialize(config),
    server.config(n),
  );
}
test('an original uploaded owner sends cash and a new customer, then accepts their actual canonical snapshot in one cycle', async ({
  page,
}) => {
  await initialize(page);
  await page.evaluate(() => window.miseSyncApplyTest.cash('31'));
  const customer = await page.evaluate(() =>
      window.miseSyncApplyTest.customer('Offline customer'),
    ),
    original = await page.evaluate(() => window.miseSyncApplyTest.inspect());
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  const after = await page.evaluate(() => window.miseSyncApplyTest.inspect()),
    status = await page.evaluate(() => window.miseSyncApplyTest.cycleInspect());
  expect(after.binding).toEqual(original.binding);
  expect(after.admissions).toHaveLength(1);
  expect(after.backup.tables.customers.some((c) => c.id === customer.id)).toBe(
    true,
  );
  expect(after.queue.every((r) => r.status === 'accepted')).toBe(true);
  expect(status.state?.lastConfirmedAt).not.toBeNull();
  expect(status.state?.problem).toBeNull();
  expect(status.state?.readId).toBeNull();
  expect(status.state?.confirmed).toBe(status.state?.requested);
  expect(after.imageSizes).toEqual(original.imageSizes);
});
test('a lost committed command reply is retried with its original ID and never duplicates cash', async ({
  page,
}) => {
  await initialize(page);
  await page.evaluate(() => window.miseSyncApplyTest.cash('37'));
  const original = await page.evaluate(() =>
      window.miseSyncApplyTest.inspect(),
    ),
    saleId = original.queue[0].changes.find((c) => c.table === 'sales')!.key;
  server.loseNextCommand();
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    false,
  );
  const failed = await page.evaluate(() =>
    window.miseSyncApplyTest.cycleInspect(),
  );
  expect(failed.state?.problem).toBe('retry');
  expect(failed.state?.lease).toBeNull();
  expect(
    (await page.evaluate(() => window.miseSyncApplyTest.inspect())).queue,
  ).toEqual(original.queue);
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  expect(await server.financialCount([saleId])).toBe(1);
  expect(
    (await page.evaluate(() => window.miseSyncApplyTest.inspect())).queue[0]
      .commands,
  ).toEqual(original.queue[0].commands);
});
test('a frozen download is retained while newer acknowledged actions receive a fresh window', async ({
  page,
}) => {
  await initialize(page);
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  server.loseNextPage();
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    false,
  );
  const old = await page.evaluate(() =>
      window.miseSyncApplyTest.cycleInspect(),
    ),
    oldRead = old.reads.find((r) => r.id === old.state?.readId)!;
  expect(oldRead).toBeDefined();
  await page.evaluate(() =>
    window.miseSyncApplyTest.customer('Later customer'),
  );
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  const next = await page.evaluate(() =>
    window.miseSyncApplyTest.cycleInspect(),
  );
  expect(next.reads.find((r) => r.id === oldRead.id)).toEqual(oldRead);
  expect(
    (await page.evaluate(() => window.miseSyncApplyTest.inspect())).base
      ?.snapshot.readId,
  ).not.toBe(oldRead.id);
  expect(next.state?.readId).toBeNull();
});

test('a local completion failure reuses the already applied read without duplicating cash or the canonical application', async ({
  page,
}) => {
  await initialize(page);
  await page.evaluate(() => window.miseSyncApplyTest.cash('53'));
  expect(
    await page.evaluate(() => window.miseSyncApplyTest.cycleWithLostFinish()),
  ).toBe(false);
  const before = await page.evaluate(() => window.miseSyncApplyTest.inspect()),
    state = await page.evaluate(() => window.miseSyncApplyTest.cycleInspect());
  expect(before.base?.snapshot.readId).toBe(state.state?.readId);
  expect(state.state?.problem).toBe('retry');
  expect(state.state?.lastConfirmedAt).toBeNull();
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  const after = await page.evaluate(() => window.miseSyncApplyTest.inspect());
  expect(after.base).toEqual(before.base);
  expect(after.queue).toEqual(before.queue);
  expect(after.applications).toEqual(before.applications);
  expect(after.admissions).toEqual(before.admissions);
  expect(
    (await page.evaluate(() => window.miseSyncApplyTest.cycleInspect())).state
      ?.readId,
  ).toBeNull();
});

test('changing accounts inside the final status writer cannot confirm the previous account and preserves its applied read for an exact retry', async ({
  page,
}) => {
  await initialize(page);
  await page.evaluate(() => window.miseSyncApplyTest.cash('61'));
  expect(
    await page.evaluate(
      (config) => window.miseSyncApplyTest.cycleWithFinishSwitch(config),
      server.config(2),
    ),
  ).toBe(false);
  const first = await page.evaluate(() => window.miseSyncApplyTest.inspect()),
    state = await page.evaluate(() => window.miseSyncApplyTest.cycleInspect());
  expect(state.state?.problem).toBe('auth');
  expect(state.state?.lastConfirmedAt).toBeNull();
  expect(state.state?.readId).toBe(first.base?.snapshot.readId);
  await page.evaluate(
    (config) => window.miseSyncApplyTest.switchAccount(config),
    server.config(1),
  );
  await page.evaluate(() => window.miseSyncApplyTest.reselect());
  expect(await page.evaluate(() => window.miseSyncApplyTest.cycle())).toBe(
    true,
  );
  const after = await page.evaluate(() => window.miseSyncApplyTest.inspect());
  expect(after.base).toEqual(first.base);
  expect(after.queue).toEqual(first.queue);
  expect(
    await server.financialCount([
      after.queue[0].changes.find((c) => c.table === 'sales')!.key,
    ]),
  ).toBe(1);
});
