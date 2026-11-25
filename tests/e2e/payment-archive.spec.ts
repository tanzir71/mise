import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated native test bundle; never a shipped entry point.
import { paymentNativeBrowserModule } from '../fixtures/payment-native-browser.mjs';
for (const width of [390, 1440])
  test(
    'the ordinary backup controls retain independent payment originals offline at ' +
      width +
      'px',
    async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 1000 });
      await context.addInitScript(() =>
        localStorage.setItem(
          'mise.flags',
          JSON.stringify({ exports: true, paymentText: true }),
        ),
      );
      const url = new URL('app/payment-archive-verification.mjs', baseURL!)
          .href,
        body = await paymentNativeBrowserModule(),
        requests: string[] = [];
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      page.on('request', (r) => requests.push(r.url()));
      await page.goto('app/');
      await controlled(page);
      const saved = await page.evaluate(async (url) => {
        const m = await import(url),
          db = new m.MiseDatabase(
            'mise-local:' + location.pathname.split('/app/')[0] + '/app/',
          );
        try {
          const setup = await db.saveSetup({
              businessType: 'corner_shop',
              marketCode: 'BD',
              name: 'Archive browser shop',
              phone: '01712345482',
            }),
            item = await db.captureInbox({
              text: 'Unknown payment Tk 15.25.\0\ud800 Keep the original source.',
            }),
            review = await m.openSavedPaymentSource(db, item.id, {
              businessId: setup.business.id,
              outletId: setup.outlet.id,
              actorId: setup.owner.id,
            });
          await m.recordSavedPayment(db, review, {
            checked: true,
            amount: 1525,
            currency: 'BDT',
            method: 'cash',
            methodName: 'Cash',
            reference: '',
            receivedAt: item.createdAt,
          });
          const original = await m.recordSavedPaymentMoney(
              db,
              review,
              await m.compareSavedPaymentMoney(db, review, {
                kind: 'counter',
                who: 'Original counter',
              }),
              true,
            ),
            basis = await m.retainPaymentOriginal(db, await db.readBackup());
          await m.undoSavedPaymentMoney(
            db,
            review,
            await m.compareSavedPaymentMoneyUndo(db, review),
            true,
          );
          return {
            ref: {
              root: basis.root,
              paymentId: original.payment.id,
              eventId: original.payment.eventId,
              revision: original.payment.revision,
            },
            raw: item.text,
          };
        } finally {
          db.close();
        }
      }, url);
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
      await controlled(page);
      await context.setOffline(true);
      const download = page.waitForEvent('download');
      await page
        .getByRole('button', { name: 'Download JSON backup', exact: true })
        .click();
      const file = await download,
        bytes = await readFile((await file.path())!);
      expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
        format: 'mise-backup',
        formatVersion: 2,
        schemaVersion: 13,
      });
      await page
        .getByLabel('Choose JSON backup', { exact: true })
        .setInputFiles({
          name: 'archive-backup.json',
          mimeType: 'application/json',
          buffer: bytes,
        });
      const restore = page.getByRole('dialog', {
        name: 'Restore backup',
        exact: true,
      });
      await expect(
        restore.getByRole('heading', {
          name: 'Archive browser shop',
          exact: true,
        }),
      ).toBeVisible();
      await restore
        .getByRole('checkbox', {
          name: 'Replace data in this browser with this backup',
          exact: true,
        })
        .check();
      await restore
        .getByRole('button', { name: 'Restore this backup', exact: true })
        .click();
      await expect(page).toHaveURL(new URL('app/', baseURL!).href);
      const actual = await page.evaluate(
        async ({ url, ref }) => {
          const m = await import(url),
            db = new m.MiseDatabase(
              'mise-local:' + location.pathname.split('/app/')[0] + '/app/',
            );
          try {
            const original = await m.readRetainedPaymentAction(db, ref),
              current = (await db.readBackup()).tables.payments[0];
            return {
              raw: original.source.text,
              originalUndone: !!original.after.postings[0].undo,
              currentUndo: current.postings[0].undo.mode,
              originalInvocation: original.invocation.command.type,
              roots: await db.paymentOriginalBases.count(),
            };
          } finally {
            db.close();
          }
        },
        { url, ref: saved.ref },
      );
      expect(actual).toEqual({
        raw: saved.raw,
        originalUndone: false,
        currentUndo: 'performed',
        originalInvocation: 'payment.record',
        roots: 1,
      });
      expect(
        requests.every((r) => new URL(r).origin === new URL(baseURL!).origin),
      ).toBe(true);
      await test
        .info()
        .attach('restored-payment-archive-' + width + '.json', {
          body: Buffer.from(JSON.stringify(actual)),
          contentType: 'application/json',
        });
    },
  );
