import 'fake-indexeddb/auto';
import { seedPaymentStorage } from './fixtures/payment-storage';
import { inboxImageFile } from './inbox-fixture';
import { paymentInvocationCommand } from '../packages/core/payment-invocations';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MiseDatabase } from '../apps/web/src/data/db';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import { backupToken } from '../packages/core/backup';
import { defaultCreditTerms } from '../packages/core/khata';
import { cloudConnectionTarget } from '../packages/core/cloud-connection';
import { createCopySdk } from './fixtures/original-copy-sdk';
import { OriginalCopyJournal } from '../apps/web/src/data/original-copies';
import { createNativePaymentAccess } from '../apps/web/src/data/native-payment-access';
import {
  sealNativePaymentBatch,
  readSealedNativePaymentAction,
} from '../apps/web/src/data/native-payment-seal';
import { prepareCloudUpload } from '../packages/core/cloud-upload';
import { beginLocalUpload } from '../apps/web/src/data/local-outbox';
import { CloudUploadJournal } from '../apps/web/src/data/cloud-upload';
import { retainPaymentOriginal } from '../apps/web/src/data/payment-original-retention';
import { localSchemaVersion } from '../packages/core/local-outbox';
import { deliverLocalOutbox } from '../apps/web/src/data/local-outbox';
import { parseNativePaymentOutbox } from '../packages/core/native-payment-outbox';
import {
  openSavedPaymentSource,
  openQueuedPaymentSource,
  recordSavedPayment,
  editSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
const dbs: Dexie[] = [],
  clients: Awaited<ReturnType<typeof createCopySdk>>[] = [],
  accesses: { stop(): void }[] = [];
afterEach(async () => {
  for (const a of accesses.splice(0)) a.stop();
  for (const c of clients.splice(0)) await c.auth.dispose();
  for (const d of dbs.splice(0)) await d.delete();
});
async function fixture(bound = false, large = false) {
  const db = new MiseDatabase('native-queue-' + newInboxId());
  dbs.push(db);
  const seeded = large ? await seedPaymentStorage(db) : null;
  const setup =
      seeded?.setup ??
      (await db.saveSetup({
        businessType: 'corner_shop',
        marketCode: 'BD',
        name: 'Native outbox',
        phone: '01712345482',
      })),
    item = await db.captureInbox({
      text: 'Unknown received Tk 15.25\0\ud800 বাংলা',
      ...(large ? { files: [inboxImageFile()] } : {}),
    }),
    scope = {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    },
    input = {
      checked: true as const,
      amount: 1525,
      currency: 'BDT',
      method: 'cash' as const,
      methodName: 'Cash',
      reference: '',
      receivedAt: item.createdAt,
    };
  if (!bound)
    return {
      db,
      setup,
      item,
      scope,
      input,
      review: await openSavedPaymentSource(db, item.id, scope),
      access: null,
      sdk: null,
      seeded,
    };
  const config = {
      apiUrl: 'https://edge.test',
      publishableKey: 'sb_publishable_queue_test',
    },
    authScope = '/mise/app/' + setup.business.id,
    sdk = await createCopySdk(config, authScope, async () => {
      throw Error('No HTTP in local queue test.');
    });
  clients.push(sdk);
  const uploadId = newInboxId(),
    targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    );
  await db.cloudState.put({
    id: 'binding',
    version: 1,
    uploadId,
    businessId: scope.businessId,
    outletId: scope.outletId,
    ownerId: scope.actorId,
    targetHash,
    manifestHash: 'b'.repeat(64),
    phase: 'ready',
    sequence: 0,
    receipt: {
      id: uploadId,
      businessId: scope.businessId,
      outletId: scope.outletId,
      snapshotHash: 'c'.repeat(64),
      at: Date.now(),
      records: 3,
      images: 0,
    },
  });
  const journal = new OriginalCopyJournal('queue-copies-' + newInboxId());
  dbs.push(journal);
  const access = await createNativePaymentAccess(db, {
    config,
    authScope,
    auth: sdk.auth,
    storage: sdk.storage,
    journal,
    send: sdk.send,
  });
  accesses.push(access);
  return {
    db,
    setup,
    item,
    scope,
    input,
    review: await openQueuedPaymentSource(db, item.id, access),
    access,
    sdk,
    seeded,
  };
}
it('the actual local capture retains its invocation and exact literal row changes atomically without a backend binding', async () => {
  const f = await fixture();
  const saved = await recordSavedPayment(f.db, f.review, f.input),
    raw = (await f.db.nativePaymentActions.toArray())[0],
    row = parseNativePaymentOutbox(raw);
  expect(row.id).toBe(saved.payment.eventId);
  expect(row.state).toBe('local');
  expect(row.original.marker).toBeNull();
  expect(row.original.group).toEqual({ id: row.id, index: 0 });
  const digest = createHash('sha256')
    .update(literalToken(['mise-native-payment-original-v1', row.original]))
    .digest('hex');
  expect(row.originalHash).toBe(digest);
  expect(
    row.original.changes.find((c) => c.table === 'payments')!.after,
  ).toEqual(JSON.parse(JSON.stringify(saved.payment)));
  expect(
    JSON.parse(JSON.stringify(row)).original.changes.find(
      (c: { table: string }) => c.table === 'payments',
    ).after.original.text,
  ).toBe(f.item.text);
  expect(saved.payment.original.text).toContain('\0\ud800');
  expect(await f.db.outbox.count()).toBe(0);
  expect(row.seal).toBeNull();
  expect(row.nativeReceipt).toBeNull();
});
it('records actual confirmed credit money and preserves every real child ID in the same native journal', async () => {
  const f = await fixture(),
    person = await f.db.saveCustomer(
      {
        name: 'Customer',
        nickname: '',
        phone: '',
        address: '',
        notes: 'Original\0\ud800',
        tags: [],
      },
      { credit: { ...defaultCreditTerms, allowed: true, limit: 100000 } },
    ),
    account = (await f.db.creditAccounts.toArray()).find(
      (a) => a.customerId === person.id,
    )!;
  await f.db.recordCreditSale({
    accountId: account.id,
    customerId: person.id,
    expression: '30',
  });
  await recordSavedPayment(f.db, f.review, f.input);
  const comparison = await compareSavedPaymentMoney(f.db, f.review, {
      kind: 'credit',
      id: account.id,
    }),
    saved = await recordSavedPaymentMoney(f.db, f.review, comparison, true),
    rows = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    money = rows.find(
      (r) => r.original.invocation.command.type === 'payment.record',
    )!;
  expect(rows).toHaveLength(2);
  const posting = saved.payment.postings![0];
  expect(
    money.original.changes.some(
      (c) => c.table === 'creditEntries' && c.key === posting.receipt.id,
    ),
  ).toBe(true);
  expect(await f.db.creditEntries.get(posting.receipt.id)).toMatchObject({
    amount: 1525,
    type: 'payment',
  });
  expect(money.original.invocation.command).toMatchObject({
    confirmedNewMoney: true,
    target: { kind: 'credit', id: account.id },
  });
  expect(money.state).toBe('local');
});
it('private journal quota failure rolls money and all audit companions back even when an outer caller catches it', async () => {
  const f = await fixture();
  await recordSavedPayment(f.db, f.review, f.input);
  const before = backupToken(await f.db.readBackup()),
    count = await f.db.nativePaymentActions.count(),
    comparison = await compareSavedPaymentMoney(f.db, f.review, {
      kind: 'counter',
      who: 'Counter customer',
    });
  const fail = () => {
    throw new DOMException('Native queue full', 'QuotaExceededError');
  };
  f.db.nativePaymentActions.hook('creating', fail);
  try {
    await expect(
      f.db.transaction('rw', f.db.tables, async () => {
        try {
          await recordSavedPaymentMoney(f.db, f.review, comparison, true);
        } catch {
          /* Must not allow a caught append failure to commit money. */
        }
      }),
    ).rejects.toThrow();
  } finally {
    f.db.nativePaymentActions.hook('creating').unsubscribe(fail);
  }
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(await f.db.nativePaymentActions.count()).toBe(count);
  expect(await f.db.sales.count()).toBe(0);
  expect((await f.db.payments.toArray())[0].postings).toBeUndefined();
  const saved = await recordSavedPaymentMoney(f.db, f.review, comparison, true);
  expect(saved.payment.postings).toHaveLength(1);
  expect(await f.db.nativePaymentActions.count()).toBe(count + 1);
});
it('multiple actual native actions share their physical transaction group in execution order', async () => {
  const f = await fixture();
  await f.db.transaction('rw', f.db.tables, async () => {
    const saved = await recordSavedPayment(f.db, f.review, f.input);
    await editSavedPayment(
      f.db,
      f.review,
      { id: newInboxId(), revision: saved.payment.revision },
      { ...f.input, reference: 'checked-reference' },
    );
  });
  const rows = (await f.db.nativePaymentActions.toArray())
    .map(parseNativePaymentOutbox)
    .sort((a, b) => a.original.group.index - b.original.group.index);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.original.group.index)).toEqual([0, 1]);
  expect(rows[1].original.group.id).toBe(rows[0].id);
  expect(rows[0].original.group.id).toBe(rows[0].id);
  expect(rows[0].original.invocation.command.type).toBe('payment.capture');
  expect(rows[1].original.invocation.command.type).toBe('payment.edit');
});
it('a connected native action occupies the real shared queue position and stops legacy delivery before later work', async () => {
  const f = await fixture(true);
  await recordSavedPayment(f.db, f.review, f.input);
  await f.db.saveCustomer({
    name: 'Later customer',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  const row = parseNativePaymentOutbox(
      (await f.db.nativePaymentActions.toArray())[0],
    ),
    queue = (await f.db.outbox.toArray()).sort(
      (a, b) => a.sequence - b.sequence,
    );
  expect(row.state).toBe('pending');
  expect(row.original.marker).toMatchObject({
    entryId: queue[0].id,
    sequence: 1,
    targetHash: f.access!.identity.targetHash,
    accountHash: f.access!.identity.accountHash,
  });
  expect(queue.map((v) => v.sequence)).toEqual([1, 2]);
  expect(queue[0]).toMatchObject({
    version: 1,
    status: 'retained',
    commands: [],
    receipts: [],
  });
  expect(queue[1].commands[0].type).toBe('customer.create');
  let sent = 0;
  await deliverLocalOutbox(f.db, f.access!.identity.targetHash, async () => {
    sent++;
    throw Error('Must not pass the native barrier.');
  });
  expect(sent).toBe(0);
  expect((await f.db.cloudState.get('binding'))!.sequence).toBe(2);
  const privateBytes = JSON.stringify(row);
  for (const value of [
    'https://edge.test',
    'sb_publishable_queue_test',
    f.sdk!.access,
    f.sdk!.saved.refresh_token,
    f.sdk!.saved.user.id,
  ])
    expect(privateBytes).not.toContain(value);
});
it('plain connected reviews cannot manufacture the SDK capability and have no partial native writes', async () => {
  const f = await fixture(true),
    plain = await openSavedPaymentSource(f.db, f.item.id, f.scope);
  expect(Object.isFrozen(f.access)).toBe(true);
  expect(Object.isFrozen(f.access!.copies)).toBe(true);
  await expect(recordSavedPayment(f.db, plain, f.input)).rejects.toThrow(
    'not enabled',
  );
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(0);
  await expect(
    openQueuedPaymentSource(
      f.db,
      f.item.id,
      JSON.parse(JSON.stringify(f.access)),
    ),
  ).rejects.toThrow();
});
it('a stop during private append aborts the connected domain write and shared queue sequence together', async () => {
  const f = await fixture(true),
    stop = () => {
      f.access!.stop();
    };
  f.db.nativePaymentActions.hook('creating', stop);
  try {
    await expect(recordSavedPayment(f.db, f.review, f.input)).rejects.toThrow();
  } finally {
    f.db.nativePaymentActions.hook('creating').unsubscribe(stop);
  }
  expect(await f.db.payments.count()).toBe(0);
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.outbox.count()).toBe(0);
  expect((await f.db.cloudState.get('binding'))!.sequence).toBe(0);
});
it('native and legacy intents in one bound transaction abort together instead of creating a misleading marker', async () => {
  const f = await fixture(true);
  await expect(
    f.db.transaction('rw', f.db.tables, async () => {
      await recordSavedPayment(f.db, f.review, f.input);
      await f.db.saveCustomer({
        name: 'Mixed',
        nickname: '',
        phone: '',
        address: '',
        notes: '',
        tags: [],
      });
    }),
  ).rejects.toThrow();
  expect(await f.db.payments.count()).toBe(0);
  expect(await f.db.customers.count()).toBe(0);
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.outbox.count()).toBe(0);
});
it('ordinary restore keeps real invocation facts but never creates new outgoing envelopes from historical consent', async () => {
  const f = await fixture();
  await recordSavedPayment(f.db, f.review, f.input);
  const portable = (await f.db.readPortableBackup()).portable;
  await f.db.restoreBackup(portable, await f.db.previewRestore(portable));
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(1);
  expect(
    (await f.db.events.toArray()).some(
      (e) => e.command === paymentInvocationCommand,
    ),
  ).toBe(true);
});
it.each([
  'changed-money',
  'changed-group',
  'changed-marker',
  'fake-receipt',
  'extra-credential',
])(
  'rejects %s metadata instead of changing the retained native intent',
  async (kind) => {
    const f = await fixture();
    await recordSavedPayment(f.db, f.review, f.input);
    const row = structuredClone((await f.db.nativePaymentActions.toArray())[0]);
    if (kind === 'changed-money')
      (
        row.original.changes.find((c) => c.table === 'payments')!.after as {
          amount: number;
        }
      ).amount++;
    if (kind === 'changed-group') row.original.group.index++;
    if (kind === 'changed-marker')
      row.original.marker = {
        entryId: newInboxId(),
        uploadId: newInboxId(),
        sequence: 1,
        accountHash: 'a'.repeat(64),
        targetHash: 'b'.repeat(64),
      };
    if (kind === 'fake-receipt') row.outcomeHash = 'a'.repeat(64);
    if (kind === 'extra-credential')
      Object.assign(row.original, { apiKey: 'sb_publishable_unexpected_test' });
    expect(() => parseNativePaymentOutbox(row)).toThrow();
  },
);

it('seals a cumulative complete original once for actual connected capture, edit and counter money without rewriting invocations', async () => {
  const f = await fixture(true);
  const saved = await recordSavedPayment(f.db, f.review, f.input);
  await editSavedPayment(
    f.db,
    f.review,
    { id: newInboxId(), revision: saved.payment.revision },
    { ...f.input, reference: 'Later checked reference' },
  );
  const comparison = await compareSavedPaymentMoney(f.db, f.review, {
    kind: 'counter',
    who: 'Actual counter',
  });
  await recordSavedPaymentMoney(f.db, f.review, comparison, true);
  const before = (await f.db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    source = backupToken(await f.db.readBackup());
  const seal = await sealNativePaymentBatch(f.db, f.access!);
  expect(seal!.actionIds).toHaveLength(3);
  expect(await f.db.paymentOriginalBases.count()).toBe(1);
  expect(backupToken(await f.db.readBackup())).toBe(source);
  const after = (await f.db.nativePaymentActions.toArray()).map(
    parseNativePaymentOutbox,
  );
  expect(after.map((r) => r.original)).toEqual(before.map((r) => r.original));
  expect(after.map((r) => r.originalHash)).toEqual(
    before.map((r) => r.originalHash),
  );
  expect(
    after.every(
      (r) =>
        r.seal!.copyId === seal!.copyId &&
        r.seal!.ref.root === seal!.root &&
        !r.copyReceipt &&
        !r.nativeReceipt,
    ),
  ).toBe(true);
  const first = await readSealedNativePaymentAction(
    f.db,
    saved.payment.eventId,
  );
  expect(first.original.after.reference).toBe('');
  expect(first.original.source.text).toBe(f.item.text);
  const money = after.find(
    (r) => r.original.invocation.command.type === 'payment.record',
  )!;
  const original = await readSealedNativePaymentAction(f.db, money.id);
  expect(original.original.financial!.posting.receipt.id).toBe(
    (await f.db.sales.toArray())[0].id,
  );
  expect(await sealNativePaymentBatch(f.db, f.access!)).toBeNull();
  expect(await f.db.paymentOriginalBases.count()).toBe(1);
  expect(
    (await f.db.outbox.toArray()).every(
      (r) => r.status === 'retained' && !r.receipts.length,
    ),
  ).toBe(true);
});
it('retains one complete basis and both original actions for a shared physical marker', async () => {
  const f = await fixture(true);
  await f.db.transaction('rw', f.db.tables, async () => {
    const saved = await recordSavedPayment(f.db, f.review, f.input);
    await editSavedPayment(
      f.db,
      f.review,
      { id: newInboxId(), revision: saved.payment.revision },
      { ...f.input, reference: 'Second physical action' },
    );
  });
  expect(await f.db.outbox.count()).toBe(1);
  const seal = await sealNativePaymentBatch(f.db, f.access!);
  expect(seal!.actionIds).toHaveLength(2);
  expect(await f.db.paymentOriginalBases.count()).toBe(1);
  for (const id of seal!.actionIds)
    expect(
      (await readSealedNativePaymentAction(f.db, id)).original.invocation,
    ).toBeTruthy();
});
it('sealing never manufactures an outgoing binding for historical local actions', async () => {
  const f = await fixture();
  await recordSavedPayment(f.db, f.review, f.input);
  const before = await f.db.nativePaymentActions.toArray();
  await expect(sealNativePaymentBatch(f.db, {} as never)).rejects.toThrow();
  expect(await f.db.nativePaymentActions.toArray()).toEqual(before);
  expect(await f.db.paymentOriginalBases.count()).toBe(0);
  expect(await f.db.outbox.count()).toBe(0);
});
it('a native batch archive quota failure aborts every root and seal even when its outer caller catches it', async () => {
  const f = await fixture(true);
  await recordSavedPayment(f.db, f.review, f.input);
  const before = await f.db.nativePaymentActions.toArray(),
    source = backupToken(await f.db.readBackup());
  const fail = () => {
    throw new DOMException('Original storage full', 'QuotaExceededError');
  };
  f.db.paymentOriginalBases.hook('creating', fail);
  try {
    await expect(
      f.db.transaction('rw', f.db.tables, async () => {
        try {
          await sealNativePaymentBatch(f.db, f.access!);
        } catch {
          /* Caught failures must not commit partial nodes. */
        }
      }),
    ).rejects.toThrow();
  } finally {
    f.db.paymentOriginalBases.hook('creating').unsubscribe(fail);
  }
  expect(await f.db.paymentOriginalBases.count()).toBe(0);
  expect(await f.db.paymentOriginalNodes.count()).toBe(0);
  expect(await f.db.paymentOriginalValues.count()).toBe(0);
  expect(await f.db.nativePaymentActions.toArray()).toEqual(before);
  expect(backupToken(await f.db.readBackup())).toBe(source);
});
it('an SDK stop during sealing rolls the new archive and seals back while keeping all actual money', async () => {
  const f = await fixture(true);
  await recordSavedPayment(f.db, f.review, f.input);
  const stop = () => {
    f.access!.stop();
  };
  f.db.nativePaymentActions.hook('updating', stop);
  try {
    await expect(sealNativePaymentBatch(f.db, f.access!)).rejects.toThrow();
  } finally {
    f.db.nativePaymentActions.hook('updating').unsubscribe(stop);
  }
  expect(await f.db.paymentOriginalBases.count()).toBe(0);
  expect((await f.db.nativePaymentActions.toArray())[0].seal).toBeNull();
  expect(await f.db.payments.count()).toBe(1);
});
it('rejects a marker changed by unrelated retained work instead of silently skipping it', async () => {
  const f = await fixture(true);
  await recordSavedPayment(f.db, f.review, f.input);
  const marker = (await f.db.outbox.toArray())[0];
  const customer = await f.db.saveCustomer({
    name: 'Unrelated',
    nickname: '',
    phone: '',
    address: '',
    notes: '',
    tags: [],
  });
  await f.db.outbox.put({
    ...marker,
    changes: [
      ...marker.changes,
      {
        table: 'customers',
        key: customer.id,
        before: null,
        after: customer,
      },
    ],
  });
  await expect(sealNativePaymentBatch(f.db, f.access!)).rejects.toThrow();
  expect(await f.db.paymentOriginalBases.count()).toBe(0);
  expect((await f.db.nativePaymentActions.toArray())[0].seal).toBeNull();
});
it('aborts unrelated raw writes attempted after a bound native action in the same physical transaction', async () => {
  const f = await fixture(true);
  await expect(
    f.db.transaction('rw', f.db.tables, async () => {
      await recordSavedPayment(f.db, f.review, f.input);
      await f.db.inboxItems.delete(f.item.id);
    }),
  ).rejects.toThrow();
  expect(await f.db.nativePaymentActions.count()).toBe(0);
  expect(await f.db.payments.count()).toBe(0);
  expect(await f.db.inboxItems.get(f.item.id)).toBeTruthy();
  expect((await f.db.cloudState.get('binding'))!.sequence).toBe(0);
});
it('retains the original sealed revision independently after a later native edit and seals only the new batch', async () => {
  const f = await fixture(true);
  const saved = await recordSavedPayment(f.db, f.review, f.input),
    first = await sealNativePaymentBatch(f.db, f.access!);
  await editSavedPayment(
    f.db,
    f.review,
    { id: newInboxId(), revision: saved.payment.revision },
    { ...f.input, reference: 'After first seal' },
  );
  const second = await sealNativePaymentBatch(f.db, f.access!);
  expect(second!.actionIds).toHaveLength(1);
  expect(second!.copyId).not.toBe(first!.copyId);
  expect(second!.root).not.toBe(first!.root);
  expect(await f.db.paymentOriginalBases.count()).toBe(2);
  expect(
    (await readSealedNativePaymentAction(f.db, saved.payment.eventId)).original
      .after.reference,
  ).toBe('');
  expect((await f.db.payments.get(saved.payment.id))!.reference).toBe(
    'After first seal',
  );
});

it.each(['order', 'credit', 'counter'] as const)(
  'seals genuine %s recording and original undo with all financial children after current receipts change',
  async (kind) => {
    const f = await fixture(true);
    let target: Parameters<typeof compareSavedPaymentMoney>[2];
    if (kind === 'order') {
      const order = await f.db.saveOrder({
        source: 'phone',
        sourceText: 'Actual order',
        name: 'Customer',
        phone: '01712345482',
        type: 'pickup',
        address: '',
        table: '',
        lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 1525 }],
        deliveryFee: 0,
        discount: 0,
        payment: { method: 'cash' },
      });
      target = { kind: 'order', id: order.id };
    } else if (kind === 'credit') {
      const customer = await f.db.saveCustomer(
        {
          name: 'Credit customer',
          nickname: '',
          phone: '',
          address: '',
          notes: '',
          tags: [],
        },
        { credit: { ...defaultCreditTerms, allowed: true, limit: 100000 } },
      );
      const account = (await f.db.creditAccounts.toArray()).find(
        (a) => a.customerId === customer.id,
      )!;
      await f.db.recordCreditSale({
        accountId: account.id,
        customerId: customer.id,
        expression: '30',
      });
      target = { kind: 'credit', id: account.id };
    } else target = { kind: 'counter', who: 'Counter customer' };
    await recordSavedPayment(f.db, f.review, f.input);
    const posted = await recordSavedPaymentMoney(
      f.db,
      f.review,
      await compareSavedPaymentMoney(f.db, f.review, target),
      true,
    );
    const undone = await undoSavedPaymentMoney(
      f.db,
      f.review,
      await compareSavedPaymentMoneyUndo(f.db, f.review),
      true,
    );
    const queue = await f.db.nativePaymentActions.toArray();
    const seal = await sealNativePaymentBatch(f.db, f.access!);
    expect(seal!.actionIds).toHaveLength(3);
    const original = await readSealedNativePaymentAction(
      f.db,
      posted.payment.eventId,
    );
    expect(original.original.financial!.posting.undo).toBeUndefined();
    expect(original.original.financial!.posting.receipt.id).toBe(
      posted.payment.postings![0].receipt.id,
    );
    const undo = await readSealedNativePaymentAction(
      f.db,
      undone.payment.eventId,
    );
    expect(undo.original.financial!.undo!.events.length).toBeGreaterThan(0);
    expect(undo.original.financial!.posting.undo!.eventId).toBe(
      undone.payment.eventId,
    );
    expect(
      (await f.db.nativePaymentActions.toArray()).map((r) => r.original),
    ).toEqual(queue.map((r) => r.original));
    expect(await f.db.paymentOriginalBases.count()).toBe(1);
  },
);
it('seals and cold-opens the actual SDK-bound 5,000-charge, million-code-unit source and genuine collection without truncating or replaying money', async () => {
  const started = performance.now(),
    f = await fixture(true, true),
    seed = f.seeded!;
  await recordSavedPayment(f.db, f.review, f.input);
  const saved = await recordSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoney(
      f.db,
      f.review,
      { kind: 'credit', id: seed.account.id },
      'Full original collection',
    ),
    true,
  );
  const before = backupToken(await f.db.readBackup());
  const seal = await sealNativePaymentBatch(f.db, f.access!);
  expect(seal!.actionIds).toHaveLength(2);
  expect(await f.db.paymentOriginalBases.count()).toBe(1);
  f.db.close();
  await f.db.open();
  const original = await readSealedNativePaymentAction(
    f.db,
    saved.payment.eventId,
  );
  expect(original.original.source.images).toHaveLength(1);
  expect(JSON.stringify(original.original.financial!.target)).toContain(
    'Ledger original',
  );
  expect(original.original.financial!.posting.receipt.id).toBe(
    saved.payment.postings![0].receipt.id,
  );
  const portable = await f.db.readPortableBackup();
  expect(
    portable.current.tables.creditEntries.filter((e) => e.type === 'charge'),
  ).toHaveLength(5000);
  expect(portable.current.tables.customers[0].notes).toBe(seed.largeNote);
  expect(portable.current.tables.customers[0].notes).toHaveLength(1000000);
  expect(backupToken(portable.current)).toBe(before);
  expect(await f.db.creditEntries.count()).toBe(5001);
  expect(await sealNativePaymentBatch(f.db, f.access!)).toBeNull();
  console.log(
    JSON.stringify({
      stage: 'native-queue-seal-scale',
      charges: 5000,
      noteCodeUnits: 1000000,
      images: 1,
      actualCollections: 1,
      actions: 2,
      bases: 1,
      sourceUnchanged: true,
      durationMs: performance.now() - started,
    }),
  );
}, 300000);

it('an orphaned native journal independently blocks legacy initial upload even when current Payments are absent', async () => {
  const f = await fixture(),
    original = await f.db.readBackup(),
    plan = await prepareCloudUpload(original, newInboxId());
  await recordSavedPayment(f.db, f.review, f.input);
  await f.db.payments.clear();
  const journal = new CloudUploadJournal('native-upload-fence-' + newInboxId());
  dbs.push(journal);
  await expect(journal.prepare(f.db, newInboxId())).rejects.toThrow(
    'Native payment',
  );
  await expect(beginLocalUpload(f.db, plan, 'a'.repeat(64))).rejects.toThrow(
    'Native payment',
  );
  expect(await journal.uploads.count()).toBe(0);
  expect(await f.db.cloudState.count()).toBe(0);
  expect(await f.db.nativePaymentActions.count()).toBe(1);
});
it('upgrades an actual schema-30 archive to 31 without inventing outgoing historical actions', async () => {
  const f = await fixture();
  const saved = await recordSavedPayment(f.db, f.review, f.input),
    source = await f.db.readBackup();
  const basis = await retainPaymentOriginal(f.db, source);
  const name = 'native-31-upgrade-' + newInboxId(),
    old = new Dexie(name);
  const tables = f.db.tables.filter((t) => t.name !== 'nativePaymentActions');
  old
    .version(30)
    .stores(
      Object.fromEntries(
        tables.map((t) => [
          t.name,
          [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(
            ',',
          ),
        ]),
      ),
    );
  await old.open();
  try {
    for (const table of tables)
      await old.table(table.name).bulkPut(await table.toArray());
  } finally {
    old.close();
  }
  const next = new MiseDatabase(name);
  dbs.push(next);
  await next.open();
  expect(next.verno).toBe(localSchemaVersion);
  expect(await next.nativePaymentActions.count()).toBe(0);
  expect((await next.paymentOriginalBases.toArray())[0].basis).toEqual(basis);
  expect(backupToken(await next.readBackup())).toBe(backupToken(source));
  expect(
    (await next.events.toArray()).some(
      (e) => e.command === paymentInvocationCommand,
    ),
  ).toBe(true);
  expect((await next.payments.get(saved.payment.id))!.eventId).toBe(
    saved.payment.eventId,
  );
});
