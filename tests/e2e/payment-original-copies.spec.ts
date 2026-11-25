import { test, expect } from '@playwright/test';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated verification module, never shipped.
import { paymentNativeBrowserModule } from '../fixtures/payment-native-browser.mjs';
for (const width of [390, 1440])
  test(
    'private original transfer preparation survives an offline native reload at ' +
      width +
      'px',
    async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 1000 });
      const url = new URL('app/original-copy-verification.mjs', baseURL!).href,
        body = await paymentNativeBrowserModule();
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      await page.goto('app/');
      await controlled(page);
      const saved = await page.evaluate(async (url) => {
        const m = await import(url),
          db = new m.MiseDatabase('browser-copy-source'),
          journal = new m.OriginalCopyJournal('browser-original-copy');
        try {
          const setup = await db.saveSetup({
              businessType: 'corner_shop',
              marketCode: 'BD',
              name: 'Private original',
              phone: '01712345482',
            }),
            scope = {
              businessId: setup.business.id,
              outletId: setup.outlet.id,
              actorId: setup.owner.id,
            },
            item = await db.captureInbox({ text: 'Unknown Tk 15.25\0\ud800' }),
            review = await m.openSavedPaymentSource(db, item.id, scope);
          await m.recordSavedPayment(db, review, {
            checked: true,
            amount: 1525,
            currency: 'BDT',
            method: 'cash',
            methodName: 'Cash',
            reference: '',
            receivedAt: item.createdAt,
          });
          const basis = await m.retainPaymentOriginal(
              db,
              await db.readBackup(),
            ),
            portable = (await db.readPortableBackup()).portable,
            id = m.newInboxId(),
            identity = {
              ...scope,
              targetHash: 'a'.repeat(64),
              accountHash: 'b'.repeat(64),
            };
          const manifest = await journal.prepare(
            portable,
            identity,
            id,
            () => {},
          );
          return { id, identity, manifest, basis };
        } finally {
          db.close();
          journal.close();
        }
      }, url);
      await context.setOffline(true);
      await page.reload();
      await controlled(page);
      const proof = await page.evaluate(
        async ({ url, saved }) => {
          const m = await import(url),
            journal = new m.OriginalCopyJournal('browser-original-copy'),
            db = new m.MiseDatabase('browser-copy-source');
          try {
            const row = await journal.copies.get(saved.id),
              values = await journal.values.toArray();
            let calls = 0,
              rejected = false;
            try {
              await journal.deliver(
                saved.id,
                { ...saved.identity, accountHash: 'c'.repeat(64) },
                {
                  scope: {
                    businessId: saved.identity.businessId,
                    outletId: saved.identity.outletId,
                    actorId: saved.identity.actorId,
                  },
                  call: async () => {
                    calls++;
                    throw Error('Offline');
                  },
                },
                () => {},
              );
            } catch {
              rejected = true;
            }
            return {
              manifest: row.manifest,
              receipt: row.receipt,
              verified: row.verified,
              count: values.length,
              containsKey: JSON.stringify([row, values]).includes(
                'sb_publishable_',
              ),
              calls,
              rejected,
              bases: await db.paymentOriginalBases.count(),
              payments: await db.payments.count(),
            };
          } finally {
            db.close();
            journal.close();
          }
        },
        { url, saved },
      );
      expect(proof).toEqual({
        manifest: saved.manifest,
        receipt: null,
        verified: false,
        count: saved.manifest.nodeCount,
        containsKey: false,
        calls: 0,
        rejected: true,
        bases: 1,
        payments: 1,
      });
    },
  );
