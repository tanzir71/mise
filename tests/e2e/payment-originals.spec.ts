import { test, expect, type Page } from '@playwright/test';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated verification bundler; never a shipped app entry.
import { paymentNativeBrowserModule } from '../fixtures/payment-native-browser.mjs';
async function boot(page: Page, baseURL: string) {
  const url = new URL('app/payment-originals-verification.mjs', baseURL).href;
  await page.route(url, async (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: await paymentNativeBrowserModule(),
    }),
  );
  await page.goto('app/');
  return url;
}
test('real browser hashes match independently and original actions remain distinct from changed current financial data', async ({
  page,
  baseURL,
}) => {
  const url = await boot(page, baseURL!);
  const result = await page.evaluate(async (url) => {
    const m = await import(url),
      db = new m.MiseDatabase('original-browser-' + m.newInboxId());
    try {
      const setup = await db.saveSetup({
        businessType: 'corner_shop',
        marketCode: 'BD',
        name: 'Original browser shop',
        phone: '01712345482',
      });
      const item = await db.captureInbox({
        text: 'Unknown received Tk 15.25.\0\ud800 Keep literal source.',
      });
      const review = await m.openSavedPaymentSource(db, item.id, {
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
      const saved = await m.recordSavedPaymentMoney(
        db,
        review,
        await m.compareSavedPaymentMoney(db, review, {
          kind: 'counter',
          who: 'Original customer',
        }),
        true,
      );
      const original = await db.readBackup(),
        plan = m.preparePaymentOriginalBasis(original),
        nodes = new Map<string, string>(
          plan.added.map((n: { digest: string; json: string }) => [
            n.digest,
            n.json,
          ]),
        );
      const hash = async (value: string) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(value),
            ),
          ),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
      for (const n of plan.added)
        if ((await hash(n.json)) !== n.digest)
          throw Error('Independent WebCrypto mismatch');
      const packet = JSON.parse(JSON.stringify(plan)),
        verified = m.verifyPaymentOriginalDelta(packet, () => undefined);
      const action = m.readPaymentOriginalAction(
        packet.basis,
        (key: string) => nodes.get(key),
        {
          root: packet.basis.root,
          paymentId: saved.payment.id,
          revision: saved.payment.revision,
          eventId: saved.payment.eventId,
        },
      );
      await m.undoSavedPaymentMoney(
        db,
        review,
        await m.compareSavedPaymentMoneyUndo(db, review),
        true,
      );
      const current = await db.readBackup();
      let tamperedRejected = false;
      const first = plan.added[0];
      nodes.set(first.digest, first.json + ' ');
      try {
        m.readPaymentOriginalBasis(plan.basis, (key: string) => nodes.get(key));
      } catch {
        tamperedRejected = true;
      }
      return {
        nodes: plan.added.length,
        originalWho: action.financial.receipt.sale.who,
        originalAmount: action.financial.receipt.sale.amount,
        originalRaw: action.source.text,
        sourceBytesRetained:
          verified.snapshot.tables.inboxItems[0].text === item.text,
        currentUndone: !!current.tables.payments[0].postings[0].undo,
        originalUndone: !!action.financial.posting.undo,
        tamperedRejected,
      };
    } finally {
      await db.delete();
    }
  }, url);
  expect(result.nodes).toBeGreaterThan(22);
  expect(result).toMatchObject({
    originalWho: 'Original customer',
    originalAmount: 1525,
    sourceBytesRetained: true,
    currentUndone: true,
    originalUndone: false,
    tamperedRejected: true,
  });
  expect(result.originalRaw).toContain('\0\ud800');
});

test('a complete 5,000-entry original survives an offline test transport reload and restores its own genuine financial undo', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120000);
  const url = await boot(page, baseURL!);
  // This store is a test transport, not a production canonical/outbox adapter.
  // The source and restored financial operations below use real MiseDatabase.
  const prepared = await page.evaluate(async (url) => {
    const m = await import(url),
      db = new m.MiseDatabase('origin-source-' + m.newInboxId()),
      transport = 'origin-test-transport-' + m.newInboxId();
    try {
      const f = await m.seedPaymentStorage(db),
        item = await db.captureInbox({
          text: 'Unknown received Tk 1000.\0\ud800',
        });
      const review = await m.openSavedPaymentSource(db, item.id, {
        businessId: f.setup.business.id,
        outletId: f.setup.outlet.id,
        actorId: f.setup.owner.id,
      });
      await m.recordSavedPayment(db, review, {
        checked: true,
        amount: 100000,
        currency: 'BDT',
        method: 'cash',
        methodName: 'Cash',
        reference: '',
        receivedAt: item.createdAt,
      });
      const saved = await m.recordSavedPaymentMoney(
        db,
        review,
        await m.compareSavedPaymentMoney(db, review, {
          kind: 'credit',
          id: f.account.id,
        }),
        true,
      );
      const plan = m.preparePaymentOriginalBasis(await db.readBackup());
      const store = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(transport, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('nodes');
          r.result.createObjectStore('basis');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = store.transaction(['nodes', 'basis'], 'readwrite');
          for (const n of plan.added)
            tx.objectStore('nodes').add(n.json, n.digest);
          tx.objectStore('basis').add(plan.basis, 'original');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        store.close();
      }
      await m.undoSavedPaymentMoney(
        db,
        review,
        await m.compareSavedPaymentMoneyUndo(db, review),
        true,
      );
      return {
        transport,
        paymentId: saved.payment.id,
        itemId: item.id,
        originalAt: saved.payment.postings[0].at,
      };
    } finally {
      await db.delete();
    }
  }, url);
  await controlled(page);
  await context.setOffline(true);
  await page.reload();
  const result = await page.evaluate(
    async ({ url, prepared }) => {
      const m = await import(url),
        store = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open(prepared.transport);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      let basis: unknown, nodes: Map<string, string>;
      try {
        [basis, nodes] = await Promise.all([
          new Promise<unknown>((resolve, reject) => {
            const r = store
              .transaction('basis')
              .objectStore('basis')
              .get('original');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          }),
          new Promise<Map<string, string>>((resolve, reject) => {
            const values = new Map<string, string>(),
              r = store.transaction('nodes').objectStore('nodes').openCursor();
            r.onsuccess = () => {
              const c = r.result;
              if (!c) {
                resolve(values);
                return;
              }
              values.set(c.key as string, c.value);
              c.continue();
            };
            r.onerror = () => reject(r.error);
          }),
        ]);
      } finally {
        store.close();
      }
      const original = m.readPaymentOriginalBasis(basis, (key: string) =>
        nodes.get(key),
      );
      const db = new m.MiseDatabase('origin-restored-' + m.newInboxId());
      try {
        await db.restoreBackup(
          JSON.stringify(original),
          await db.previewRestore(original),
        );
        const setup = await db.setup(),
          review = await m.openSavedPaymentSource(db, prepared.itemId, {
            businessId: setup.business.id,
            outletId: setup.outlet.id,
            actorId: setup.owner.id,
          });
        const originalPayment = original.tables.payments.find(
            (p: { id: string }) => p.id === prepared.paymentId,
          ),
          before = originalPayment.postings[0];
        const undone = await m.undoSavedPaymentMoney(
          db,
          review,
          await m.compareSavedPaymentMoneyUndo(db, review),
          true,
        );
        return {
          charges: original.tables.creditEntries.filter(
            (e: { type: string }) => e.type === 'charge',
          ).length,
          noteLength: original.tables.customers[0].notes.length,
          originalAt: before.at,
          wasUndone: !!before.undo,
          undoMode: undone.payment.postings[0].undo.mode,
          sourceRaw: original.tables.inboxItems.find(
            (i: { id: string }) => i.id === prepared.itemId,
          ).text,
          online: navigator.onLine,
        };
      } finally {
        await db.delete();
        await new Promise<void>((resolve, reject) => {
          const r = indexedDB.deleteDatabase(prepared.transport);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      }
    },
    { url, prepared },
  );
  expect(result).toMatchObject({
    charges: 5000,
    noteLength: 1000000,
    originalAt: prepared.originalAt,
    wasUndone: false,
    undoMode: 'performed',
    online: false,
  });
  expect(result.sourceRaw).toContain('\0\ud800');
});
