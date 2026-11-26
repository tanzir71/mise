import 'fake-indexeddb/auto';
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeCanonicalHarness } from './fixtures/native-canonical-harness';
import { MiseDatabase } from '../apps/web/src/data/db';
import { createOperatorRemote } from '../apps/web/src/data/operator-remote';
import { selectCloudOperator } from '../apps/web/src/data/operator-state';
import { joinCanonicalDevice } from '../apps/web/src/data/cloud-sync-join';
import { readCanonicalState } from '../apps/web/src/data/cloud-canonical-state';
import { readNativePaymentState } from '../apps/web/src/data/native-payment-state';
import { applyCanonicalDownload } from '../apps/web/src/data/cloud-sync-apply';
import { createCloudCoverageRemote } from '../apps/web/src/data/cloud-coverage-remote';
import { downloadSyncImages } from '../apps/web/src/data/cloud-sync-images';
import { backupFile } from '../apps/web/src/data/export-files';
import {
  openSavedPaymentSource,
  savedPaymentReceipt,
} from '../apps/web/src/data/payment-capture';
import { parseNativePaymentBackup } from '../packages/core/native-payment-backup';
import { parseSyncScope } from '../packages/core/sync-read';
import { newInboxId, inboxImageBytes } from '../packages/core/inbox';
import {
  mergeCanonicalRecords,
  type NativeCanonicalRead,
} from '../packages/core/sync-canonical';
import { readPaymentOriginalBasis } from '../packages/core/payment-originals';
import { creditBalance } from '../packages/core/khata';

const config = {
    apiUrl: 'https://native-canonical.test',
    publishableKey: 'sb_publishable_canonical_test',
  },
  origin = 'https://shop.test',
  h = nativeCanonicalHarness(config, origin);
let server: Awaited<ReturnType<typeof h.start>>;
beforeAll(async () => {
  server = await h.start();
}, 30000);
afterEach(async () => h.cleanup());
afterAll(async () => h.close());
const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

it('all 5000 charges, million-code-unit source and original image survive native installation, actual correction, canonical cash coverage and complete cold restore', async () => {
  const start = performance.now(),
    stage = (name: string, extra: Record<string, unknown> = {}) =>
      console.log(
        JSON.stringify({
          stage: 'native-install-scale-' + name,
          elapsedMs: performance.now() - start,
          ...extra,
        }),
      );
  stage('start');
  const f = await h.fixture('credit', true),
    payment = f.recorded.payment,
    posting = payment.postings![0];
  stage('native-accepted');
  // Use the real current clock while the genuine original remains undoable.
  // This independent M37 correction never manufactures a native undo command.
  await f.commands.apply({
    id: newInboxId(),
    type: 'khata.undo',
    outletId: f.setup.outlet.id,
    entryId: posting.receipt.id,
    reversalId: newInboxId(),
    occurredAt: Date.now(),
  });
  const d = await h.download(f),
    target = d.state.source.target,
    records = await mergeCanonicalRecords([], d.records, d.state.id),
    locator = records.find((r) => r.table === 'native_payment_originals')!,
    link = JSON.parse(locator.row!.record_json as string),
    original = await f.sources.read(link.id),
    item = original.decoded.current.tables.inboxItems.find(
      (i) => i.id === f.item.id,
    )!;
  stage('complete-original-read', { readRecords: d.records.length });
  let imageCacheReads = 0;
  await downloadSyncImages(d.db, d.state.id, target, {
    get: async (source) => {
      const image = item.images.find((i) => i.id === source.image.id);
      expect(image).toBeTruthy();
      expect(source.image.type).toBe(image!.type);
      expect(source.image.size).toBe(image!.size);
      imageCacheReads++;
      return new Blob([new Uint8Array(inboxImageBytes(image!)).buffer], {
        type: image!.type,
      });
    },
  });
  expect(imageCacheReads).toBe(1);
  const context = {
      version: 1 as const,
      ...parseSyncScope(d.state.window!),
      businessName: null,
      outletName: null,
      actorName: null,
    },
    metadata = createOperatorRemote(
      config,
      () => f.sdk.auth.commandAuthorization(),
      f.options.send,
    ),
    refresh: Parameters<typeof selectCloudOperator>[4] = (c) =>
      metadata.select(c),
    selected = await selectCloudOperator(
      d.db,
      context,
      { authKey: f.sdk.auth.key, targetHash: target.targetHash },
      null,
      refresh,
    ),
    load: Parameters<typeof joinCanonicalDevice>[5] = async (requested) => {
      const actual = await f.sources.inspect(requested.id);
      expect(actual.retention.copy).toEqual(original.link.retention.copy);
      return { link: actual, portable: original.portable };
    };
  await joinCanonicalDevice(
    d.db,
    {
      readId: d.state.id,
      target,
      authKey: f.sdk.auth.key,
      expectedOperatorRevision: selected.revision,
    },
    refresh,
    undefined,
    undefined,
    load,
  );
  const installed = await readNativePaymentState(d.db);
  expect(installed).not.toBeNull();
  expect(installed!.projection.payments).toEqual([payment]);
  expect(installed!.projection.current[0].postings[0]).toMatchObject({
    receipt: { state: 'same' },
    currentReceipt: { eligible: false },
    nativeUndo: null,
  });
  const all = await d.db.creditEntries.toArray();
  expect(all).toHaveLength(5002);
  expect(
    all
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(f.large!.entries);
  expect(
    creditBalance((await d.db.creditAccounts.get(f.accountId!))!, all),
  ).toBe(500000);
  stage('installed', { nativeValues: installed!.wire.values.length });
  const cash = await d.db.recordSale({
      expression: '3',
      method: 'cash',
      who: 'After native install',
    }),
    queue = await d.db.outbox.toArray();
  await f.commands.apply(queue[0].commands[0]);
  const base = (await readCanonicalState(d.db)).base.snapshot,
    prior: NativeCanonicalRead = {
      format: 'mise-native-canonical-read',
      version: 1,
      current: base.backup,
      records: base.records,
      cursor: base.cursor,
      readId: base.readId,
      seal: base.seal,
      scope: base.scope,
      targetHash: base.targetHash,
      native: installed!.projection,
    },
    next = await h.download(f, prior, d.db),
    operator = (await d.db.operatorState.get('active'))!,
    applied = await applyCanonicalDownload(
      d.db,
      {
        readId: next.state.id,
        target,
        authKey: f.sdk.auth.key,
        expectedOperatorRevision: operator.revision,
      },
      createCloudCoverageRemote(
        config,
        f.options.authScope,
        () => f.sdk.auth.commandAuthorization(),
        f.options.send,
      ),
      refresh,
      undefined,
      undefined,
      load,
    );
  expect(applied.covered).toBe(1);
  expect(applied.pending).toBe(0);
  expect(await d.db.sales.count()).toBe(1);
  expect((await d.db.sales.get(cash.id))?.amount).toBe(300);
  expect(await d.db.outbox.toArray()).toEqual(queue);
  expect(await d.db.nativePaymentActions.count()).toBe(0);
  stage('canonical-covered');
  const exported = await d.db.readCompleteBackup(),
    file = backupFile(exported.portable),
    text = await file.text();
  expect(exported.portable.formatVersion).toBe(3);
  expect(file.size).toBeLessThanOrEqual(50 * 1024 * 1024);
  const decoded = await parseNativePaymentBackup(text, { fresh: true });
  expect(decoded.current.tables.creditEntries).toHaveLength(5002);
  expect(decoded.projection.payments).toEqual([payment]);
  expect(decoded.current.tables.customers[0].notes).toHaveLength(1000000);
  expect(sha(decoded.current.tables.customers[0].notes)).toBe(
    sha(f.large!.largeNote),
  );
  expect(
    decoded.current.tables.inboxItems.find((i) => i.id === f.item.id)!.images,
  ).toEqual(item.images);
  const originalNodes = new Map(
      decoded.projection.originals.nodes.map((n) => [n.digest, n.json]),
    ),
    frozen = readPaymentOriginalBasis(
      decoded.projection.originals.bases[0],
      (key) => originalNodes.get(key),
    );
  expect(
    frozen.tables.creditEntries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(f.large!.entries);
  expect(frozen.tables.creditEntries).toHaveLength(5001);
  expect(sha(frozen.tables.customers[0].notes)).toBe(sha(f.large!.largeNote));
  expect(
    frozen.tables.inboxItems.find((i) => i.id === f.item.id)!.images,
  ).toEqual(item.images);
  stage('file-verified', { fileBytes: file.size });
  const cold = new MiseDatabase('native-scale-cold-' + newInboxId());
  h.stores.push(cold);
  const preview = await cold.previewRestore(text);
  expect(preview.counts.payments).toBe(1);
  expect(preview.counts.creditEntries).toBe(5002);
  await cold.restoreBackup(text, preview);
  const coldState = await readNativePaymentState(cold);
  expect(coldState!.projection.payments).toEqual([payment]);
  const currentEntries = await cold.creditEntries.toArray();
  expect(
    currentEntries
      .filter((e) => e.sequence <= 5000)
      .sort((a, b) => a.sequence - b.sequence),
  ).toEqual(f.large!.entries);
  expect(currentEntries).toHaveLength(5002);
  expect(
    creditBalance(
      (await cold.creditAccounts.get(f.accountId!))!,
      currentEntries,
    ),
  ).toBe(500000);
  expect(sha((await cold.customers.toArray())[0].notes)).toBe(
    sha(f.large!.largeNote),
  );
  expect(
    (await cold.readBackup()).tables.inboxItems.find((i) => i.id === f.item.id)!
      .images,
  ).toEqual(item.images);
  const setup = (await cold.setup())!,
    review = await openSavedPaymentSource(cold, f.item.id, {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    }),
    receipt = await savedPaymentReceipt(cold, review);
  expect(receipt!.payment).toEqual(payment);
  expect(receipt!.associationCurrent).toBe(false);
  expect(receipt!.inspection.postings[0].target).toEqual({
    kind: 'credit',
    id: f.large!.customer.id,
    name: 'Customer',
    nickname: 'Apa',
    currency: 'BDT',
  });
  expect((await cold.creditAccounts.get(f.accountId!))!.customerId).toBe(
    f.large!.customer.id,
  );
  expect(await cold.nativePaymentActions.count()).toBe(0);
  expect(await cold.outbox.count()).toBe(0);
  expect(await cold.cloudState.count()).toBe(0);
  expect(await cold.syncCanonical.count()).toBe(0);
  expect(
    (
      await server.sql.query(
        'select id from public.credit_entries where outlet_id=$1',
        [f.setup.outlet.id],
      )
    ).rows,
  ).toHaveLength(5002);
  expect(
    (
      await server.sql.query(
        'select amount from public.sales where outlet_id=$1',
        [f.setup.outlet.id],
      )
    ).rows,
  ).toEqual([{ amount: 300 }]);
  stage('verified', {
    charges: 5000,
    noteCodeUnits: 1000000,
    images: item.images.length,
    actualCollections: 1,
    actualIndependentReversals: 1,
    explicitCounterSales: 1,
    readRecords: d.records.length,
    fileBytes: file.size,
    nativeActions: coldState!.projection.actions.length,
  });
}, 600000);
