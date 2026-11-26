import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { nativePaymentTestServer } from '../fixtures/native-payment-server';
import { copySdkSubject } from '../fixtures/original-copy-sdk';
import { newInboxId } from '../../packages/core/inbox';
import { controlled } from './helpers/pwa';
// @ts-expect-error Test-only bundler; never a shipped product route.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';

for (const width of [360, 390, 768, 1024, 1440])
  test(
    'a fresh manager browser installs corrected native history and exports a complete offline cold restore at ' +
      width +
      'px',
    async ({ page, browser, baseURL }) => {
      test.setTimeout(90000);
      const apiUrl = new URL(baseURL!).origin,
        config = {
          apiUrl,
          publishableKey: 'sb_publishable_native_install_test',
        },
        server = await nativePaymentTestServer(
          apiUrl,
          config.publishableKey,
          apiUrl,
        );
      let coldContext:
        Awaited<ReturnType<typeof browser.newContext>> | undefined;
      try {
        const sessionId = copySdkSubject(302),
          managerId = newInboxId(),
          url = new URL('app/native-install-verification.mjs', baseURL!).href,
          body = await nativePaymentQueueBrowserModule(),
          base = new URL('app/', baseURL!).pathname,
          name = 'mise-local:' + base;
        await page
          .context()
          .addInitScript(() =>
            localStorage.setItem(
              'mise.flags',
              JSON.stringify({ paymentText: true, exports: true }),
            ),
          );
        await page.setViewportSize({ width, height: 1000 });
        await page.route(url, (r) =>
          r.fulfill({ contentType: 'text/javascript', body }),
        );
        await page.route(apiUrl + '/functions/v1/**', handle);
        await page.route(apiUrl + '/rest/v1/rpc/**', handle);
        async function handle(route: import('@playwright/test').Route) {
          const r = route.request(),
            response = await server.handle(
              new Request(r.url(), {
                method: r.method(),
                headers: r.headers(),
                body: r.postData(),
              }),
            );
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        }
        await page.goto('app/');
        await controlled(page);
        const f = await page.evaluate(
          async ({ url }) => {
            const v = await import(url),
              source = new v.MiseDatabase('browser-native-install-source');
            try {
              const setup = await source.saveSetup({
                  businessType: 'corner_shop',
                  marketCode: 'BD',
                  name: 'Native original installation',
                  phone: '01712345482',
                }),
                item = await source.captureInbox({
                  text: 'DBBL received Tk 15.25\0\ud800 বাংলা',
                });
              return { setup, item, source: await source.readBackup() };
            } finally {
              source.close();
            }
          },
          { url },
        );
        await server.seed(f.source);
        await server.sql.query(
          "insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,'manager',$5,$5)",
          [
            managerId,
            f.setup.business.id,
            copySdkSubject(2),
            JSON.stringify('Current manager'),
            Date.now(),
          ],
        );
        await server.sql.query(
          'insert into public.member_outlets values($1,$2,$3)',
          [f.setup.business.id, managerId, f.setup.outlet.id],
        );
        await server.sql.query(
          'insert into auth.sessions(id,user_id) values($1,$2)',
          [sessionId, copySdkSubject(2)],
        );
        await page.evaluate(
          async ({ url, config, base, f }) => {
            const v = await import(url),
              source = new v.MiseDatabase('browser-native-install-source'),
              journal = new v.OriginalCopyJournal(
                'browser-native-install-source-originals',
              ),
              authScope = base + '/source-fixture',
              sdk = await v.createCopySdk(
                config,
                authScope,
                fetch,
                1,
                localStorage,
              );
            let session;
            try {
              const targetHash = await v.cloudConnectionTarget(
                  config,
                  authScope,
                  sdk.saved.user.id,
                ),
                uploadId = v.newInboxId();
              await source.cloudState.put({
                id: 'binding',
                version: 1,
                uploadId,
                businessId: f.setup.business.id,
                outletId: f.setup.outlet.id,
                ownerId: f.setup.owner.id,
                targetHash,
                manifestHash: 'b'.repeat(64),
                phase: 'ready',
                sequence: 0,
                receipt: {
                  id: uploadId,
                  businessId: f.setup.business.id,
                  outletId: f.setup.outlet.id,
                  snapshotHash: 'c'.repeat(64),
                  at: Date.now(),
                  records: 3,
                  images: 0,
                },
              });
              session = await v.createNativePaymentOutboxSession(source, {
                config,
                authScope,
                auth: sdk.auth,
                storage: localStorage,
                journal,
              });
              const review = await session.review(f.item.id, {
                sender: 'DBBL',
              });
              await v.recordSavedPayment(source, review, {
                checked: true,
                amount: 1525,
                currency: 'BDT',
                method: 'cash',
                methodName: 'Cash',
                reference: 'TESTBROWSER' + f.item.id,
                receivedAt: f.item.createdAt,
              });
              const recorded = await v.recordSavedPaymentMoney(
                source,
                review,
                await v.compareSavedPaymentMoney(source, review, {
                  kind: 'counter',
                  who: 'Original cash',
                }),
                true,
              );
              await session.deliver();
              const commands = v.createShopCommandRemote(
                config.apiUrl,
                config.publishableKey,
                {
                  scope: authScope,
                  targetHash,
                  accountHash: await v.operatorAccountHash(sdk.saved.user.id),
                  getAuth: () => sdk.auth.commandAuthorization(),
                  assertCurrent: (
                    value: Awaited<
                      ReturnType<typeof sdk.auth.commandAuthorization>
                    >,
                  ) => sdk.auth.assertCommandAuthorization(value),
                },
              );
              await commands.apply(
                {
                  id: v.newInboxId(),
                  type: 'sale.undo',
                  outletId: f.setup.outlet.id,
                  saleId: recorded.payment.postings[0].receipt.id,
                  occurredAt: Date.now(),
                  entryId: null,
                  creditEventId: null,
                },
                f.setup.outlet.currency,
              );
            } finally {
              session?.stop();
              await sdk.auth.dispose();
              await source.delete();
              await journal.delete();
            }
          },
          { url, config, base, f },
        );
        expect(
          (
            await server.sql.query(
              'select id from private.native_payment_actions',
            )
          ).rows,
        ).toHaveLength(2);
        await server.sql.query('delete from auth.users where id=$1', [
          copySdkSubject(1),
        ]);
        const joined = await page.evaluate(
          async ({ url, name, base, config, outletId, sessionId }) => {
            const v = await import(url),
              db = new v.MiseDatabase(name),
              sdk = await v.createCopySdk(
                config,
                v.discoveryAuthScope(base),
                fetch,
                2,
                localStorage,
                sessionId,
              );
            try {
              const options = { config, base, auth: sdk.auth },
                metadata = v.createOperatorRemote(config, () =>
                  sdk.auth.commandAuthorization(),
                ),
                choices = await metadata.list(),
                context = choices.contexts.find(
                  (c: { outletId: string }) => c.outletId === outletId,
                );
              if (!context)
                throw Error('Keep the actual current manager outlet choice.');
              await v.prepareCloudJoin(db, options, context);
              const result = await v.resumeCloudJoin(db, options),
                native = await v.readNativePaymentState(db),
                canonical = await v.readCanonicalState(db);
              return {
                phase: result.phase,
                actor: (await db.setup()).owner.id,
                original: native.projection.payments[0].createdBy,
                eligible:
                  native.projection.current[0].postings[0].currentReceipt
                    .eligible,
                nativeUndo: native.projection.current[0].postings[0].nativeUndo,
                nativeActions: await db.nativePaymentActions.count(),
                outbox: await db.outbox.count(),
                sales: await db.sales.count(),
                bound: native.state.baseHash === canonical.base.hash,
              };
            } finally {
              await sdk.auth.dispose();
              db.close();
            }
          },
          { url, name, base, config, outletId: f.setup.outlet.id, sessionId },
        );
        expect(joined).toEqual({
          phase: 'ready',
          actor: managerId,
          original: f.setup.owner.id,
          eligible: false,
          nativeUndo: null,
          nativeActions: 0,
          outbox: 0,
          sales: 1,
          bound: true,
        });
        await page.goto('app/inbox/' + f.item.id);
        await page
          .getByRole('button', { name: 'Payment', exact: true })
          .click();
        const sheet = page.getByRole('dialog', {
          name: 'Review shared payment',
          exact: true,
        });
        await expect(
          sheet.getByRole('heading', { name: 'Money recorded', exact: true }),
        ).toBeVisible();
        await expect(sheet).toContainText(
          'Use the manual payment form for any new payment.',
        );
        await expect(
          sheet.getByRole('button', {
            name: 'Use manual customer payment',
            exact: true,
          }),
        ).toBeEnabled();
        await expect(
          sheet.getByRole('button', {
            name: 'Copy full original',
            exact: true,
          }),
        ).toBeEnabled();
        await expect(
          sheet.getByRole('button', {
            name: 'Review original undo',
            exact: true,
          }),
        ).toBeDisabled();
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
        await mkdir('qa/screens', { recursive: true });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.screenshot({
          path: 'qa/screens/m41-native-install-' + width + '.png',
          fullPage: true,
        });
        await page.goto('app/counter');
        await page.getByLabel('Calculation', { exact: true }).fill('18');
        await page.locator('.counter-cash').click();
        await expect(
          page.getByLabel('Calculation', { exact: true }),
        ).toHaveValue('');
        expect(
          await page.evaluate(
            async ({ url, name, base, config, sessionId }) => {
              const v = await import(url),
                db = new v.MiseDatabase(name),
                sdk = await v.createCopySdk(
                  config,
                  v.discoveryAuthScope(base),
                  fetch,
                  2,
                  localStorage,
                  sessionId,
                ),
                journal = new v.CloudUploadJournal(
                  'browser-native-install-uploads',
                );
              try {
                return await v.runSyncCycle(db, {
                  config,
                  scope: base + (await db.setup()).business.id,
                  auth: sdk.auth,
                  journal,
                });
              } finally {
                await sdk.auth.dispose();
                db.close();
                await journal.delete();
              }
            },
            { url, name, base, config, sessionId },
          ),
        ).toBe(true);
        expect(
          (
            await server.sql.query(
              'select amount from public.sales where business_id=$1 and voided_at is null',
              [f.setup.business.id],
            )
          ).rows,
        ).toEqual([{ amount: 1800 }]);
        await page.goto('app/settings/exports');
        await expect(page.locator('.exports-page')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        const exportSheet = page.getByRole('dialog', {
          name: 'Export',
          exact: true,
        });
        if (await exportSheet.isVisible())
          await exportSheet
            .getByRole('button', { name: 'Backup and restore', exact: true })
            .click();
        const download = page.waitForEvent('download');
        await page
          .getByRole('button', { name: 'Download JSON backup', exact: true })
          .click();
        const bytes = await readFile((await (await download).path())!);
        expect(JSON.parse(bytes.toString('utf8')).formatVersion).toBe(3);
        coldContext = await browser.newContext({
          baseURL,
          viewport: { width, height: 1000 },
        });
        await coldContext.addInitScript(() =>
          localStorage.setItem(
            'mise.flags',
            JSON.stringify({ paymentText: true, exports: true }),
          ),
        );
        const cold = await coldContext.newPage();
        await cold.route(url, (r) =>
          r.fulfill({ contentType: 'text/javascript', body }),
        );
        await cold.goto('app/');
        await controlled(cold);
        // Warm this exact test module before taking the second physical browser offline.
        await cold.evaluate((url) => import(url).then(() => undefined), url);
        await cold
          .getByRole('button', { name: 'Restore a backup', exact: true })
          .click();
        await coldContext.setOffline(true);
        await cold
          .getByLabel('Choose JSON backup', { exact: true })
          .setInputFiles({
            name: 'mise-native-complete.json',
            mimeType: 'application/json',
            buffer: bytes,
          });
        const preview = cold.getByRole('dialog', {
          name: 'Restore backup',
          exact: true,
        });
        await expect(preview).toContainText('Payment sources');
        await preview
          .getByRole('checkbox', {
            name: 'Restore this shop on this browser',
            exact: true,
          })
          .check();
        await preview
          .getByRole('button', { name: 'Restore this backup', exact: true })
          .click();
        await expect(
          cold.getByRole('heading', {
            name: 'Choose an outlet and member',
            exact: true,
          }),
        ).toBeVisible();
        await cold
          .getByRole('radio', { name: /Current manager · Manager/ })
          .check();
        await cold
          .getByRole('button', { name: 'Continue on this device', exact: true })
          .click();
        await expect(cold.locator('.today-page')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await cold.goto('app/inbox/' + f.item.id);
        await cold
          .getByRole('button', { name: 'Review payment', exact: true })
          .click();
        await expect(
          cold.getByRole('heading', { name: 'Money recorded', exact: true }),
        ).toBeVisible();
        await expect(
          cold.getByRole('dialog', {
            name: 'Review shared payment',
            exact: true,
          }),
        ).toContainText('Use the manual payment form for any new payment.');
        const coldRows = await cold.evaluate(
          async ({ url, name }) => {
            const v = await import(url),
              db = new v.MiseDatabase(name);
            try {
              const n = await v.readNativePaymentState(db);
              return {
                nativeActions: await db.nativePaymentActions.count(),
                outbox: await db.outbox.count(),
                binding: await db.cloudState.count(),
                canonical: await db.syncCanonical.count(),
                mode: n.state.mode,
                origin: n.projection.payments[0].createdBy,
                text: n.projection.payments[0].original.text,
                sales: await db.sales.count(),
              };
            } finally {
              db.close();
            }
          },
          { url, name },
        );
        expect(coldRows).toEqual({
          nativeActions: 0,
          outbox: 0,
          binding: 0,
          canonical: 0,
          mode: 'restored',
          origin: f.setup.owner.id,
          text: f.item.text,
          sales: 2,
        });
        expect(
          await cold.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          (
            await new AxeBuilder({ page: cold })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        await cold.evaluate(() => document.fonts.ready.then(() => undefined));
        await cold.screenshot({
          path: 'qa/screens/m41-native-cold-' + width + '.png',
          fullPage: true,
        });
      } finally {
        await coldContext?.close();
        await server.close();
      }
    },
  );
