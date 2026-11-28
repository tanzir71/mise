import 'fake-indexeddb/auto';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { MiseDatabase } from '../apps/web/src/data/db';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { nativePaymentCopyJournalName } from '../apps/web/src/data/native-payment-review-session';
import { openConfiguredPaymentSource } from '../apps/web/src/data/payment-review-session';
import { readPaymentReviewFrame } from '../apps/web/src/data/payment-review';
import {
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  savedPaymentReceipt,
  openSavedPaymentSource,
} from '../apps/web/src/data/payment-capture';
import { liveQuery } from 'dexie';
import { createSyncRuntime } from '../apps/web/src/data/sync-runtime';
import { syncWaitingCount } from '../apps/web/src/data/native-payment-sync-source';
import { readNativePaymentState } from '../apps/web/src/data/native-payment-state';
import { backupFile } from '../apps/web/src/data/export-files';
import { parseNativePaymentBackup } from '../packages/core/native-payment-backup';
import { readPaymentOriginalBasis } from '../packages/core/payment-originals';
import { newInboxId } from '../packages/core/inbox';
import { creditBalance } from '../packages/core/khata';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { inboxImageFile } from './inbox-fixture';
import { nativePaymentTestServer } from './fixtures/native-payment-server';
import { uploadNativePaymentFixture } from './fixtures/native-payment-upload';
const config = {
    apiUrl: 'https://native-reconcile-scale.test',
    publishableKey: 'sb_publishable_scale_test',
  },
  origin = 'https://shop.test';
let server: Awaited<ReturnType<typeof nativePaymentTestServer>>;
const cleanup: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  server = await nativePaymentTestServer(
    config.apiUrl,
    config.publishableKey,
    origin,
  );
}, 30000);
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
}, 10000);
afterAll(async () => {
  await server?.close();
});
const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
it('all 5000 charges, million-code-unit note and original image survive actual upload, configured approval, canonical sync and complete cold restore', async () => {
  const start = performance.now(),
    stage = (stage: string) =>
      console.log(
        JSON.stringify({
          stage: 'native-reconcile-scale-' + stage,
          elapsedMs: performance.now() - start,
        }),
      ),
    db = new MiseDatabase('native-reconcile-scale-' + newInboxId());
  cleanup.push(() => db.delete());
  const large = await seedPaymentStorage(db),
    setup = large.setup,
    item = await db.captureInbox({
      text: 'Received Tk 15.25\0\ud800 বাংলা',
      files: [inboxImageFile()],
    }),
    scope = '/app/' + setup.business.id;
  stage('source');
  const send: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    return server.handle(new Request(url, { ...init, headers }));
  };
  const f = await uploadNativePaymentFixture(db, config, scope, send).catch(
      (error) => {
        throw Error(String(error) + ' ' + server.lastError());
      },
    ),
    copies = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
  cleanup.push(async () => {
    await f.sdk.auth.dispose();
    await copies.delete();
    await f.journal.delete();
  });
  stage('uploaded');
  const frame = await readPaymentReviewFrame(db, setup, item.id),
    opened = await openConfiguredPaymentSource(
      db,
      setup,
      item.id,
      frame.key,
      {},
      { storage: f.sdk.storage, auth: f.sdk.auth, send, base: '/app/' },
    );
  cleanup.push(async () => opened.stop());
  await recordSavedPayment(db, opened.review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: 'Complete scale original',
    receivedAt: item.createdAt,
  });
  const payment = (
    await recordSavedPaymentMoney(
      db,
      opened.review,
      await compareSavedPaymentMoney(db, opened.review, {
        kind: 'credit',
        id: large.account.id,
      }),
      true,
    )
  ).payment;
  stage('approved');
  const originals = (await db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.originalHash,
    ]),
    before = (await db.syncSessions.get('active'))!.requested;
  let complete!: () => void,
    failed!: (error: unknown) => void,
    ready!: () => void,
    cycles = 0;
  const done = new Promise<void>((resolve, reject) => {
      complete = resolve;
      failed = reject;
    }),
    watching = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    initial = liveQuery(() => db.syncSessions.get('active')).subscribe({
      next(state) {
        if (state && state.requested > before) {
          initial.unsubscribe();
          ready();
        }
      },
      error: failed,
    }),
    runtime = createSyncRuntime(db, {
      config,
      scope,
      auth: f.sdk.auth,
      storage: f.sdk.storage,
      journal: f.journal,
      send,
      online: () => true,
      onFailure: () =>
        failed(
          Error('The actual runtime could not inspect its original work.'),
        ),
      onBusy(busy) {
        if (busy) {
          cycles++;
          return;
        }
        void db.syncSessions
          .get('active')
          .then(async (state) => {
            if (!state || state.paused) return;
            console.log(
              JSON.stringify({
                stage: 'native-reconcile-scale-cycle',
                cycles,
                problem: state.problem,
                confirmed: state.confirmed,
                requested: state.requested,
              }),
            );
            if (state.problem === 'auth' || state.problem === 'review')
              throw Error(
                'Original runtime requires ' +
                  state.problem +
                  ' ' +
                  server.lastError(),
              );
            if (
              state.lastConfirmedAt &&
              state.confirmed === state.requested &&
              (await db.syncCanonical.count())
            )
              complete();
          })
          .catch(failed);
      },
    });
  cleanup.push(() => runtime.stop());
  try {
    // Let the real queue observer initialize while paused, as it does before an
    // owner presses Resume. Retries preserve the same approvals and 45s lease.
    await Promise.race([watching, done]);
    void runtime.now().catch(failed);
    await done;
  } finally {
    initial.unsubscribe();
    await runtime.stop();
  }
  expect(
    (await db.nativePaymentActions.toArray()).map((r) => [
      r.id,
      r.originalHash,
    ]),
  ).toEqual(originals);
  stage('synced');
  expect(await syncWaitingCount(db)).toBe(0);
  expect(await db.payments.count()).toBe(0);
  const state = await readNativePaymentState(db);
  expect(state!.projection.payments).toEqual([payment]);
  const wire = await backupFile(
      (await db.readCompleteBackup()).portable,
    ).text(),
    decoded = await parseNativePaymentBackup(wire, { fresh: true });
  stage('exported');
  expect(decoded.current.tables.creditEntries).toHaveLength(5001);
  expect(sha(decoded.current.tables.customers[0].notes)).toBe(
    sha(large.largeNote),
  );
  const nodes = new Map(
      decoded.projection.originals.nodes.map((n) => [n.digest, n.json]),
    ),
    basis = readPaymentOriginalBasis(
      decoded.projection.originals.bases[0],
      (key) => nodes.get(key),
    );
  expect(
    basis.tables.creditEntries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(large.entries);
  expect(sha(basis.tables.customers[0].notes)).toBe(sha(large.largeNote));
  expect(basis.tables.inboxItems.find((i) => i.id === item.id)!.images).toEqual(
    decoded.current.tables.inboxItems.find((i) => i.id === item.id)!.images,
  );
  const cold = new MiseDatabase('native-reconcile-cold-' + newInboxId());
  cleanup.push(() => cold.delete());
  await cold.restoreBackup(wire, await cold.previewRestore(wire));
  const coldSetup = (await cold.setup())!,
    review = await openSavedPaymentSource(cold, item.id, {
      businessId: coldSetup.business.id,
      outletId: coldSetup.outlet.id,
      actorId: coldSetup.owner.id,
    });
  expect((await savedPaymentReceipt(cold, review))!.payment).toEqual(payment);
  const entries = await cold.creditEntries.toArray();
  expect(
    entries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(large.entries);
  expect(
    creditBalance((await cold.creditAccounts.get(large.account.id))!, entries),
  ).toBe(498475);
  expect((await cold.customers.toArray())[0].notes).toHaveLength(1000000);
  expect(sha((await cold.customers.toArray())[0].notes)).toBe(
    sha(large.largeNote),
  );
  expect(
    (await cold.readBackup()).tables.inboxItems.find((i) => i.id === item.id)!
      .images,
  ).toEqual(
    decoded.current.tables.inboxItems.find((i) => i.id === item.id)!.images,
  );
  expect(await cold.nativePaymentActions.count()).toBe(0);
  expect(await cold.outbox.count()).toBe(0);
  expect(await cold.cloudState.count()).toBe(0);
  expect(await cold.syncCanonical.count()).toBe(0);
  expect(
    (
      await server.sql.query(
        'select id from public.credit_entries where outlet_id=$1',
        [setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(5001);
  stage('verified');
}, 600000);
