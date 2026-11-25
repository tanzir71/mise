import { expect, test } from '@playwright/test';
import { controlled } from './helpers/pwa';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
// @ts-expect-error Test-only bundler; never a production route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';
for (const width of [390, 1440])
  test(
    'real browser native delivery recovers a lost SQL money reply after reload without replay at ' +
      width +
      'px',
    async ({ page, baseURL }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 1000 });
      const apiUrl = new URL(baseURL!).origin,
        publishableKey = 'sb_publishable_browser_delivery',
        server = await nativePaymentTestServer(apiUrl, publishableKey, apiUrl);
      const url = new URL('app/native-delivery-verification.mjs', baseURL!)
          .href,
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
      await page.route(apiUrl + '/auth/v1/user', async (route) => {
        const r = route.request(),
          response = await server.handle(
            new Request(r.url(), { headers: r.headers() }),
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
          async ({ url, apiUrl, publishableKey }) => {
            const m = await import(url),
              db = new m.MiseDatabase('browser-native-delivery');
            try {
              const setup = await db.saveSetup({
                  businessType: 'corner_shop',
                  marketCode: 'BD',
                  name: 'Connected source',
                  phone: '01712345482',
                }),
                item = await db.captureInbox({
                  text: 'Unknown Tk 15.25\0\ud800 বাংলা',
                });
              return {
                source: await db.readBackup(),
                setup,
                item,
                config: { apiUrl, publishableKey },
                authScope: location.pathname + setup.business.id,
              };
            } finally {
              db.close();
            }
          },
          { url, apiUrl, publishableKey },
        );
        await server.seed(seed.source);
        const first = await page.evaluate(
          async ({ url, seed }) => {
            const m = await import(url),
              db = new m.MiseDatabase('browser-native-delivery'),
              journal = new m.OriginalCopyJournal(
                'browser-native-delivery-copies',
              );
            let auth, session;
            try {
              const sdk = await m.createCopySdk(
                seed.config,
                seed.authScope,
                (url: RequestInfo | URL, init?: RequestInit) =>
                  fetch(url, init),
                1,
                localStorage,
              );
              auth = sdk.auth;
              const targetHash = await m.cloudConnectionTarget(
                  seed.config,
                  seed.authScope,
                  sdk.saved.user.id,
                ),
                id = m.newInboxId();
              await db.cloudState.put({
                id: 'binding',
                version: 1,
                uploadId: id,
                businessId: seed.setup.business.id,
                outletId: seed.setup.outlet.id,
                ownerId: seed.setup.owner.id,
                targetHash,
                manifestHash: 'b'.repeat(64),
                phase: 'ready',
                sequence: 0,
                receipt: {
                  id,
                  businessId: seed.setup.business.id,
                  outletId: seed.setup.outlet.id,
                  snapshotHash: 'c'.repeat(64),
                  at: Date.now(),
                  records: 3,
                  images: 0,
                },
              });
              session = await m.createNativePaymentOutboxSession(db, {
                    config: seed.config,
                authScope: seed.authScope,
                auth,
                storage: localStorage,
                journal,
              });
              const review = await session.review(seed.item.id);
              await m.recordSavedPayment(db, review, {
                checked: true,
                amount: 1525,
                currency: 'BDT',
                method: 'cash',
                methodName: 'Cash',
                reference: '',
                receivedAt: seed.item.createdAt,
              });
              await m.recordSavedPaymentMoney(
                db,
                review,
                await m.compareSavedPaymentMoney(db, review, {
                  kind: 'counter',
                  who: 'Original actual counter',
                }),
                true,
              );
              await db.saveCustomer({
                name: 'After receipt',
                nickname: '',
                phone: '',
                address: '',
                notes: '',
                tags: [],
              });
              let blocked = false;
              try {
                await session.deliver();
              } catch {
                blocked = true;
              }
              const rows = await db.nativePaymentActions.toArray(),
                money = rows.find(
                  (r: {
                    original: { invocation: { command: { type: string } } };
                  }) => r.original.invocation.command.type === 'payment.record',
                );
              return {
                blocked,
                hashes: rows.map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
                localSales: await db.sales.count(),
                pending:
                  money.nativeReceipt === null && money.copyReceipt !== null,
              };
            } finally {
              session?.stop();
              await auth?.dispose();
              db.close();
              journal.close();
            }
          },
          { url, seed },
        );
        expect(first.blocked).toBe(true);
        expect(first.pending).toBe(true);
        expect(first.localSales).toBe(1);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        expect(
          (await server.sql.query('select id from public.customers')).rows,
        ).toHaveLength(0);
        await page.reload();
        await controlled(page);
        const recovered = await page.evaluate(
          async ({ url, seed }) => {
            const m = await import(url),
              db = new m.MiseDatabase('browser-native-delivery'),
              journal = new m.OriginalCopyJournal(
                'browser-native-delivery-copies',
              ),
              auth = await m.createPhoneAuth(seed.config, seed.authScope, {
                storage: localStorage,
              });
            let session;
            try {
              await auth.check();
              session = await m.createNativePaymentOutboxSession(db, {
                config: seed.config,
                authScope: seed.authScope,
                auth,
                storage: localStorage,
                journal,
              });
              const result = await session.deliver(),
                rows = await db.nativePaymentActions.toArray();
              return {
                blocked: result.blockedEntryId,
                hashes: rows.map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
                states: rows.map((r: { state: string }) => r.state),
                localSales: await db.sales.count(),
                retainedMarkers: (await db.outbox.toArray()).filter(
                  (r: { status: string }) => r.status === 'retained',
                ).length,
              };
            } finally {
              session?.stop();
              await auth.dispose();
              await db.delete();
              await journal.delete();
            }
          },
          { url, seed },
        );
        expect(recovered).toEqual({
          blocked: null,
          hashes: first.hashes,
          states: ['applied', 'applied'],
          localSales: 1,
          retainedMarkers: 2,
        });
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        expect(
          (await server.sql.query('select id from public.customers')).rows,
        ).toHaveLength(1);
      } finally {
        await server.close();
      }
    },
  );
