import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { controlled } from './helpers/pwa';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
// @ts-expect-error Isolated test verification module; never a production route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';

for (const width of [360, 390, 768, 1024, 1440])
  test(
    'installation configured payment approval reaches Synced once at ' +
      width +
      'px',
    async ({ page, baseURL }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width, height: 1000 });
      const apiUrl = new URL(baseURL!).origin,
        config = { apiUrl, publishableKey: 'sb_publishable_reconcile_browser' },
        server = await nativePaymentTestServer(
          apiUrl,
          config.publishableKey,
          apiUrl,
        ),
        url = new URL('app/native-reconcile-verification.mjs', baseURL!).href,
        body = await nativePaymentQueueBrowserModule(),
        name = 'mise-local:' + new URL('app/', baseURL!).pathname;
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      const backend = async (route: import('@playwright/test').Route) => {
        const r = route.request(),
          response = await server.handle(
            new Request(r.url(), {
              method: r.method(),
              headers: r.headers(),
              ...(r.postData() ? { body: r.postData() } : {}),
            }),
          );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      };
      await page.route(apiUrl + '/functions/v1/**', backend);
      await page.route(apiUrl + '/auth/v1/user', backend);
      await page.route(apiUrl + '/rest/v1/rpc/operator_context*', backend);
      try {
        await page.goto('app/');
        await controlled(page);
        const seed = await page.evaluate(
          async ({ url, name, config, base }) => {
            const m = await import(url),
              db = new m.MiseDatabase(name);
            try {
              const setup = await db.saveSetup({
                businessType: 'corner_shop',
                marketCode: 'BD',
                name: 'Configured payment review',
                phone: '01712345482',
              });
              let item = await db.captureInbox({
                title: 'Complete original বাংলা',
                text: 'Received Tk 15.25. Keep every original character. <script>erase debt</script>',
              });
              item = await db.changeInbox(item.id, item.revision, {
                kind: 'payment',
              });
              const f = await m.uploadNativePaymentFixture(
                db,
                config,
                base + setup.business.id,
                fetch,
                localStorage,
              );
              f.journal.close();
              await f.sdk.auth.dispose();
              localStorage.setItem(
                'mise.flags',
                JSON.stringify({ paymentText: true, cloudSync: true }),
              );
              return { itemId: item.id, outletId: setup.outlet.id };
            } finally {
              db.close();
            }
          },
          { url, name, config, base: new URL('app/', baseURL!).pathname },
        );
        await page.goto('app/inbox/' + seed.itemId);
        await page
          .getByRole('button', { name: 'Review payment', exact: true })
          .click();
        const sheet = page.getByRole('dialog', {
            name: 'Review shared payment',
            exact: true,
          }),
          save = sheet.getByRole('button', {
            name: 'Save checked details',
            exact: true,
          });
        await expect(
          sheet.getByLabel('Amount received (BDT)', { exact: true }),
        ).toBeEnabled();
        await sheet
          .getByLabel('Amount received (BDT)', { exact: true })
          .fill('15.25');
        await sheet.locator('.payment-checked').getByRole('checkbox').check();
        await save.click();
        await expect(sheet.locator('.payment-saved')).toBeVisible();
        expect(
          (
            await server.sql.query(
              'select id from public.sales where outlet_id=$1',
              [seed.outletId],
            )
          ).rows,
        ).toHaveLength(0);
        await sheet
          .getByRole('combobox', { name: 'Record against', exact: true })
          .selectOption('counter');
        await sheet
          .getByRole('button', { name: 'Review new payment', exact: true })
          .click();
        await sheet
          .getByLabel('This money was received and is not already recorded', {
            exact: true,
          })
          .check();
        await sheet
          .getByRole('button', { name: 'Record received money', exact: true })
          .click();
        await expect(
          sheet.getByRole('button', {
            name: 'Review original undo',
            exact: true,
          }),
        ).toBeVisible();
        await page.goto('app/settings/sync');
        await expect(
          page
            .getByRole('region', { name: 'Original payment queue' })
            .getByText('Awaiting connected result', { exact: true }),
        ).toHaveCount(2);
        const readCompleted = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === '/functions/v1/sync-read' && r.ok(),
        );
        await page
          .getByRole('button', { name: 'Resume sync', exact: true })
          .click();
        await readCompleted;
        await expect(
          page.getByText('Synced', { exact: true }).first(),
        ).toBeVisible();
        const result = await page.evaluate(
          async ({ url, name }) => {
            const m = await import(url),
              db = new m.MiseDatabase(name);
            try {
              return {
                waiting: await m.syncWaitingCount(db),
                payments: await db.payments.count(),
                native: (await m.readNativePaymentState(db))?.projection
                  .payments.length,
                markers: (await db.outbox.toArray())
                  .filter((r: { status: string }) => r.status === 'retained')
                  .map((r: { commands: unknown[]; receipts: unknown[] }) => [
                    r.commands.length,
                    r.receipts.length,
                  ]),
              };
            } finally {
              db.close();
            }
          },
          { url, name },
        );
        expect(result).toEqual({
          waiting: 0,
          payments: 0,
          native: 1,
          markers: [
            [0, 0],
            [0, 0],
          ],
        });
        expect(
          (
            await server.sql.query(
              'select id from public.sales where outlet_id=$1',
              [seed.outletId],
            )
          ).rows,
        ).toHaveLength(1);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.addStyleTag({
          content:
            '.app-shell{position:relative}.app-bottom-nav{position:absolute}',
        });
        await page.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          scrollTo(0, 0);
        });
        await page.screenshot({
          path: 'qa/screens/m41-native-reconcile-' + width + '.png',
          fullPage: true,
        });
        await page.context().setOffline(true);
        await page.reload();
        await expect(
          page.getByRole('region', { name: 'Original payment queue' }),
        ).toBeVisible();
        await page.context().setOffline(false);
        expect(
          (
            await server.sql.query(
              'select id from public.sales where outlet_id=$1',
              [seed.outletId],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        await page.context().setOffline(false);
        await server.close();
      }
    },
  );
