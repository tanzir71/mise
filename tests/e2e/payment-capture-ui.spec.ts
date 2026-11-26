import { expect, test, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated test-only bundler, never a production entry.
import { paymentNativeBrowserModule } from '../fixtures/payment-native-browser.mjs';

async function boot(
  page: Page,
  baseURL: string,
  scenario = 'manual',
  enabled = true,
) {
  if (enabled)
    await page
      .context()
      .addInitScript(() =>
        localStorage.setItem(
          'mise.flags',
          JSON.stringify({ paymentText: true }),
        ),
      );
  if (!enabled)
    await page
      .context()
      .addInitScript(() =>
        localStorage.setItem(
          'mise.flags',
          JSON.stringify({ shareTarget: true }),
        ),
      );
  const url = new URL('app/payment-native-verification.mjs', baseURL).href,
    name = 'mise-local:' + new URL('app/', baseURL).pathname;
  await page.route(url, async (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: await paymentNativeBrowserModule(),
    }),
  );
  await page.goto('app/');
  const source = await page.evaluate(
    async ({ url, name, scenario }) => {
      const m = await import(url),
        db = new m.MiseDatabase(name);
      try {
        await db.saveSetup({
          businessType: 'corner_shop',
          marketCode: 'BD',
          name: 'Payment review shop',
          phone: '01712345482',
        });
        const ids: string[] = [];
        if (scenario === 'recorded')
          await db.recordSale({
            expression: '910',
            method: 'wallet',
            wallet: 'bKash',
            who: '<script>Original counter customer</script>',
          });
        if (scenario === 'order' || scenario === 'many')
          for (let i = 0; i < (scenario === 'many' ? 4 : 1); i++) {
            const order = await db.saveOrder({
              source: 'phone',
              sourceText: 'Original order',
              name: 'Customer ' + i,
              phone: '',
              type: 'pickup',
              address: '',
              table: '',
              lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 91000 }],
              deliveryFee: 0,
              discount: 0,
              payment: { method: 'cash' },
            });
            ids.push(order.id);
          }
        if (scenario === 'credit' || scenario === 'credit-receipt') {
          const customer = await db.saveCustomer({
            name: 'Karim bhai',
            nickname: '',
            phone: '',
            address: '',
            notes: '',
            tags: [],
          });
          const account = await db.saveCreditTerms(customer.id, {
            allowed: true,
            limit: 200000,
            reminder: {
              enabled: false,
              dayOfMonth: 2,
              tone: 'gentle',
              channel: 'whatsapp',
            },
          });
          await db.recordCreditSale({
            customerId: customer.id,
            accountId: account.id,
            expression: '1000',
            items: [],
          });
          ids.push(account.id, customer.id);
          if (scenario === 'credit-receipt')
            await db.recordCreditPayment(account.id, 91000, 'wallet', 'bKash');
        }
        let text =
          scenario === 'settings'
            ? 'bKash: You have received Tk 910. TrxID TESTUICLOCK at 01/02/2026 14:30'
            : scenario === 'manual' || scenario === 'credit'
              ? '  Unknown transfer Tk 15.25. <script>globalThis.untrustedPayment=true</script>  '
              : 'bKash: You have received Tk 910. TrxID TESTUI' +
                scenario.toUpperCase();
        if (scenario === 'fold-first' || scenario === 'fold-second')
          text =
            'bKash: You have received Tk 910. TrxID TESTUIFOLD' +
            (scenario === 'fold-first' ? 'FIRST' : 'SECOND') +
            ' at 2026-11-01T' +
            (scenario === 'fold-first' ? '05' : '06') +
            ':30:00Z';
        let item = await db.captureInbox({
          title: 'Complete original বাংলা',
          text,
        });
        item = await db.changeInbox(item.id, item.revision, {
          kind: 'payment',
        });
        return { itemId: item.id, text, ids };
      } finally {
        db.close();
      }
    },
    { url, name, scenario },
  );
  await page.goto('app/inbox/' + source.itemId);
  await expect(
    page.getByRole('heading', { name: 'What is this?', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  const sheet = page.getByRole('dialog', {
    name: 'Review shared payment',
    exact: true,
  });
  if (enabled)
    await expect(
      sheet.getByRole('button', { name: 'Save checked details', exact: true }),
    ).toBeVisible();
  return { url, name, source, sheet };
}
async function checkDetails(sheet: Locator) {
  await sheet.locator('.payment-checked').getByRole('checkbox').check();
  await sheet
    .getByRole('button', { name: 'Save checked details', exact: true })
    .click();
  await expect(sheet.locator('.payment-saved')).toBeVisible();
}
async function native(page: Page, url: string, name: string) {
  return page.evaluate(
    async ({ url, name }) => {
      const m = await import(url),
        db = new m.MiseDatabase(name);
      try {
        const [payments, sales, orders, entries, accounts] = await Promise.all([
          db.payments.toArray(),
          db.sales.toArray(),
          db.orders.toArray(),
          db.creditEntries.toArray(),
          db.creditAccounts.toArray(),
        ]);
        return {
          payments,
          sales,
          orders,
          entries,
          balances: accounts.map((a: { id: string }) => ({
            id: a.id,
            balance: m.creditBalance(
              a,
              entries.filter(
                (e: { accountId: string }) => e.accountId === a.id,
              ),
            ),
          })),
        };
      } finally {
        db.close();
      }
    },
    { url, name },
  );
}

async function counterPlan(sheet: Locator) {
  await checkDetails(sheet);
  await sheet
    .getByRole('combobox', { name: 'Record against', exact: true })
    .selectOption('counter');
  await sheet
    .getByRole('button', { name: 'Review new payment', exact: true })
    .click();
  return sheet.getByRole('region', {
    name: 'Confirm new received money',
    exact: true,
  });
}
async function confirmCounter(sheet: Locator) {
  const region = await counterPlan(sheet);
  await region.getByRole('checkbox').check();
  await region
    .getByRole('button', { name: 'Record received money', exact: true })
    .click();
  await expect(
    sheet.getByRole('heading', { name: 'Money recorded', exact: true }),
  ).toBeVisible();
}

test('payment text stays off by default and the existing manual customer form remains usable', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'manual', false);
  await expect(
    f.sheet.getByRole('heading', { name: 'Record a payment', exact: true }),
  ).toBeVisible();
  await expect(
    f.sheet.getByRole('button', { name: 'Save checked details', exact: true }),
  ).toHaveCount(0);
  expect((await native(page, f.url, f.name)).payments).toEqual([]);
});

test('an independent original undo is acknowledged explicitly without reversing money twice', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!);
  await confirmCounter(f.sheet);
  const first = await native(page, f.url, f.name);
  await page.evaluate(
    async ({ url, name, saleId }) => {
      const m = await import(url),
        db = new m.MiseDatabase(name);
      try {
        await db.undoSale(saleId);
      } finally {
        db.close();
      }
    },
    { url: f.url, name: f.name, saleId: first.sales[0].id },
  );
  await f.sheet
    .getByRole('button', { name: 'Review original undo', exact: true })
    .click();
  const undo = f.sheet.getByRole('region', {
    name: 'Confirm original financial undo',
    exact: true,
  });
  await expect(
    undo.getByRole('heading', {
      name: 'Acknowledge original undo',
      exact: true,
    }),
  ).toBeVisible();
  const before = await native(page, f.url, f.name);
  await undo.getByRole('checkbox').check();
  await undo
    .getByRole('button', { name: 'Acknowledge original undo', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('heading', { name: 'Details saved', exact: true }),
  ).toBeVisible();
  const after = await native(page, f.url, f.name);
  expect(after.payments[0].postings[0].undo.mode).toBe('already-undone');
  expect(after.sales).toEqual(before.sales);
  expect(after.entries).toEqual(before.entries);
});

test('an expired original undo remains inspectable and cannot silently change an old receipt', async ({
  page,
  baseURL,
}) => {
  await page.clock.install({ time: new Date() });
  const f = await boot(page, baseURL!);
  await confirmCounter(f.sheet);
  const before = await native(page, f.url, f.name);
  await page.clock.fastForward(11 * 60000);
  await f.sheet
    .getByRole('button', { name: 'Review original undo', exact: true })
    .click();
  const undo = f.sheet.getByRole('region', {
    name: 'Confirm original financial undo',
    exact: true,
  });
  await expect(undo).toContainText('ten-minute undo window has ended');
  await expect(
    undo.getByRole('button', { name: 'Undo this recording', exact: true }),
  ).toBeDisabled();
  expect(await native(page, f.url, f.name)).toEqual(before);
});

test('an installation-owned bank label supports explicit transfer recording without any provider account', async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const f = await boot(page, baseURL!);
  await f.sheet
    .getByRole('combobox', { name: 'Payment method', exact: true })
    .selectOption('Bank transfer');
  await f.sheet
    .getByLabel('Bank or source label', { exact: true })
    .fill('My receiving bank');
  await f.sheet
    .getByLabel('Transaction reference (optional)', { exact: true })
    .fill('TESTUIBANKLABEL');
  await confirmCounter(f.sheet);
  const state = await native(page, f.url, f.name);
  expect(state.payments[0]).toMatchObject({
    methodName: 'Bank transfer',
    referenceScope: 'My receiving bank',
    reference: 'TESTUIBANKLABEL',
  });
  expect(state.sales[0].methodName).toBe('Bank transfer');
  expect(
    requests.every((url) => new URL(url).origin === new URL(baseURL!).origin),
  ).toBe(true);
});

test('a real native audit failure rolls back new money and a deliberate retry records the original once', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!),
    confirm = await counterPlan(f.sheet);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === 'events' && value.command === 'sale.record') {
        IDBObjectStore.prototype.add = original;
        throw new DOMException(
          'Simulated financial audit full',
          'QuotaExceededError',
        );
      }
      return original.call(this, value, key);
    };
  });
  await confirm.getByRole('checkbox').check();
  await confirm
    .getByRole('button', { name: 'Record received money', exact: true })
    .click();
  await expect(
    f.sheet
      .getByRole('alert')
      .filter({ hasText: 'Simulated financial audit full' }),
  ).toBeVisible();
  const failed = await native(page, f.url, f.name);
  expect(failed.sales).toEqual([]);
  expect(failed.payments[0].postings).toBeUndefined();
  await expect(
    confirm.getByRole('button', { name: 'Record received money', exact: true }),
  ).toBeDisabled();
  await confirm.getByRole('checkbox').check();
  await confirm
    .getByRole('button', { name: 'Record received money', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('heading', { name: 'Money recorded', exact: true }),
  ).toBeVisible();
  const completed = await native(page, f.url, f.name);
  expect(completed.sales).toHaveLength(1);
  expect(completed.payments[0].postings).toHaveLength(1);
});

test('unknown text opens editable amount hints, preserves literal source and restores the saved review offline without money', async ({
  page,
  context,
  baseURL,
}) => {
  const f = await boot(page, baseURL!);
  await expect(
    f.sheet.getByLabel('Amount received (BDT)', { exact: true }),
  ).toHaveValue('15.25');
  expect(
    await page.evaluate(() => Object.hasOwn(globalThis, 'untrustedPayment')),
  ).toBe(false);
  await f.sheet
    .getByRole('button', { name: 'Use manual customer payment', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('heading', { name: 'Record a payment', exact: true }),
  ).toBeVisible();
  await f.sheet
    .getByRole('button', { name: 'Back to saved-source review', exact: true })
    .click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(Error('Clipboard unavailable')),
      },
    }),
  );
  await f.sheet
    .getByRole('button', { name: 'Copy full original', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('textbox', {
      name: 'Complete original for copying',
      exact: true,
    }),
  ).toHaveValue('Complete original বাংলা\n' + f.source.text);
  await checkDetails(f.sheet);
  let state = await native(page, f.url, f.name);
  expect(state.payments).toHaveLength(1);
  expect(state.payments[0]).toMatchObject({
    amount: 1525,
    original: { text: f.source.text },
    parsed: { status: 'manual', raw: f.source.text },
  });
  expect(state.sales).toHaveLength(0);
  expect(state.entries).toHaveLength(0);
  await controlled(page);
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Details saved', exact: true }),
  ).toBeVisible();
  state = await native(page, f.url, f.name);
  expect(state.payments).toHaveLength(1);
  expect(state.sales).toHaveLength(0);
});
test('one existing receipt is linked automatically without recording money and metadata removal preserves its sale', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'recorded'),
    before = await native(page, f.url, f.name);
  await checkDetails(f.sheet);
  await expect(
    f.sheet.getByRole('heading', {
      name: 'Linked recorded receipt',
      exact: true,
    }),
  ).toBeVisible();
  const originalCounter = f.sheet.locator('.payment-association .payment-original-target');
  await expect(originalCounter).toContainText('<script>Original counter customer</script>');
  await expect(originalCounter).toContainText('Payment review shop');
  await expect(originalCounter.locator('script')).toHaveCount(0);
  await expect(originalCounter.getByRole('link')).toHaveAttribute('href', new URL('app/counter',baseURL!).pathname);
  let state = await native(page, f.url, f.name);
  expect(state.sales).toEqual(before.sales);
  expect(state.payments[0].association).toMatchObject({
    kind: 'sale',
    id: before.sales[0].id,
  });
  await f.sheet
    .getByRole('button', { name: 'Remove link', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('heading', {
      name: 'Find an existing match',
      exact: true,
    }),
  ).toBeVisible();
  state = await native(page, f.url, f.name);
  expect(state.payments[0].association).toBeUndefined();
  expect(state.sales).toEqual(before.sales);
});
test('four real unpaid candidates show only the top three and linking an order leaves it unpaid', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'many');
  await checkDetails(f.sheet);
  await f.sheet
    .getByRole('button', { name: 'Find matches', exact: true })
    .click();
  await expect(
    f.sheet
      .getByRole('status')
      .filter({ hasText: 'Showing the closest 3 of 4' }),
  ).toBeVisible();
  await expect(
    f.sheet.getByRole('button', { name: 'Link unpaid order', exact: true }),
  ).toHaveCount(3);
  await f.sheet
    .getByRole('button', { name: 'Link unpaid order', exact: true })
    .first()
    .click();
  await expect(
    f.sheet.getByRole('heading', { name: 'Linked unpaid order', exact: true }),
  ).toBeVisible();
  const state = await native(page, f.url, f.name);
  expect(state.payments[0].association.kind).toBe('order');
  expect(
    state.orders.every(
      (o: { payment: { status: string } }) => o.payment.status === 'pending',
    ),
  ).toBe(true);
  expect(state.sales).toHaveLength(0);
});
for (const target of ['order', 'credit', 'counter'])
  test(
    'the actual ' +
      target +
      ' review requires explicit new-money confirmation and undoes only its original recording',
    async ({ page, baseURL }) => {
      const f = await boot(
        page,
        baseURL!,
        target === 'counter' ? 'manual' : target,
      );
      await checkDetails(f.sheet);
      const before = await native(page, f.url, f.name);
      if (target === 'order') {
        await expect(
          f.sheet.getByRole('heading', {
            name: 'Linked unpaid order',
            exact: true,
          }),
        ).toBeVisible();
        await f.sheet
          .getByRole('button', {
            name: 'Review payment for linked order',
            exact: true,
          })
          .click();
      } else {
        await f.sheet
          .getByRole('combobox', { name: 'Record against', exact: true })
          .selectOption(target);
        if (target === 'credit')
          await f.sheet
            .getByRole('combobox', { name: 'Customer account', exact: true })
            .selectOption(f.source.ids[0]);
        else
          await f.sheet
            .getByLabel('Who (optional)', { exact: true })
            .fill('Walk-in customer');
        await f.sheet
          .getByRole('button', { name: 'Review new payment', exact: true })
          .click();
      }
      const confirm = f.sheet.getByRole('region', {
        name: 'Confirm new received money',
        exact: true,
      });
      await expect(
        confirm.getByRole('button', {
          name: 'Record received money',
          exact: true,
        }),
      ).toBeDisabled();
      expect(await native(page, f.url, f.name)).toEqual(before);
      await confirm.getByRole('checkbox').check();
      await confirm
        .getByRole('button', { name: 'Record received money', exact: true })
        .click();
      await expect(
        f.sheet.getByRole('heading', { name: 'Money recorded', exact: true }),
      ).toBeVisible();
      const originalTarget = f.sheet.locator(
        '.payment-financial-original .payment-original-target',
      );
      await expect(originalTarget).toContainText(
        target === 'order'
          ? 'Customer 0'
          : target === 'credit'
            ? 'Karim bhai'
            : 'Walk-in customer',
      );
      const originalLabel = await originalTarget.locator('p').allTextContents();
      const originalHref = await originalTarget
        .getByRole('link')
        .getAttribute('href');
      let state = await native(page, f.url, f.name);
      expect(state.payments[0].postings).toHaveLength(1);
      if (target === 'credit')
        expect(state.balances[0].balance).toBe(100000 - 1525);
      else expect(state.sales).toHaveLength(before.sales.length + 1);
      if (target === 'order')
        expect(state.orders[0].payment.status).toBe('paid');
      await page.reload();
      await page
        .getByRole('button', { name: 'Review payment', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Money recorded', exact: true }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Review original undo', exact: true })
        .click();
      const undo = page.getByRole('region', {
        name: 'Confirm original financial undo',
        exact: true,
      });
      await expect(
        undo.getByRole('button', { name: 'Undo this recording', exact: true }),
      ).toBeDisabled();
      await undo.getByRole('checkbox').check();
      await undo
        .getByRole('button', { name: 'Undo this recording', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Details saved', exact: true }),
      ).toBeVisible();
      state = await native(page, f.url, f.name);
      expect(state.payments[0].postings[0].undo.mode).toBe('performed');
      if (target === 'credit') expect(state.balances[0].balance).toBe(100000);
      else
        expect(
          state.sales.filter(
            (s: { voidedAt?: number }) => s.voidedAt === undefined,
          ),
        ).toHaveLength(
          before.sales.filter(
            (s: { voidedAt?: number }) => s.voidedAt === undefined,
          ).length,
        );
      if (target === 'order')
        expect(state.orders[0].payment.status).toBe('pending');
      if (target === 'credit') {
        await page.evaluate(
          async ({ url, name, id }) => {
            const m = await import(url),
              db = new m.MiseDatabase(name);
            try {
              await db.saveCustomer(
                {
                  name: 'Later customer name',
                  nickname: '',
                  phone: '',
                  address: '',
                  notes: '',
                  tags: [],
                },
                { id },
              );
            } finally {
              db.close();
            }
          },
          { url: f.url, name: f.name, id: f.source.ids[1] },
        );
      }
      await page.reload();
      await page
        .getByRole('button', { name: 'Review payment', exact: true })
        .click();
      await page
        .getByText('Original proposal and saved history', { exact: true })
        .click();
      const historyTarget = page
        .locator('.payment-history article .payment-original-target')
        .first();
      await expect(historyTarget.locator('p')).toHaveText(originalLabel);
      await expect(historyTarget.getByRole('link')).toHaveAttribute(
        'href',
        originalHref!,
      );
      await historyTarget.getByRole('link').click();
      await expect(page).toHaveURL(new URL(originalHref!, baseURL!).href);
      if (target === 'credit')
        await expect(
          page.getByRole('heading', {
            name: 'Later customer name',
            exact: true,
          }),
        ).toBeVisible();
      else if (target === 'order')
        await expect(page.locator('.order-detail')).toBeVisible();
      else
        await expect(
          page.getByRole('heading', { name: 'Counter', exact: true }),
        ).toBeVisible();
    },
  );
test('source clocks and numeric date order are end-user choices and a saved proposal is never reinterpreted on reopening', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'settings');
  await f.sheet.getByText('Source settings', { exact: true }).click();
  await f.sheet.getByLabel('Source timezone', { exact: true }).fill('UTC');
  await expect(
    f.sheet.getByRole('button', { name: 'Save checked details', exact: true }),
  ).toBeDisabled();
  await f.sheet
    .getByRole('combobox', { name: 'Numeric date order', exact: true })
    .selectOption('DMY');
  await f.sheet
    .getByRole('combobox', { name: 'Source type', exact: true })
    .selectOption('notification');
  await f.sheet
    .getByRole('button', { name: 'Read with these settings', exact: true })
    .click();
  await expect(
    f.sheet.getByLabel('Received time (UTC)', { exact: true }),
  ).toHaveValue('2026-02-01T14:30');
  await checkDetails(f.sheet);
  const before = await native(page, f.url, f.name);
  expect(before.payments[0]).toMatchObject({
    source: 'notification',
    parsed: {
      sourceContext: { timeZone: 'UTC', dateOrder: 'DMY' },
      receivedAt: Date.UTC(2026, 1, 1, 14, 30),
    },
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await page
    .getByText('Original proposal and saved history', { exact: true })
    .click();
  await expect(page.getByText(/Original source · notification/)).toBeVisible();
  expect((await native(page, f.url, f.name)).payments).toEqual(before.payments);
});
test('a second tab changing the source discards an unconfirmed financial comparison before any money is recorded', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!);
  await checkDetails(f.sheet);
  await f.sheet
    .getByRole('combobox', { name: 'Record against', exact: true })
    .selectOption('counter');
  await f.sheet
    .getByRole('button', { name: 'Review new payment', exact: true })
    .click();
  await expect(
    f.sheet.getByRole('region', {
      name: 'Confirm new received money',
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(
    async ({ url, name, itemId }) => {
      const m = await import(url),
        other = new m.MiseDatabase(name);
      try {
        const item = await other.inboxItems.get(itemId);
        await other.changeInbox(itemId, item.revision, { archived: true });
      } finally {
        other.close();
      }
    },
    { url: f.url, name: f.name, itemId: f.source.itemId },
  );
  await expect(
    f.sheet.getByRole('region', {
      name: 'Confirm new received money',
      exact: true,
    }),
  ).not.toBeVisible();
  const state = await native(page, f.url, f.name);
  expect(state.sales).toHaveLength(0);
  expect(state.payments[0].postings).toBeUndefined();
});
for (const width of [360, 390, 768, 1024, 1440])
  test(
    'the actual payment sheet fits ' + width + 'px and meets AA',
    async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await boot(page, baseURL!);
      await expect(f.sheet.locator('.payment-checked')).toBeVisible();
      expect(
        await f.sheet.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
        })),
      ).toEqual({
        client: await f.sheet.evaluate((el) => el.clientWidth),
        scroll: await f.sheet.evaluate((el) => el.clientWidth),
      });
      const axe = await new AxeBuilder({ page })
        .include('.app-dialog')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        axe.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        ),
      ).toEqual([]);
      await test.info().attach('payment-review-' + width + '.png', {
        body: await f.sheet.screenshot(),
        contentType: 'image/png',
      });
      await checkDetails(f.sheet);
      await f.sheet
        .getByRole('combobox', { name: 'Record against', exact: true })
        .selectOption('counter');
      await f.sheet
        .getByRole('button', { name: 'Review new payment', exact: true })
        .click();
      const next = await new AxeBuilder({ page })
        .include('.app-dialog')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        next.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        ),
      ).toEqual([]);
      const financial = f.sheet.getByRole('region', {
        name: 'Confirm new received money',
        exact: true,
      });
      await financial.getByRole('checkbox').check();
      await financial
        .getByRole('button', { name: 'Record received money', exact: true })
        .click();
      await expect(
        f.sheet.getByRole('heading', { name: 'Money recorded', exact: true }),
      ).toBeVisible();
      const recorded = await new AxeBuilder({ page })
        .include('.app-dialog')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        recorded.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        ),
      ).toEqual([]);
      await f.sheet
        .getByText('Original proposal and saved history', { exact: true })
        .click();
      const history = await new AxeBuilder({ page })
        .include('.app-dialog')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        history.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    },
  );

for (const [scenario, hour] of [
  ['fold-first', 5],
  ['fold-second', 6],
] as const)
  test(
    'the ' +
      scenario +
      ' known original instant survives unchanged checked fields and later edits',
    async ({ page, baseURL }) => {
      const f = await boot(page, baseURL!, scenario);
      await f.sheet.getByText('Source settings', { exact: true }).click();
      await f.sheet
        .getByLabel('Source timezone', { exact: true })
        .fill('America/New_York');
      await f.sheet
        .getByRole('button', { name: 'Read with these settings', exact: true })
        .click();
      const field = f.sheet.getByLabel('Received time (America/New_York)', {
        exact: true,
      });
      await expect(field).toHaveValue('2026-11-01T01:30');
      await field.fill('2026-11-01T01:31');
      await f.sheet.locator('.payment-checked').getByRole('checkbox').check();
      await f.sheet
        .getByRole('button', { name: 'Save checked details', exact: true })
        .click();
      await expect(
        f.sheet.getByRole('alert').filter({ hasText: 'occurs twice' }),
      ).toBeVisible();
      expect((await native(page, f.url, f.name)).payments).toHaveLength(0);
      await field.fill('2026-11-01T01:30');
      await checkDetails(f.sheet);
      let state = await native(page, f.url, f.name);
      expect(state.payments[0]).toMatchObject({
        receivedAt: Date.UTC(2026, 10, 1, hour, 30),
        parsed: {
          receivedAt: Date.UTC(2026, 10, 1, hour, 30),
          sourceContext: { timeZone: 'America/New_York' },
        },
      });
      await f.sheet
        .getByRole('button', { name: 'Edit checked details', exact: true })
        .click();
      await f.sheet
        .getByLabel('Amount received (BDT)', { exact: true })
        .fill('911');
      await f.sheet.locator('.payment-checked').getByRole('checkbox').check();
      await f.sheet
        .getByRole('button', { name: 'Save checked changes', exact: true })
        .click();
      await expect(f.sheet.locator('.payment-saved')).toBeVisible();
      state = await native(page, f.url, f.name);
      expect(state.payments[0]).toMatchObject({
        amount: 91100,
        receivedAt: Date.UTC(2026, 10, 1, hour, 30),
        parsed: { amount: 91000, receivedAt: Date.UTC(2026, 10, 1, hour, 30) },
      });
      expect(state.sales).toHaveLength(0);
      expect(state.entries).toHaveLength(0);
    },
  );

test('a linked customer receipt keeps the original name after a rename and opens the actual currency account from saved history', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'credit-receipt');
  await checkDetails(f.sheet);
  const target = f.sheet.locator(
    '.payment-association .payment-original-target',
  );
  await expect(target).toContainText('Karim bhai');
  const href = await target.getByRole('link').getAttribute('href');
  expect(href).toBe(
    new URL('app/khata/' + f.source.ids[1] + '?currency=BDT', baseURL!)
      .pathname + '?currency=BDT',
  );
  await page.evaluate(
    async ({ url, name, id }) => {
      const m = await import(url),
        db = new m.MiseDatabase(name);
      try {
        await db.saveCustomer(
          {
            name: 'Later customer name',
            nickname: '',
            phone: '',
            address: '',
            notes: '',
            tags: [],
          },
          { id },
        );
      } finally {
        db.close();
      }
    },
    { url: f.url, name: f.name, id: f.source.ids[1] },
  );
  await page.reload();
  await page
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await expect(
    f.sheet.locator('.payment-association .payment-original-target'),
  ).toContainText('Karim bhai');
  await f.sheet
    .getByRole('button', { name: 'Remove link', exact: true })
    .click();
  await expect(f.sheet.getByRole('status')).toHaveText(
    'Link removed. Recorded money is unchanged.',
  );
  await f.sheet
    .getByText('Original proposal and saved history', { exact: true })
    .click();
  const original = f.sheet
    .locator('.payment-history article')
    .filter({
      has: page.getByRole('heading', {
        name: 'Original metadata link',
        exact: true,
      }),
    });
  await expect(original).toContainText('Karim bhai');
  const state = await native(page, f.url, f.name);
  await expect(original).toContainText(
    state.entries.find((e: { type: string }) => e.type === 'payment').id,
  );
  await original.getByRole('link').click();
  await expect(page).toHaveURL(new URL(href!, baseURL!).href);
  await expect(
    page.getByRole('heading', { name: 'Later customer name', exact: true }),
  ).toBeVisible();
});

test('an edited order retains the originally linked customer and actual order route after the metadata link is removed', async ({
  page,
  baseURL,
}) => {
  const f = await boot(page, baseURL!, 'order');
  await checkDetails(f.sheet);
  const target = f.sheet.locator(
    '.payment-association .payment-original-target',
  );
  await expect(target).toContainText('Customer 0');
  const href = await target.getByRole('link').getAttribute('href');
  await page.evaluate(
    async ({ url, name, id }) => {
      const m = await import(url),
        db = new m.MiseDatabase(name);
      try {
        const order = await db.orders.get(id);
        await db.saveOrder(
          {
            source: order.source,
            sourceText: order.sourceText,
            name: 'Later order customer',
            phone: '',
            type: order.type,
            address: order.address,
            table: order.table,
            lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 91000 }],
            deliveryFee: 0,
            discount: 0,
            payment: { method: 'cash' },
          },
          { id, revision: order.revision },
        );
      } finally {
        db.close();
      }
    },
    { url: f.url, name: f.name, id: f.source.ids[0] },
  );
  await page.reload();
  await page
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await expect(
    f.sheet.locator('.payment-association .payment-original-target'),
  ).toContainText('Customer 0');
  await f.sheet
    .getByRole('button', { name: 'Remove link', exact: true })
    .click();
  await expect(f.sheet.getByRole('status')).toHaveText(
    'Link removed. Recorded money is unchanged.',
  );
  await f.sheet
    .getByText('Original proposal and saved history', { exact: true })
    .click();
  const original = f.sheet
    .locator('.payment-history article')
    .filter({
      has: page.getByRole('heading', {
        name: 'Original metadata link',
        exact: true,
      }),
    });
  await expect(original).toContainText('Customer 0');
  await original.getByRole('link').click();
  await expect(page).toHaveURL(new URL(href!, baseURL!).href);
  await expect(page.locator('.order-detail')).toContainText(
    'Later order customer',
  );
});
