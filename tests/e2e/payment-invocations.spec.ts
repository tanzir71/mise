import { expect, test } from '@playwright/test';
import { controlled } from './helpers/pwa';
// @ts-expect-error Isolated test-only bundler, never a production entry.
import { paymentNativeBrowserModule } from '../fixtures/payment-native-browser.mjs';

test('native matching choices survive offline reload, original graph lookup and a fresh ordinary restore without a provider account', async ({
  page,
  context,
  baseURL,
}) => {
  const url = new URL('app/payment-invocation-verification.mjs', baseURL!).href,
    body = await paymentNativeBrowserModule(),
    requests: string[] = [];
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/javascript', body }),
  );
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('app/');
  await controlled(page);
  const prepared = await page.evaluate(async (url) => {
    const m = await import(url),
      db = new m.MiseDatabase('browser-invocations-' + m.newInboxId());
    try {
      const setup = await db.saveSetup({
          businessType: 'corner_shop',
          marketCode: 'BD',
          name: 'End user installation',
          phone: '01712345482',
        }),
        sale = await db.recordSale({
          expression: '910',
          method: 'wallet',
          wallet: 'bKash',
        }),
        item = await db.captureInbox({
          text: 'You have received Tk 910. TrxID BROWSERINTENT',
        }),
        destination = {
          businessId: setup.business.id,
          outletId: setup.outlet.id,
          actorId: setup.owner.id,
        },
        review = await m.openSavedPaymentSource(db, item.id, destination, {
          sender: 'bKash',
        });
      await m.recordSavedPayment(db, review, {
        checked: true,
        amount: 91000,
        currency: 'BDT',
        method: 'wallet',
        methodName: 'bKash',
        reference: 'BROWSERINTENT',
        receivedAt: item.createdAt,
      });
      const comparison = await m.compareSavedPayment(db, review, {
          windowMs: 420000,
          receivedTimeConfirmed: true,
        }),
        id = m.newInboxId(),
        saved = await m.associateSavedPayment(
          db,
          review,
          comparison,
          { kind: 'sale', id: sale.id },
          id,
        ),
        events = await db.events.toArray(),
        invocation = m.readNativePaymentInvocation(
          events.find((e: { id: string }) => e.id === id),
          events,
        ),
        plan = m.preparePaymentOriginalBasis(await db.readBackup()),
        nodes = new Map(
          plan.added.map((n: { digest: string; json: string }) => [
            n.digest,
            n.json,
          ]),
        ),
        original = m.readPaymentOriginalAction(
          plan.basis,
          (key: string) => nodes.get(key),
          {
            root: plan.basis.root,
            paymentId: saved.payment.id,
            eventId: id,
            revision: saved.payment.revision,
          },
        );
      return {
        name: db.name,
        itemId: item.id,
        destination,
        id,
        paymentId: saved.payment.id,
        invocation,
        originalInvocation: original.invocation,
        saleId: sale.id,
      };
    } finally {
      db.close();
    }
  }, url);
  expect(prepared.invocation.command).toMatchObject({
    type: 'payment.match',
    mode: 'manual',
    options: { windowMs: 420000, receivedTimeConfirmed: true },
  });
  expect(prepared.originalInvocation).toEqual(prepared.invocation);
  await context.setOffline(true);
  await page.reload();
  await controlled(page);
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/javascript', body }),
  );
  const result = await page.evaluate(
    async ({ url, p }) => {
      const m = await import(url),
        db = new m.MiseDatabase(p.name),
        target = new m.MiseDatabase(
          'browser-invocation-restore-' + m.newInboxId(),
        );
      try {
        const events = await db.events.toArray(),
          read = m.readNativePaymentInvocation(
            events.find((e: { id: string }) => e.id === p.id),
            events,
          ),
          backup = await db.readBackup();
        await target.restoreBackup(
          JSON.stringify(backup),
          await target.previewRestore(backup),
        );
        const restored = await target.events.toArray(),
          again = m.readNativePaymentInvocation(
            restored.find((e: { id: string }) => e.id === p.id),
            restored,
          ),
          saved = await m.savedPaymentReceipt(
            target,
            await m.openSavedPaymentSource(target, p.itemId, p.destination, {
              sender: 'bKash',
            }),
          );
        return {
          read,
          again,
          paymentId: saved.payment.id,
          association: saved.payment.association.id,
          sales: await target.sales.count(),
          entries: await target.creditEntries.count(),
          cloudSettings: await target.cloudState.count(),
          outbox: await target.outbox.count(),
        };
      } finally {
        await db.delete();
        await target.delete();
      }
    },
    { url, p: prepared },
  );
  expect(result).toEqual({
    read: prepared.invocation,
    again: prepared.invocation,
    paymentId: prepared.paymentId,
    association: prepared.saleId,
    sales: 1,
    entries: 0,
    cloudSettings: 0,
    outbox: 0,
  });
  expect(
    requests.every((r) => new URL(r).origin === new URL(baseURL!).origin),
  ).toBe(true);
  await test
    .info()
    .attach('native-invocation-offline-restore.json', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    });
});

test('native invocation quota failure rolls back every financial companion and original retry records money only once', async ({
  page,
  baseURL,
}) => {
  const url = new URL('app/payment-invocation-verification.mjs', baseURL!).href,
    body = await paymentNativeBrowserModule();
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/javascript', body }),
  );
  await page.goto('app/');
  const result = await page.evaluate(async (url) => {
    const m = await import(url),
      db = new m.MiseDatabase('browser-invocation-quota-' + m.newInboxId());
    try {
      const setup = await db.saveSetup({
          businessType: 'corner_shop',
          marketCode: 'BD',
          name: 'Browser invocation rollback',
          phone: '01712345482',
        }),
        item = await db.captureInbox({
          text: 'Unknown payment Tk 10. Keep this complete source.',
        }),
        review = await m.openSavedPaymentSource(db, item.id, {
          businessId: setup.business.id,
          outletId: setup.outlet.id,
          actorId: setup.owner.id,
        });
      await m.recordSavedPayment(db, review, {
        checked: true,
        amount: 1000,
        currency: 'BDT',
        method: 'wallet',
        methodName: 'Bank transfer',
        referenceScope: 'End user bank',
        reference: 'BROWSERQUOTA',
        receivedAt: item.createdAt,
      });
      const comparison = await m.compareSavedPaymentMoney(db, review, {
          kind: 'counter',
          who: 'Original customer',
        }),
        id = m.newInboxId(),
        before = JSON.stringify(await db.readBackup()),
        fail = (
          _key: unknown,
          e: { command: string; after?: { command?: { type?: string } } },
        ) => {
          if (
            e.command === m.paymentInvocationCommand &&
            e.after?.command?.type === 'payment.record'
          )
            throw new DOMException('Invocation quota', 'QuotaExceededError');
        };
      db.events.hook('creating', fail);
      let rejected = false;
      try {
        await m.recordSavedPaymentMoney(db, review, comparison, true, id);
      } catch {
        rejected = true;
      } finally {
        db.events.hook('creating').unsubscribe(fail);
      }
      const after = await db.readBackup(),
        rolledBack =
          JSON.stringify({
            ...after,
            exportedAt: JSON.parse(before).exportedAt,
          }) === before,
        empty = (await db.sales.count()) === 0;
      const saved = await m.recordSavedPaymentMoney(
        db,
        review,
        comparison,
        true,
        id,
      );
      await m.recordSavedPaymentMoney(db, review, comparison, true, id);
      const events = await db.events.toArray(),
        record = m.readNativePaymentInvocation(
          events.find((e: { id: string }) => e.id === id),
          events,
        ),
        undoId = m.newInboxId(),
        undo = await m.compareSavedPaymentMoneyUndo(db, review);
      await m.undoSavedPaymentMoney(db, review, undo, true, undoId);
      await m.undoSavedPaymentMoney(db, review, undo, true, undoId);
      const latest = await db.events.toArray(),
        originalUndo = m.readNativePaymentInvocation(
          latest.find((e: { id: string }) => e.id === undoId),
          latest,
        );
      return {
        rejected,
        rolledBack,
        empty,
        sales: await db.sales.count(),
        voided: (await db.sales.toArray())[0].voidedAt !== undefined,
        entries: await db.creditEntries.count(),
        invocations: latest.filter(
          (e: { command: string }) => e.command === m.paymentInvocationCommand,
        ).length,
        newMoneyConfirmed: record.command.confirmedNewMoney,
        undoConfirmed: originalUndo.command.confirmedUndo,
        childId: saved.payment.postings[0].receipt.id,
        expectedId: m.nativePaymentId(id, 'money-sale'),
      };
    } finally {
      await db.delete();
    }
  }, url);
  expect(result).toMatchObject({
    rejected: true,
    rolledBack: true,
    empty: true,
    sales: 1,
    voided: true,
    entries: 0,
    invocations: 3,
    newMoneyConfirmed: true,
    undoConfirmed: true,
  });
  expect(result.childId).toBe(result.expectedId);
  await test
    .info()
    .attach('native-invocation-atomic-rollback.json', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    });
});
