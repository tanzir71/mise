import type { PhoneAuth } from '../../apps/web/src/data/phone-auth';
import { test, expect } from '@playwright/test';
import { controlled } from './helpers/pwa';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
import { copySdkSubject } from '../fixtures/original-copy-sdk';
import { newInboxId } from '../../packages/core/inbox';
// @ts-expect-error Test-only browser bundler, never a production route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';
for (const width of [390, 1440])
  test(
    'an actual authorized browser recovers the complete accepted original after uploader deletion and a lost financial response at ' +
      width +
      'px',
    async ({ page, baseURL }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 1000 });
      const apiUrl = new URL(baseURL!).origin,
        publishableKey = 'sb_publishable_link_test',
        server = await nativePaymentTestServer(apiUrl, publishableKey, apiUrl),
        url = new URL('app/native-original-verification.mjs', baseURL!).href,
        body = await nativePaymentQueueBrowserModule();
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      let lost = false;
      await page.route(apiUrl + '/functions/v1/**', async (route) => {
        const request = route.request(),
          response = await server.handle(
            new Request(request.url(), {
              method: request.method(),
              headers: request.headers(),
              body: request.postData(),
            }),
          );
        if (
          !lost &&
          new URL(request.url()).pathname === '/functions/v1/native-payment' &&
          response.ok &&
          (await response.clone().json()).type === 'payment.record'
        ) {
          lost = true;
          await server.sql.query('delete from auth.users where id=$1', [
            copySdkSubject(1),
          ]);
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
        const request = route.request(),
          response = await server.handle(
            new Request(request.url(), { headers: request.headers() }),
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
              db = new m.MiseDatabase('browser-linked-original-source');
            try {
              const setup = await db.saveSetup({
                  businessType: 'corner_shop',
                  marketCode: 'BD',
                  name: 'Original retention browser',
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
        const managerId = newInboxId();
        await server.sql.query(
          "insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,'manager',$5,$5)",
          [
            managerId,
            seed.setup.business.id,
            copySdkSubject(2),
            JSON.stringify('Current manager'),
            Date.now(),
          ],
        );
        await server.sql.query(
          'insert into public.member_outlets values($1,$2,$3)',
          [seed.setup.business.id, managerId, seed.setup.outlet.id],
        );
        const pending = await page.evaluate(
          async ({ url, seed }) => {
            const m = await import(url),
              db = new m.MiseDatabase('browser-linked-original-source'),
              journal = new m.OriginalCopyJournal(
                'browser-linked-original-private',
              );
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
              auth = sdk.auth;
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
                  who: 'Original cash',
                }),
                true,
              );
              let failed = false;
              try {
                await session.deliver();
              } catch {
                failed = true;
              }
              const rows = (await db.nativePaymentActions.toArray()).map(
                  m.parseNativePaymentOutbox,
                ),
                record = rows.find(
                  (r: {
                    original: { invocation: { command: { type: string } } };
                  }) => r.original.invocation.command.type === 'payment.record',
                );
              return {
                failed,
                recordId: record.id,
                hashes: rows.map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
                localSales: await db.sales.count(),
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
        expect(lost).toBe(true);
        expect(pending.failed).toBe(true);
        expect(pending.localSales).toBe(1);
        const accepted = (
          await server.sql.query<{ intent_json: string; receipt: unknown }>(
            'select intent_json,receipt from private.native_payment_actions where id=$1',
            [pending.recordId],
          )
        ).rows[0];
        expect(
          (
            await server.sql.query(
              'select id from private.payment_original_links',
            )
          ).rows,
        ).toHaveLength(2);
        expect(
          (
            await server.sql.query(
              'select id from private.native_original_copies',
            )
          ).rows,
        ).toHaveLength(0);
        await page.reload();
        await controlled(page);
        const recovered = await page.evaluate(
          async ({ url, seed, pending, managerId, accepted }) => {
            const m = await import(url),
              source = new m.MiseDatabase('browser-linked-original-source'),
              target = new m.MiseDatabase(
                'browser-linked-original-empty-target',
              ),
              journal = new m.OriginalCopyJournal(
                'browser-linked-reader-private',
              );
            let auth: PhoneAuth | undefined, reader;
            try {
              const authScope = seed.authScope + '/current-reader',
                sdk = await m.createCopySdk(
                  seed.config,
                  authScope,
                  (url: RequestInfo | URL, init?: RequestInit) =>
                    fetch(url, init),
                  2,
                  localStorage,
                );
              auth = sdk.auth;
              reader = await m.createLinkedPaymentOriginalSession(
                {
                  config: seed.config,
                  authScope,
                  auth,
                  storage: localStorage,
                  journal,
                },
                {
                  businessId: seed.setup.business.id,
                  outletId: seed.setup.outlet.id,
                  actorId: managerId,
                },
              );
              const original = await reader.read(pending.recordId),
                proof = m.readLinkedPaymentOriginal(
                  original.link,
                  JSON.parse(accepted.intent_json),
                  accepted.receipt,
                  original.portable,
                );
              return {
                text: proof.action.source.text,
                reader: reader.identity.actorId,
                origin: original.link.actorId,
                financialKind: proof.action.financial.posting.receipt.kind,
                hashes: (await source.nativePaymentActions.toArray()).map(
                  (r: { originalHash: string }) => r.originalHash,
                ),
                sourceSales: await source.sales.count(),
                targetSales: await target.sales.count(),
                targetPayments: await target.payments.count(),
                targetOutbox: await target.outbox.count(),
              };
            } finally {
              reader?.stop();
              await auth?.dispose();
              await source.delete();
              await target.delete();
              await journal.delete();
            }
          },
          { url, seed, pending, managerId, accepted },
        );
        expect(recovered).toEqual({
          text: seed.item.text,
          reader: managerId,
          origin: seed.setup.owner.id,
          financialKind: 'sale',
          hashes: pending.hashes,
          sourceSales: 1,
          targetSales: 0,
          targetPayments: 0,
          targetOutbox: 0,
        });
        expect(
          (await server.sql.query('select id from public.sales')).rows,
        ).toHaveLength(1);
        expect(
          (
            await server.sql.query(
              'select id from private.native_payment_actions',
            )
          ).rows,
        ).toHaveLength(2);
      } finally {
        await server.close();
      }
    },
  );
