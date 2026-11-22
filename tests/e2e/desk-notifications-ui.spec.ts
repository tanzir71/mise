import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import {
  installDeskUi,
  startDeskUiService,
  mockDeskBrowser,
} from '../fixtures/install-desk-ui.mjs';
import type { startDeskUiService as Factory } from '../fixtures/desk-ui-service';
let service: Awaited<ReturnType<typeof Factory>>;
test.beforeAll(async () => {
  service = await startDeskUiService();
});
test.afterAll(async () => {
  await service?.close();
});
async function initialize(
  page: Page,
  context: BrowserContext,
  permission: NotificationPermission = 'default',
) {
  const prepared = await service.prepare();
  await mockDeskBrowser(context, permission);
  await page.goto('app/');
  await installDeskUi(page);
  await page.evaluate(
    (input) => window.miseDeskUiTest.initialize(input),
    prepared,
  );
  await page.goto('app/inbox');
  await expect(
    page.getByRole('heading', { name: 'Inbox', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /A-2041.*Got it/ }),
  ).toBeVisible();
  await installDeskUi(page);
  return prepared;
}
async function settings(page: Page) {
  await page.goto('app/settings/notifications');
  await expect(
    page.getByRole('heading', { name: 'Notifications', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable here', exact: true }),
  ).toBeEnabled();
}

test('real Inbox and red queue use complete PostgreSQL tasks independently of share capture and stop after a kitchen Got it', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  const before = await service.inspect();
  expect(before.openTasks).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Add manually', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Open order', exact: true }),
  ).toBeVisible();
  await page.goto('app/orders');
  await expect(page.locator('.kitchen-alarm')).toHaveCount(1);
  await expect(
    page.getByRole('link', { name: /Kitchen has not acknowledged/ }),
  ).toBeVisible();
  await service.acknowledge();
  expect(await service.inspect()).toMatchObject({ openTasks: 0 });
  await expect(page.locator('.kitchen-alarm')).toHaveCount(0, {
    timeout: 8000,
  });
  await page.goto('app/inbox');
  await expect(
    page.getByRole('heading', { name: 'Nothing waiting', exact: true }),
  ).toBeVisible();
  expect(await service.inspect()).toMatchObject({
    openTasks: 0,
    order: { payment: before.order.payment, total: before.order.total },
  });
});

test('Enable requests browser permission in the explicit user gesture and never copies browser capabilities into the private cache', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  expect(await page.evaluate(() => window.miseDeskPermissionCalls)).toEqual([]);
  await page.getByRole('button', { name: 'Enable here', exact: true }).click();
  await expect(
    page.getByText('Notifications enabled on this browser.', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.miseDeskPermissionCalls)).toEqual([
    true,
  ]);
  expect(await service.inspect()).toMatchObject({
    registrations: 1,
    activeSubscriptions: 1,
  });
  await installDeskUi(page);
  const before = await page.evaluate(() => window.miseDeskUiTest.inspect()),
    stored = JSON.stringify({
      profiles: before.profiles,
      operations: before.operations,
    });
  expect(stored).not.toMatch(
    /fcm.googleapis|access_token|refresh_token|p256dh|sb_publishable/,
  );
  await page.reload();
  await expect(page.getByText('Enabled here', { exact: true })).toBeVisible();
  await installDeskUi(page);
  const after = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(after.orders).toEqual(before.orders);
  expect(after.sales).toEqual(before.sales);
  expect(after.creditEntries).toEqual(before.creditEntries);
});

test('an accepted registration with a lost reply retries its original event after reload and creates one SQL subscription', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  service.loseNextRegistrationReply();
  await page.getByRole('button', { name: 'Enable here', exact: true }).click();
  await expect
    .poll(() => service.inspect())
    .toMatchObject({ registrations: 1, activeSubscriptions: 1 });
  await expect(
    page.getByText('Enable saved · awaiting confirmation', { exact: true }),
  ).toBeVisible();
  await installDeskUi(page);
  const before = await page.evaluate(() => window.miseDeskUiTest.inspect()),
    original = before.operations.find(
      (row: unknown) =>
        (row as { request: { kind: string } }).request.kind === 'register',
    );
  expect(original).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Enabled here', { exact: true })).toBeVisible();
  await installDeskUi(page);
  const after = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(after.operations).toHaveLength(1);
  expect(after.operations[0]).toMatchObject({
    ...(original as object),
    receipt: { action: 'register' },
  });
  expect(await service.inspect()).toMatchObject({ activeSubscriptions: 1 });
});

test('offline Disable keeps Inbox tasks and its original withdrawal through reload, then confirms removal', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  await page.getByRole('button', { name: 'Enable here', exact: true }).click();
  await expect(page.getByText('Enabled here', { exact: true })).toBeVisible();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Disable here', exact: true }).click();
  await expect(
    page.getByText('Disabled on this browser. Saved warnings stay in Inbox.', {
      exact: true,
    }),
  ).toBeVisible();
  await installDeskUi(page);
  const before = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(before.setups[0]).toMatchObject({
    enabled: false,
    pendingWithdrawals: 1,
  });
  await page.reload();
  await expect(
    page.getByText('Off on this browser', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open Inbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /A-2041.*Got it/ }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect
    .poll(() => service.inspect())
    .toMatchObject({ withdrawals: 1, activeSubscriptions: 0 });
  await installDeskUi(page);
  const after = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(after.orders).toEqual(before.orders);
  expect(after.setups[0]).toMatchObject({
    enabled: false,
    pendingWithdrawals: 0,
  });
});

test('Disable wins while the real registration HTTP reply is held after SQL commit', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  const hold = service.holdRegistration();
  try {
    await page
      .getByRole('button', { name: 'Enable here', exact: true })
      .click();
    await hold.started;
    await page
      .getByRole('button', { name: 'Disable here', exact: true })
      .click();
    await expect(
      page.getByText('Off on this browser', { exact: true }),
    ).toBeVisible();
    hold.release();
    await expect
      .poll(() => service.inspect())
      .toMatchObject({ activeSubscriptions: 0 });
    await page.reload();
    await expect(
      page.getByText('Off on this browser', { exact: true }),
    ).toBeVisible();
  } finally {
    hold.release();
  }
});

test('a rejected earlier warning edit remains visible for retry while independent browser Enable succeeds', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  await page
    .getByRole('button', { name: 'Change kitchen warning', exact: true })
    .click();
  await service.changeWarning(5);
  await page.getByLabel('Warn after (minutes)', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Save kitchen warning', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Enable here', exact: true }).click();
  await expect(
    page.getByText('Notifications enabled on this browser.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('1 saved change awaiting confirmation.', { exact: true }),
  ).toBeVisible();
  await installDeskUi(page);
  const saved = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(
    saved.operations.filter(
      (row: unknown) => !(row as { receipt: unknown }).receipt,
    ),
  ).toMatchObject([{ request: { kind: 'settings', minutes: 4, revision: 0 } }]);
  expect(await service.inspect()).toMatchObject({ activeSubscriptions: 1 });
});

test('locked personal cleanup retains shop data and confirms the original removal without reopening the selected desk', async ({
  page,
  context,
}) => {
  await initialize(page, context);
  await settings(page);
  await page.getByRole('button', { name: 'Enable here', exact: true }).click();
  await expect(page.getByText('Enabled here', { exact: true })).toBeVisible();
  await installDeskUi(page);
  const before = await page.evaluate(() => window.miseDeskUiTest.inspect());
  await page.evaluate(() => window.miseDeskUiTest.lock());
  await page.goto('app/settings/notifications/cleanup');
  await expect(
    page.getByRole('heading', { name: 'Earlier notifications', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Saved setup', exact: true })
    .selectOption({ index: 1 });
  await page
    .getByRole('button', { name: 'Disable saved setup here', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Confirm original removals',
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Confirm original removals', exact: true })
    .click();
  await expect(
    page.getByText('Original removals confirmed.', { exact: true }),
  ).toBeVisible();
  await installDeskUi(page);
  const after = await page.evaluate(() => window.miseDeskUiTest.inspect());
  expect(after.binding?.phase).toBe('locked');
  expect(after.orders).toEqual(before.orders);
  expect(after.sales).toEqual(before.sales);
  expect(await service.inspect()).toMatchObject({ activeSubscriptions: 0 });
});

test('blocked browser permission leaves Inbox usable and never attempts subscription or permission', async ({
  page,
  context,
}) => {
  await initialize(page, context, 'denied');
  await page.goto('app/settings/notifications');
  await expect(
    page.getByText('Blocked in browser', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable here', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.miseDeskPermissionCalls)).toEqual([]);
  expect(await service.inspect()).toMatchObject({ registrations: 0 });
  await page.getByRole('link', { name: 'Open Inbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /A-2041.*Got it/ }),
  ).toBeVisible();
});

test('an unsynced order keeps its real Inbox warning and offers connection setup instead of inventing a local order',async({page,context})=>{
 const prepared=await initialize(page,context),before=await service.inspect();await page.evaluate(id=>window.miseDeskUiTest.removeLocalOrder(id),prepared.order.id);await page.getByRole('link',{name:'Open order',exact:true}).click();
 await expect(page.getByRole('heading',{name:'This order is not saved here yet',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Open Sync setup',exact:true})).toBeVisible();await page.getByRole('link',{name:'Back to Inbox',exact:true}).click();await expect(page.getByRole('heading',{name:/A-2041.*Got it/})).toBeVisible();expect((await service.inspect()).order).toEqual(before.order);
});

test('a blocked clipboard leaves the complete original warning selected for manual copy',async({page,context})=>{
 await initialize(page,context);await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Synthetic clipboard blocked');}}}));
 await page.getByRole('button',{name:'Copy warning',exact:true}).click();await expect(page.getByRole('textbox',{name:'Copy this warning by hand',exact:true})).toHaveValue('Order A-2041 needs Got it');expect(await page.evaluate(()=>window.miseDeskPermissionCalls)).toEqual([]);
});

test('a native lock during a held accepted registration retains its original unconfirmed action and never enables that desk',async({page,context})=>{
 await initialize(page,context);await settings(page);const hold=service.holdRegistration();try{
  await page.getByRole('button',{name:'Enable here',exact:true}).click();await hold.started;await installDeskUi(page);await page.evaluate(()=>window.miseDeskUiTest.lock());hold.release();
  await expect.poll(async()=>{await installDeskUi(page);const saved=await page.evaluate(()=>window.miseDeskUiTest.inspect());return {phase:saved.binding?.phase,enabled:saved.setups[0]?.enabled,receipt:(saved.operations[0] as {receipt:unknown})?.receipt};}).toEqual({phase:'locked',enabled:false,receipt:null});
  expect(await service.inspect()).toMatchObject({registrations:1,activeSubscriptions:1});
 }finally{hold.release();}
});

for (const width of [360, 390, 768, 1024, 1440])
  test(`desk Inbox and notification settings fit ${width}px and meet WCAG AA`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await initialize(page, context);
    mkdirSync('.private/desk-ui-captures', { recursive: true });
    for (const view of ['inbox', 'settings/notifications']) {
      await page.goto('app/' + view);
      await expect(
        page.getByRole('heading', {
          name: view === 'inbox' ? 'Inbox' : 'Notifications',
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      const report = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(report.violations).toEqual([]);
      await page.screenshot({
        path:
          '.private/desk-ui-captures/' +
          view.replaceAll('/', '-') +
          '-' +
          width +
          '.png',
        fullPage: true,
      });
    }
  });
