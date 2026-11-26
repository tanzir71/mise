import type {PhoneAuth} from '../../apps/web/src/data/phone-auth';
import { test, expect } from '@playwright/test';
import { controlled } from './helpers/pwa';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
// @ts-expect-error Test-only bundler, never a production route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';
for (const width of [390, 1440])
  test(
    'native source/history/outcome download survives a real cached-page loss and browser reload without installing or replaying money at ' +
      width +
      'px',
    async ({ page, baseURL }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 1000 });
      const apiUrl = new URL(baseURL!).origin,
        publishableKey = 'sb_publishable_browser_native_feed',
        server = await nativePaymentTestServer(apiUrl, publishableKey, apiUrl),
        url = new URL('app/native-stream-verification.mjs', baseURL!).href,
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
          new URL(r.url()).pathname === '/functions/v1/sync-read' &&
          JSON.parse(r.postData()!).type === 'page' &&
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
              db = new m.MiseDatabase('browser-native-stream-source');
            try {
              const setup = await db.saveSetup({
                  businessType: 'corner_shop',
                  marketCode: 'BD',
                  name: 'Stream original',
                  phone: '01712345482',
                }),
                item = await db.captureInbox({
                  text: 'Received Tk 15.25\0\ud800 বাংলা',
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
        const pending = await page.evaluate(
          async ({ url, seed }) => {
            const m = await import(url),
              db = new m.MiseDatabase('browser-native-stream-source'),
              journal = new m.OriginalCopyJournal(
                'browser-native-stream-copies',
              ),
              download = new m.MiseDatabase('browser-native-stream-download');
            let auth: PhoneAuth | undefined, session;
            try {
              const sdk = await m.createCopySdk(
                seed.config,
                seed.authScope,
                (url: RequestInfo | URL, init?: RequestInit) =>
                  fetch(url, init),
                1,
                localStorage,
              );
              const signedInAuth: PhoneAuth = sdk.auth;
              auth = signedInAuth;
              const targetHash = await m.cloudConnectionTarget(
                  seed.config,
                  seed.authScope,
                  sdk.saved.user.id,
                ),
                uploadId = m.newInboxId();
              await db.cloudState.put({
                id: 'binding',
                version: 1,
                uploadId,
                businessId: seed.setup.business.id,
                outletId: seed.setup.outlet.id,
                ownerId: seed.setup.owner.id,
                targetHash,
                manifestHash: 'b'.repeat(64),
                phase: 'ready',
                sequence: 0,
                receipt: {
                  id: uploadId,
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
                  who: 'Before native stream',
                }),
                true,
              );
              await session.deliver();
              const remote = m.createCloudSyncRemote(
                  seed.config,
                  async () => (await signedInAuth.commandAuthorization()).jwt,
                ),
                id = m.newInboxId(),
                window = await remote.begin({
                  type: 'begin',
                  id,
                  outletId: seed.setup.outlet.id,
                  cursor: null,
                }),
                target = {
                  targetHash,
                  businessId: window.businessId,
                  outletId: window.outletId,
                  actorId: window.actorId,
                  accountHash: window.accountHash,
                  role: window.role,
                };
              await m.prepareSyncDownload(download, {
                id,
                target,
                previousCursor: null,
              });
              let failed = false;
              try {
                await m.runSyncDownload(download, id, target, remote);
              } catch {
                failed = true;
              }
              const state = await download.syncReads.get(id);
              return {
                id,
                target,
                failed,
                pages: state.pages,
                seal: state.seal,
                hashes: (await db.nativePaymentActions.toArray()).map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
                sourceSales: await db.sales.count(),
                downloadSales: await download.sales.count(),
              };
            } finally {
              session?.stop();
              await auth?.dispose();
              db.close();
              journal.close();
              download.close();
            }
          },
          { url, seed },
        );
        expect(pending.failed).toBe(true);
        expect(pending.pages).toBe(0);
        expect(pending.seal).toBeNull();
        expect(pending.sourceSales).toBe(1);
        expect(pending.downloadSales).toBe(0);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        expect(
          (
            await server.sql.query(
              'select page_index from private.sync_read_pages where window_id=$1',
              [pending.id],
            )
          ).rows,
        ).toHaveLength(1);
        await page.reload();
        await controlled(page);
        const recovered = await page.evaluate(
          async ({ url, seed, pending }) => {
            const m = await import(url),
              source = new m.MiseDatabase('browser-native-stream-source'),
              download = new m.MiseDatabase('browser-native-stream-download'),
              journal = new m.OriginalCopyJournal(
                'browser-native-stream-copies',
              ),
              auth = await m.createPhoneAuth(seed.config, seed.authScope, {
                storage: localStorage,
              });
            try {
              await auth.check();
              const remote = m.createCloudSyncRemote(
                  seed.config,
                  async () => (await auth.commandAuthorization()).jwt,
                ),
                state = await m.runSyncDownload(
                  download,
                  pending.id,
                  pending.target,
                  remote,
                ),
                verified = await m.readVerifiedSyncRecords(
                  download,
                  pending.id,
                  pending.target,
                ),
                native = verified.records.filter(
                  (r: { meta: { table: string } }) =>
                    m.isNativeSyncTable(r.meta.table),
                );
              let fenced = false;
              try {
                await m.reconstructCanonicalSnapshot(
                  state,
                  verified.records,
                  [],
                );
              } catch (error) {
                fenced = String(error).includes(
                  'Native canonical installation',
                );
              }
              return {
                sealed: typeof state.seal === 'string',
                nativePayments: native.filter(
                  (r: { meta: { table: string } }) =>
                    r.meta.table === 'native_payments',
                ).length,
                nativeActions: native.filter(
                  (r: { meta: { table: string } }) =>
                    r.meta.table === 'native_payment_actions',
                ).length,
                nativeEvents: native.filter(
                  (r: { meta: { table: string } }) =>
                    r.meta.table === 'native_payment_events',
                ).length,
                fenced,
                sourceSales: await source.sales.count(),
                downloadSales: await download.sales.count(),
                downloadPayments: await download.payments.count(),
                downloadOutbox: await download.outbox.count(),
                hashes: (await source.nativePaymentActions.toArray()).map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
              };
            } finally {
              await auth.dispose();
              await source.delete();
              await download.delete();
              await journal.delete();
            }
          },
          { url, seed, pending },
        );
        expect(recovered).toMatchObject({
          sealed: true,
          nativePayments: 2,
          nativeActions: 2,
          fenced: true,
          sourceSales: 1,
          downloadSales: 0,
          downloadPayments: 0,
          downloadOutbox: 0,
          hashes: pending.hashes,
        });
        expect(recovered.nativeEvents).toBeGreaterThan(0);
        expect(
          (
            await server.sql.query(
              'select id from private.native_payment_actions',
            )
          ).rows,
        ).toHaveLength(2);
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
      } finally {
        await server.close();
      }
    },
  );
