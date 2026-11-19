import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';

test.describe.configure({ mode: 'serial' });
let server: Awaited<ReturnType<typeof startConvergenceServer>>;
test.beforeAll(async () => {
  server = await startConvergenceServer({ originalOwner: true });
});
test.afterAll(async () => {
  await server?.close();
});
async function inspect(page: Page) {
  const appBase = new URL('app/', test.info().project.use.baseURL).pathname;
  return page.evaluate(async (base) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mise-local:' + base);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = [
          'joinSessions',
          'cloudState',
          'syncSessions',
          'operatorState',
          'syncReads',
          'syncImages',
          'outbox',
          'sales',
          'businesses',
        ],
        tx = db.transaction(names, 'readonly');
      const rows = await Promise.all(
        names.map(
          (name) =>
            new Promise<[string, Record<string, unknown>[]]>(
              (resolve, reject) => {
                const request = tx.objectStore(name).getAll();
                request.onsuccess = () => resolve([name, request.result]);
                request.onerror = () => reject(request.error);
              },
            ),
        ),
      );
      const data = Object.fromEntries(rows),
        active = (name: string) =>
          data[name].find((row) => row.id === 'active');
      return {
        join: active('joinSessions'),
        binding: data.cloudState[0],
        sync: active('syncSessions'),
        operator: active('operatorState'),
        reads: data.syncReads.map((row) => ({
          id: row.id,
          sourceHash: row.sourceHash,
          pages: row.pages,
          seal: row.seal,
        })),
        images: data.syncImages.length,
        queue: data.outbox.filter((row) => row.status !== 'accepted').length,
        retainedQueue: data.outbox.map((row) => ({
          id: row.id,
          status: row.status,
          receipts: row.receipts,
        })),
        sales: data.sales.length,
        businesses: data.businesses.length,
        authKeys: Object.keys(localStorage).filter((key) =>
          /^mise\.cloud\.auth\.[a-f0-9]{64}$/.test(key),
        ).length,
      };
    } finally {
      db.close();
    }
  }, appBase);
}
async function start(page: Page, n: 1 | 2) {
  const socket = await installRealtimeFixture(page, server.config(n).jwt);
  await page.goto('app/?flags=cloudSync');
  await page
    .getByRole('button', { name: 'Join an existing outlet', exact: true })
    .click();
  await page
    .getByLabel('Project URL', { exact: true })
    .fill(server.config(n).apiUrl);
  await page
    .getByLabel('Publishable key', { exact: true })
    .fill(server.config(n).publishableKey);
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  await page
    .getByLabel('Phone number', { exact: true })
    .fill('+1415555010' + n);
  await page
    .getByRole('button', { name: 'Send verification code', exact: true })
    .click();
  await page.getByLabel('Verification code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify phone', exact: true }).click();
  await expect(page.locator('.cloud-verified')).toBeVisible();
  await page
    .getByRole('button', { name: 'Find my outlets', exact: true })
    .click();
  await expect(page.locator('input[name=join-outlet]')).toHaveCount(
    n === 1 ? 2 : 1,
  );
  expect((await inspect(page)).businesses).toBe(0);
  expect((await inspect(page)).binding).toBeUndefined();
  await page.locator('input[name=join-outlet]').first().check();
  return socket;
}
async function finish(page: Page) {
  await expect(
    page.getByRole('link', { name: 'Sync: Synced', exact: true }),
  ).toBeVisible({ timeout: 25000 });
  const state = await inspect(page);
  expect(state.join).toMatchObject({ phase: 'ready' });
  expect(state.binding).toMatchObject({
    version: 2,
    receipt: null,
    join: { kind: 'join' },
  });
  expect(state.authKeys).toBe(1);
  expect(state.images).toBeGreaterThan(0);
  expect(state.businesses).toBe(1);
  return state;
}
test('an empty manager device joins through the actual OTP form, then syncs offline cash without another sign-in', async ({
  page,
}) => {
  test.setTimeout(90000);
  const before = { ...server.calls },
    socket = await start(page, 2);
  await expect(page.locator('.choice-card')).toContainText('Manager');
  await page
    .getByRole('button', { name: 'Join selected outlet', exact: true })
    .click();
  const state = await finish(page);
  expect(state.operator).toMatchObject({ phase: 'active', role: 'manager' });
  expect(state.binding).toMatchObject({ join: { role: 'manager' } });
  expect(server.calls.otp - before.otp).toBe(1);
  expect(server.calls.verifications - before.verifications).toBe(1);
  expect(server.calls.logouts - before.logouts).toBe(0);
  expect(server.calls.uploads - before.uploads).toBe(0);
  await expect.poll(() => socket.joins.length).toBeGreaterThan(0);
  expect(socket.joins.every((join) => join.tokenMatches)).toBe(true);
  await page.goto('app/counter');
  await expect(page.getByLabel('Calculation', { exact: true })).toBeVisible();
  await page.context().setOffline(true);
  await page.getByLabel('Calculation', { exact: true }).fill('53');
  await page.locator('.counter-cash').click();
  await expect(page.getByLabel('Calculation', { exact: true })).toHaveValue('');
  const offline = await inspect(page);
  expect(offline.sales).toBe(state.sales + 1);
  expect(offline.queue).toBe(1);
  await expect(
    page.getByRole('link', { name: /^Sync: Offline/ }),
  ).toBeVisible();
  await page.context().setOffline(false);
  await expect(
    page.getByRole('link', { name: 'Sync: Synced', exact: true }),
  ).toBeVisible({ timeout: 25000 });
  expect((await inspect(page)).queue).toBe(0);
  expect((await inspect(page)).retainedQueue).toMatchObject([
    { status: 'accepted', receipts: [expect.anything()] },
  ]);
  expect(server.calls.commands - before.commands).toBeGreaterThan(0);
  await page.goto('app/settings/sync');
  await expect(page.locator('.cloud-verified')).toBeVisible();
  expect(server.calls.otp - before.otp).toBe(1);
  expect(server.calls.logouts - before.logouts).toBe(0);
  await page.goto('app/settings/exports');
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download JSON backup', exact: true })
    .click();
  const file = await download,
    body = await readFile((await file.path())!, 'utf8');
  for (const value of [
    server.config(2).apiUrl,
    'sb_publishable_test_only',
    'refresh_token',
    'access_token',
    'joinSessions',
    'syncSessions',
  ])
    expect(body).not.toContain(value);
});
test('a truncated real SQL page resumes after reload with the exact original join and no second OTP', async ({
  page,
}) => {
  test.setTimeout(60000);
  const before = { ...server.calls };
  await start(page, 2);
  server.loseNextPage();
  await page
    .getByRole('button', { name: 'Join selected outlet', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Resume join', exact: true }),
  ).toBeEnabled();
  await expect
    .poll(async () => (await inspect(page)).join?.phase)
    .toBe('paused');
  const saved = await inspect(page);
  expect(saved.businesses).toBe(0);
  expect(saved.reads).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Join an existing outlet', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume join', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Resume join', exact: true }).click();
  const joined = await finish(page);
  expect(joined.join?.readId).toBe(saved.join?.readId);
  expect(
    joined.reads.find((row) => row.id === saved.join?.readId)?.sourceHash,
  ).toBe(saved.reads[0].sourceHash);
  expect(server.calls.otp - before.otp).toBe(1);
  expect(server.calls.logouts - before.logouts).toBe(0);
});
test('two real tabs retain one original join while either tab can finish its saved download', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const before = { ...server.calls };
  await start(page, 2);
  let release!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/functions/v1/sync-read', async (route) => {
    if (!held && route.request().postDataJSON().type === 'page') {
      held = true;
      await gate;
    }
    try {
      await route.continue();
    } catch {
      /* The successful other tab can unmount and cancel this transfer. */
    }
  });
  let other: Page | undefined;
  try {
    await page
      .getByRole('button', { name: 'Join selected outlet', exact: true })
      .click();
    await expect.poll(() => held).toBe(true);
    const saved = await inspect(page);
    other = await context.newPage();
    await installRealtimeFixture(other, server.config(2).jwt);
    await other.goto('app/');
    await expect(
      other.getByRole('button', { name: 'Resume join', exact: true }),
    ).toBeEnabled();
    await other
      .getByRole('button', { name: 'Resume join', exact: true })
      .click();
    const joined = await finish(other);
    release();
    await expect(
      page.getByRole('link', { name: 'Sync: Synced', exact: true }),
    ).toBeVisible({ timeout: 25000 });
    expect(joined.join?.readId).toBe(saved.join?.readId);
    expect((await inspect(page)).join?.readId).toBe(saved.join?.readId);
    expect(server.calls.otp - before.otp).toBe(1);
    expect(server.calls.logouts - before.logouts).toBe(0);
    expect(server.calls.uploads - before.uploads).toBe(0);
  } finally {
    release();
    await other?.close();
  }
});
test('the owner explicitly chooses from both allowed outlets and can return to local setup before admission', async ({
  page,
}) => {
  await start(page, 1);
  expect((await inspect(page)).join).toBeUndefined();
  await page
    .getByRole('button', { name: 'Back to local setup', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Join an existing outlet', exact: true }),
  ).toBeVisible();
  expect((await inspect(page)).businesses).toBe(0);
});
for (const width of [360, 390, 768, 1024, 1440])
  test(`join choices and recovery fit and meet axe at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 1100 });
    await start(page, 2);
    const check = async () => {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations.filter((v) =>
          ['serious', 'critical'].includes(v.impact ?? ''),
        ),
      ).toEqual([]);
    };
    await check();
    await page.screenshot({
      path: `qa/screens/m31-join-outlets-${width}.png`,
      fullPage: true,
    });
    server.loseNextPage();
    await page
      .getByRole('button', { name: 'Join selected outlet', exact: true })
      .click();
    await expect
      .poll(async () => (await inspect(page)).join?.phase)
      .toBe('paused');
    await expect(
      page.getByRole('button', { name: 'Resume join', exact: true }),
    ).toBeEnabled();
    await check();
    await page.screenshot({
      path: `qa/screens/m31-join-recovery-${width}.png`,
      fullPage: true,
    });
    const backup = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download a backup', exact: true })
      .click();
    await backup;
    const before = await inspect(page);
    await page
      .getByRole('button', { name: 'Back to local setup', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Join an existing outlet',
        exact: true,
      }),
    ).toBeVisible();
    const after = await inspect(page);
    expect(after.join).toMatchObject({ phase: 'cancelled' });
    expect(after.operator).toBeUndefined();
    expect(after.reads).toEqual(before.reads);
    expect(after.businesses).toBe(0);
  });
