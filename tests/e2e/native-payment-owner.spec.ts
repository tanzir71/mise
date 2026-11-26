import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { controlled } from './helpers/pwa';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
// @ts-expect-error Isolated verification bundle; never a production route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';

for (const width of [360, 390, 768, 1024, 1440])
  test(
    'actual saved queue controls retain uncertain money across reload at ' +
      width +
      'px',
    async ({ page, baseURL }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width, height: 1000 });
      const apiUrl = new URL(baseURL!).origin,
        config = { apiUrl, publishableKey: 'sb_publishable_owner_browser' },
        server = await nativePaymentTestServer(
          apiUrl,
          config.publishableKey,
          apiUrl,
        ),
        url = new URL('app/native-owner-verification.mjs', baseURL!).href,
        body = await nativePaymentQueueBrowserModule();
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      let lost = false;
      await page.route(apiUrl + '/functions/v1/**', async (route) => {
        const r = route.request(),
          response = await server.handle(
            new Request(r.url(), {
              method: r.method(),
              headers: r.headers(),
              body: r.postData(),
            }),
          );
        if (
          !lost &&
          new URL(r.url()).pathname === '/functions/v1/native-payment' &&
          JSON.parse(r.postData()!).command.type === 'payment.record' &&
          response.ok
        ) {
          lost = true;
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      for (const path of [
        '/auth/v1/user',
        '/rest/v1/rpc/operator_context',
        '/rest/v1/rpc/operator_contexts',
      ])
        await page.route(apiUrl + path, async (route) => {
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
            body: await response.text(),
          });
        });
      try {
        await page.goto('app/');
        await controlled(page);
        const seed = await page.evaluate(
          async ({ url, config, appPath }) => {
            const m = await import(url),
              db = new m.MiseDatabase('mise-local:' + appPath);
            try {
              const setup = await db.saveSetup({
                  businessType: 'corner_shop',
                  marketCode: 'BD',
                  name: 'End-user configured shop',
                  phone: '01712345482',
                }),
                item = await db.captureInbox({
                  text: 'Literal receipt Tk 15.25\0\ud800 বাংলা',
                });
              return {
                setup,
                item,
                source: await db.readBackup(),
                name: db.name,
                config,
                scope: appPath + setup.business.id,
              };
            } finally {
              db.close();
            }
          },
          { url, config, appPath: new URL('app/', baseURL!).pathname },
        );
        await server.seed(seed.source);
        const customerId = await page.evaluate(
          async ({ url, seed }) => {
            const m = await import(url),
              db = new m.MiseDatabase(seed.name);
            const f = await m.prepareNativeOwnerQueue(
              db,
              seed.setup,
              seed.item,
              seed.config,
              seed.scope,
              (url: RequestInfo | URL, init?: RequestInit) => fetch(url, init),
              localStorage,
            );
            try {
              const customer = await db.saveCustomer({
                name: 'After original money',
                nickname: '',
                phone: '',
                address: '',
                notes: '',
                tags: [],
              });
              return customer.id;
            } finally {
              f.session.stop();
              f.journal.close();
              await f.sdk.auth.dispose();
              db.close();
            }
          },
          { url, seed },
        );
        await page.goto('app/settings/sync?flags=cloudSync');
        await expect(
          page.getByRole('region', { name: 'Original payment queue' }),
        ).toHaveCount(0);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(0);
        await page.goto('app/settings/sync?flags=cloudSync,paymentText');
        const queue = page.getByRole('region', {
            name: 'Original payment queue',
          }),
          button = queue.getByRole('button', {
            name: 'Pause sync and continue saved queue',
          });
        await expect(queue).toBeVisible();
        await expect(
          queue.getByText('Awaiting connected result', { exact: true }),
        ).toHaveCount(2);
        await expect(button).toBeEnabled();
        const moneyReplyLost = page.waitForEvent(
          'requestfailed',
          (request) =>
            new URL(request.url()).pathname ===
              '/functions/v1/native-payment' &&
            JSON.parse(request.postData()!).command.type === 'payment.record',
        );
        await button.click();
        await moneyReplyLost;
        await expect(queue.getByRole('alert')).toBeVisible();
        expect(lost).toBe(true);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        await expect(
          queue.getByText('Original result saved', { exact: true }),
        ).toHaveCount(1);
        await expect(
          queue.getByText('Awaiting connected result', { exact: true }),
        ).toHaveCount(1);
        await page.reload();
        await expect(button).toBeEnabled();
        const laterShopResult = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/functions/v1/commands' &&
            JSON.parse(response.request().postData()!).type ===
              'customer.create' &&
            response.ok(),
        );
        await button.click();
        await laterShopResult;
        await expect(queue.getByRole('status')).toContainText(
          'Sync stays paused',
        );
        await expect(
          queue.getByText('Original result saved', { exact: true }),
        ).toHaveCount(2);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        expect(
          (
            await server.sql.query(
              'select id from public.customers where id=$1',
              [customerId],
            )
          ).rows,
        ).toHaveLength(1);
        const stored = await page.evaluate(
          async ({ url, name, setup }) => {
            const m = await import(url),
              db = new m.MiseDatabase(name);
            try {
              return {
                queue: await m.readNativePaymentQueue(db, setup),
                session: await db.syncSessions.get('active'),
                markers: await db.outbox
                  .where('status')
                  .equals('retained')
                  .count(),
                canonical: await db.syncCanonical.count(),
              };
            } finally {
              db.close();
            }
          },
          { url, name: seed.name, setup: seed.setup },
        );
        expect(stored.session.paused).toBe(true);
        expect(stored.session.lease).toBeNull();
        expect(stored.session.confirmed).toBe(0);
        expect(stored.session.lastConfirmedAt).toBeNull();
        expect(stored.markers).toBe(2);
        expect(stored.canonical).toBe(0);
        await expect(
          page.getByRole('link', { name: 'Sync: Synced', exact: true }),
        ).toHaveCount(0);
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
          ).violations,
        ).toEqual([]);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        // Match the existing settings QA capture style for viewport-fixed nav.
        await page.addStyleTag({
          content:
            '.app-shell{position:relative}.app-bottom-nav{position:absolute}',
        });
        await page.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          scrollTo(0, 0);
        });
        await page.screenshot({
          path: 'qa/screens/m41-native-owner-' + width + '.png',
          fullPage: true,
        });
        await page.context().setOffline(true);
        await page.reload();
        await expect(queue).toBeVisible();
        await expect(button).toBeDisabled();
        await expect(
          queue.getByText('Original result saved', { exact: true }),
        ).toHaveCount(2);
        await page.context().setOffline(false);
      } finally {
        await server.close();
      }
    },
  );
