import { expect, test } from '@playwright/test';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated test bundler; not a production entry point.
import { nativePaymentQueueBrowserModule } from '../fixtures/native-payment-queue-browser.mjs';
for (const width of [390, 1440])
  test(
    'actual connected native queue and frozen original reopen offline without financial replay at ' +
      width +
      'px',
    async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 1000 });
      const url = new URL('app/native-payment-queue-verification.mjs', baseURL!)
          .href,
        body = await nativePaymentQueueBrowserModule();
      await page.route(url, (r) =>
        r.fulfill({ contentType: 'text/javascript', body }),
      );
      const requests: string[] = [];
      page.on('request', (r) => requests.push(r.url()));
      await page.goto('app/');
      await controlled(page);
      const saved = await page.evaluate(async (url) => {
        const m = await import(url),
          db = new m.MiseDatabase('browser-native-queue'),
          journal = new m.OriginalCopyJournal('browser-native-queue-copies');
        let sdk, access;
        try {
          const setup = await db.saveSetup({
              businessType: 'corner_shop',
              marketCode: 'BD',
              name: 'Installation-owned native queue',
              phone: '01712345482',
            }),
            item = await db.captureInbox({
              text: 'Unknown Tk 15.25\0\ud800 বাংলা',
            }),
            config = {
              apiUrl: 'https://edge.test',
              publishableKey: 'sb_publishable_browser_queue',
            },
            authScope = '/mise/app/' + setup.business.id;
          sdk = await m.createCopySdk(
            config,
            authScope,
            async () => {
              throw Error('No financial or copy HTTP in this browser case.');
            },
            1,
            localStorage,
          );
          const targetHash = await m.cloudConnectionTarget(
              config,
              authScope,
              sdk.saved.user.id,
            ),
            uploadId = m.newInboxId();
          await db.cloudState.put({
            id: 'binding',
            version: 1,
            uploadId,
            businessId: setup.business.id,
            outletId: setup.outlet.id,
            ownerId: setup.owner.id,
            targetHash,
            manifestHash: 'b'.repeat(64),
            phase: 'ready',
            sequence: 0,
            receipt: {
              id: uploadId,
              businessId: setup.business.id,
              outletId: setup.outlet.id,
              snapshotHash: 'c'.repeat(64),
              at: Date.now(),
              records: 3,
              images: 0,
            },
          });
          access = await m.createNativePaymentAccess(db, {
            config,
            authScope,
            auth: sdk.auth,
            storage: localStorage,
            journal,
            send: sdk.send,
          });
          const review = await m.openQueuedPaymentSource(db, item.id, access);
          await m.recordSavedPayment(db, review, {
            checked: true,
            amount: 1525,
            currency: 'BDT',
            method: 'cash',
            methodName: 'Cash',
            reference: '',
            receivedAt: item.createdAt,
          });
          const posted = await m.recordSavedPaymentMoney(
            db,
            review,
            await m.compareSavedPaymentMoney(db, review, {
              kind: 'counter',
              who: 'Actual customer',
            }),
            true,
          );
          await m.undoSavedPaymentMoney(
            db,
            review,
            await m.compareSavedPaymentMoneyUndo(db, review),
            true,
          );
          const seal = await m.sealNativePaymentBatch(db, access),
            manifest = await access.copies.prepare(seal.copyId);
          return {
            config,
            authScope,
            seal,
            manifest,
            postedId: posted.payment.eventId,
            originals: (await db.nativePaymentActions.toArray()).map(
              (r: { originalHash: string }) => r.originalHash,
            ),
            source: item.text,
          };
        } finally {
          access?.stop();
          await sdk?.auth.dispose();
          db.close();
          journal.close();
        }
      }, url);
      expect(saved.seal.actionIds).toHaveLength(3);
      await context.setOffline(true);
      await page.reload();
      await controlled(page);
      const proof = await page.evaluate(
        async ({ url, saved }) => {
          const m = await import(url),
            db = new m.MiseDatabase('browser-native-queue'),
            journal = new m.OriginalCopyJournal('browser-native-queue-copies');
          const auth = await m.createPhoneAuth(saved.config, saved.authScope, {
            storage: localStorage,
            send: async () => {
              throw Error('Offline');
            },
          });
          let access;
          try {
            await auth.check();
            access = await m.createNativePaymentAccess(db, {
              config: saved.config,
              authScope: saved.authScope,
              auth,
              storage: localStorage,
              journal,
              send: async () => {
                throw Error('Offline copy');
              },
            });
            const original = await m.readSealedNativePaymentAction(
                db,
                saved.postedId,
              ),
              again = await access.copies.prepare(saved.seal.copyId);
            let blocked = false;
            try {
              await access.copies.deliver(saved.seal.copyId);
            } catch {
              blocked = true;
            }
            const rows = (await db.nativePaymentActions.toArray()).map(
                m.parseNativePaymentOutbox,
              ),
              sales = await db.sales.toArray(),
              markers = await db.outbox.toArray();
            return {
              phase: auth.getSnapshot().phase,
              source: original.original.source.text,
              postingUndo: original.original.financial.posting.undo ?? null,
              hashes: rows.map((r: { originalHash: string }) => r.originalHash),
              states: rows.map((r: { state: string }) => r.state),
              copyUnchanged:
                JSON.stringify(again) === JSON.stringify(saved.manifest),
              blocked,
              sales: sales.length,
              voided: typeof sales[0].voidedAt === 'number',
              markersRetained: markers.every(
                (r: {
                  status: string;
                  commands: unknown[];
                  receipts: unknown[];
                }) =>
                  r.status === 'retained' &&
                  !r.commands.length &&
                  !r.receipts.length,
              ),
              newSeal: await m.sealNativePaymentBatch(db, access),
            };
          } finally {
            access?.stop();
            await auth.dispose();
            await db.delete();
            await journal.delete();
          }
        },
        { url, saved },
      );
      expect(proof).toEqual({
        phase: 'offline',
        source: saved.source,
        postingUndo: null,
        hashes: saved.originals,
        states: ['pending', 'pending', 'pending'],
        copyUnchanged: true,
        blocked: true,
        sales: 1,
        voided: true,
        markersRetained: true,
        newSeal: null,
      });
      expect(
        requests.every((v) => new URL(v).origin === new URL(baseURL!).origin),
      ).toBe(true);
    },
  );
