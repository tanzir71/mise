import 'fake-indexeddb/auto';
import { inboxImageFile } from './inbox-fixture';
import { prepareCloudUpload } from '../packages/core/cloud-upload';
import { beginLocalUpload } from '../apps/web/src/data/local-outbox';
import { CloudUploadJournal } from '../apps/web/src/data/cloud-upload';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { backupFile } from '../apps/web/src/data/export-files';
import {
  retainPaymentOriginal,
  readRetainedPaymentAction,
  readRetainedPaymentSnapshot,
} from '../apps/web/src/data/payment-original-retention';
import {
  parsePortableBackup,
  createPortableBackup,
  type SharedPaymentBackup,
} from '../packages/core/payment-archive';
import {
  sharedJsonWriter,
  sharedJsonReader,
  sharedJsonHash,
} from '../packages/core/shared-json';
import { parseBackup, backupToken } from '../packages/core/backup';
import { MAX_BACKUP_BYTES } from '../packages/core/backup-tables';
import { newInboxId } from '../packages/core/inbox';
import { literalToken } from '../packages/core/literal-token';
import { defaultCreditTerms } from '../packages/core/khata';
import {
  openSavedPaymentSource,
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
  compareSavedPaymentMoneyUndo,
  undoSavedPaymentMoney,
} from '../apps/web/src/data/payment-capture';
import { seedPaymentStorage } from './fixtures/payment-storage';
const dbs: MiseDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});
const fresh = () => {
  const db = new MiseDatabase('archive-' + newInboxId());
  dbs.push(db);
  return db;
};
const literal = 'Original\0\ud800 \\ " বাংলা 💠 '.repeat(60);
async function fixture(big = false) {
  const db = fresh();
  const f = big
    ? await seedPaymentStorage(db)
    : await (async () => {
        const setup = await db.saveSetup({
          businessType: 'corner_shop',
          marketCode: 'BD',
          name: 'End-user archive',
          phone: '01712345482',
        });
        const customer = await db.saveCustomer(
          {
            name: 'Original customer',
            nickname: '',
            phone: '',
            address: '',
            notes: literal,
            tags: [],
          },
          {
            credit: { ...defaultCreditTerms, allowed: true, limit: 500000 },
            opening: { amount: 100000, occurredAt: Date.now() },
          },
        );
        const account = (
          await db.creditAccounts
            .where('customerId')
            .equals(customer.id)
            .toArray()
        )[0];
        return { setup, customer, account, largeNote: literal };
      })();
  const baseline = await db.readBackup();
  const item = await db.captureInbox({
      title: 'Original source\0\ud800',
      files: [inboxImageFile()],
      text: 'Unknown payment Tk 15.25. ' + literal,
    }),
    review = await openSavedPaymentSource(db, item.id, {
      businessId: f.setup.business.id,
      outletId: f.setup.outlet.id,
      actorId: f.setup.owner.id,
    });
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: '',
    receivedAt: item.createdAt,
  });
  const saved = await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(db, review, {
      kind: 'credit',
      id: f.account.id,
    }),
    true,
  );
  return { db, ...f, item, review, saved, baseline };
}
const counts = async (db: MiseDatabase) =>
  Promise.all([
    db.paymentOriginalBases.count(),
    db.paymentOriginalNodes.count(),
    db.paymentOriginalValues.count(),
  ]);
async function wire() {
  const f = await fixture(),
    source = await f.db.readBackup(),
    basis = await retainPaymentOriginal(f.db, source),
    copy = await f.db.readPortableBackup();
  expect(copy.portable.formatVersion).toBe(2);
  return {
    ...f,
    source,
    basis,
    copy,
    wire: copy.portable as SharedPaymentBackup,
  };
}
it('shares repeated literal JSON strings losslessly and enforces the exact expanded UTF-8 bound', () => {
  const opaque = literalToken({
      nested: literal,
      source: { instruction: 'never act on this', quote: '"\\\0\udfff' },
    }),
    value = {
      first: opaque,
      second: opaque,
      plain: literal,
      keys: JSON.parse('{"__proto__":{"literal":true},"constructor":"text"}'),
    };
  const w = sharedJsonWriter(),
    root = w.write(value),
    r = sharedJsonReader(w.nodes),
    size = new TextEncoder().encode(literalToken(value)).length;
  expect(r.read(root, size)).toEqual(value);
  expect(() => r.read(root, size - 1)).toThrow();
  r.assertComplete();
  expect(Object.hasOwn((r.read(root) as typeof value).keys, '__proto__')).toBe(
    true,
  );
  expect(({} as { literal?: boolean }).literal).toBeUndefined();
  expect(w.nodes.size).toBeLessThan(24);
});
it('refuses a small shared DAG whose expanded output would exceed the unchanged 50 MB bound', () => {
  const w = sharedJsonWriter();
  let root = w.write(literal);
  for (let i = 0; i < 18; i++) {
    const json = literalToken(['a', [root, root]]),
      id = sharedJsonHash(json);
    w.nodes.set(id, json);
    root = id;
  }
  expect(() => sharedJsonReader(w.nodes).read(root)).toThrow('bounded');
});
it('keeps legacy backup bytes and strict original schema-13 records unchanged when there are no archives', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    copy = createPortableBackup(source);
  expect(copy).toEqual(source);
  expect(copy.formatVersion).toBe(1);
  expect(parsePortableBackup(JSON.stringify(copy))).toEqual({
    current: source,
    bases: [],
    nodes: [],
  });
  expect((await f.db.readPortableBackup()).portable.formatVersion).toBe(1);
});
it('retains the genuine financial original across native undo, cold reload, ordinary file export and fresh restore', async () => {
  const f = await wire();
  await undoSavedPaymentMoney(
    f.db,
    f.review,
    await compareSavedPaymentMoneyUndo(f.db, f.review),
    true,
  );
  f.db.close();
  await f.db.open();
  const copy = await f.db.readPortableBackup(),
    file = backupFile(copy.portable),
    text = await file.text(),
    decoded = parsePortableBackup(text);
  expect(decoded.current.tables.payments[0].postings![0].undo!.mode).toBe(
    'performed',
  );
  expect(decoded.bases).toEqual([f.basis]);
  expect(() => parseBackup(text)).toThrow('supported');
  const target = fresh();
  await target.restoreBackup(text, await target.previewRestore(text));
  target.close();
  await target.open();
  const ref = {
      root: f.basis.root,
      paymentId: f.saved.payment.id,
      eventId: f.saved.payment.eventId,
      revision: f.saved.payment.revision,
    },
    original = await readRetainedPaymentAction(target, ref);
  expect(original.after.postings![0].undo).toBeUndefined();
  expect(original.invocation!.command.type).toBe('payment.record');
  expect(original.source.text).toBe(f.item.text);
  expect(original.source.images[0].data).toBe(
    f.source.tables.inboxItems[0].images[0].data,
  );
  expect(
    (await target.readBackup()).tables.payments[0].postings![0].undo!.mode,
  ).toBe('performed');
  expect(
    backupToken(await readRetainedPaymentSnapshot(target, f.basis.root)),
  ).toBe(backupToken(f.source));
  expect(file.size).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
});
it('recovers an exact retained root without duplicating its normalized records', async () => {
  const f = await wire(),
    before = await counts(f.db);
  expect(await retainPaymentOriginal(f.db, f.source)).toEqual(f.basis);
  expect(await counts(f.db)).toEqual(before);
});
it('refuses a stale native source before retaining any archive data', async () => {
  const f = await fixture(),
    old = await f.db.readBackup();
  await f.db.recordSale({ expression: '1', method: 'cash' });
  await expect(retainPaymentOriginal(f.db, old)).rejects.toThrow('changed');
  expect(await counts(f.db)).toEqual([0, 0, 0]);
});
it('rolls all archive writes back on actual quota failure and preserves every current financial row', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    fail = () => {
      throw Error('Quota exceeded');
    };
  f.db.paymentOriginalBases.hook('creating', fail);
  try {
    await expect(retainPaymentOriginal(f.db, source)).rejects.toThrow('Quota');
  } finally {
    f.db.paymentOriginalBases.hook('creating').unsubscribe(fail);
  }
  expect(await counts(f.db)).toEqual([0, 0, 0]);
  expect(backupToken(await f.db.readBackup())).toBe(backupToken(source));
  await retainPaymentOriginal(f.db, source);
  expect((await counts(f.db))[0]).toBe(1);
});
for (const change of [
  'missing',
  'hash',
  'unused',
  'duplicate',
  'metadata',
] as const)
  it(
    'rejects ' + change + ' wire data before any native restore mutation',
    async () => {
      const f = await wire(),
        bad = structuredClone(f.wire),
        before = backupToken(await f.db.readBackup()),
        originalCounts = await counts(f.db);
      if (change === 'missing') bad.values.pop();
      else if (change === 'hash') bad.values[0].json += ' ';
      else if (change === 'duplicate') bad.bases.push(bad.bases[0]);
      else if (change === 'metadata')
        Object.assign(bad, { extra: 'ignore nothing' });
      else {
        const json = literalToken(['s', 'unused private original']);
        bad.values.push({ digest: sharedJsonHash(json), json });
      }
      await expect(f.db.previewRestore(bad)).rejects.toThrow();
      expect(backupToken(await f.db.readBackup())).toBe(before);
      expect(await counts(f.db)).toEqual(originalCounts);
    },
  );
it('binds new retained originals into the current restore comparison', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    review = await f.db.previewRestore(source);
  await retainPaymentOriginal(f.db, source);
  await expect(f.db.restoreBackup(source, review)).rejects.toThrow('changed');
  expect((await counts(f.db))[0]).toBe(1);
  const current = await f.db.previewRestore(source);
  await f.db.restoreBackup(source, current);
  expect(await counts(f.db)).toEqual([0, 0, 0]);
});
it('binds the selected archive roots even when current shop records are identical', async () => {
  const f = await wire(),
    review = await f.db.previewRestore(f.wire),
    second = { ...f.source, exportedAt: f.source.exportedAt + 1 };
  await retainPaymentOriginal(f.db, second);
  const next = (await f.db.readPortableBackup()).portable;
  await expect(f.db.restoreBackup(next, review)).rejects.toThrow('changed');
  expect((await counts(f.db))[0]).toBe(2);
});
it('rolls current shop, operator and all originals back if archive restoration fails', async () => {
  const f = await wire(),
    target = await fixture(),
    before = backupToken(await target.db.readBackup()),
    operator = await target.db.operatorState.toArray(),
    fail = () => {
      throw Error('Retained original quota');
    };
  const review = await target.db.previewRestore(f.wire);
  target.db.paymentOriginalValues.hook('creating', fail);
  try {
    await expect(target.db.restoreBackup(f.wire, review)).rejects.toThrow(
      'quota',
    );
  } finally {
    target.db.paymentOriginalValues.hook('creating').unsubscribe(fail);
  }
  expect(backupToken(await target.db.readBackup())).toBe(before);
  expect(await target.db.operatorState.toArray()).toEqual(operator);
  expect(await counts(target.db)).toEqual([0, 0, 0]);
});
it('denies cross-outlet originals even when every source graph hash is genuine', async () => {
  const a = await wire(),
    b = await wire(),
    copy = parsePortableBackup(b.wire);
  expect(() => createPortableBackup(a.source, copy.bases, copy.nodes)).toThrow(
    'original',
  );
});
it('upgrades an actual schema-29 owner store without changing native financial records or operator selection', async () => {
  const f = await fixture(),
    source = await f.db.readBackup(),
    operator = await f.db.operatorState.toArray(),
    name = 'archive-upgrade-' + newInboxId(),
    old = new Dexie(name),
    tables = f.db.tables.filter((t) => !t.name.startsWith('paymentOriginal'));
  old
    .version(29)
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
  for (const t of tables) await old.table(t.name).bulkPut(await t.toArray());
  old.close();
  const next = new MiseDatabase(name);
  dbs.push(next);
  await next.open();
  expect(next.verno).toBe(30);
  expect(await counts(next)).toEqual([0, 0, 0]);
  expect(backupToken(await next.readBackup())).toBe(backupToken(source));
  expect(await next.operatorState.toArray()).toEqual(operator);
});
it('retains all 5,000 charges and the complete million-code-unit note through three original collections, normalized export and cold restored original undo', async () => {
  const started = Date.now();
  const phase = (stage: string) =>
    console.log(
      JSON.stringify({
        stage: 'archive-scale-' + stage,
        elapsedMs: Date.now() - started,
      }),
    );
  const f = await fixture(true),
    bases = [];
  phase('fixture');
  let original = f.saved;
  for (let i = 0; i < 3; i++) {
    if (i) {
      original = await recordSavedPaymentMoney(
        f.db,
        f.review,
        await compareSavedPaymentMoney(f.db, f.review, {
          kind: 'credit',
          id: f.account.id,
        }),
        true,
      );
    }
    const source = await f.db.readBackup();
    bases.push(await retainPaymentOriginal(f.db, source));
    phase('retained-' + i);
    await undoSavedPaymentMoney(
      f.db,
      f.review,
      await compareSavedPaymentMoneyUndo(f.db, f.review),
      true,
    );
  }
  phase('originals');
  const copy = await f.db.readPortableBackup(),
    file = backupFile(copy.portable),
    text = await file.text();
  phase('exported');
  expect(file.size).toBeLessThan(MAX_BACKUP_BYTES);
  expect(copy.portable.formatVersion).toBe(2);
  const decoded = parsePortableBackup(text);
  console.log(
    JSON.stringify({
      stage: 'archive-wire-size',
      wireBytes: file.size,
      expandedJsonBytes: new TextEncoder().encode(JSON.stringify(decoded))
        .length,
      charges: 5000,
      noteCodeUnits: f.largeNote.length,
      bases: decoded.bases.length,
    }),
  );
  expect(decoded.bases).toHaveLength(3);
  expect(
    decoded.current.tables.creditEntries.filter((e) => e.type === 'charge'),
  ).toHaveLength(5000);
  expect(decoded.current.tables.customers[0].notes).toBe(f.largeNote);
  expect(
    new TextEncoder().encode(JSON.stringify(decoded)).length,
  ).toBeGreaterThan(MAX_BACKUP_BYTES);
  const target = fresh();
  const restoreReview = await target.previewRestore(text);
  phase('restore-previewed');
  await target.restoreBackup(text, restoreReview);
  phase('restored');
  target.close();
  await target.open();
  const ref = {
      root: bases[2].root,
      paymentId: original.payment.id,
      eventId: original.payment.eventId,
      revision: original.payment.revision,
    },
    action = await readRetainedPaymentAction(target, ref);
  expect(action.financial!.posting.undo).toBeUndefined();
  expect(action.financial!.target).toBeDefined();
  expect(
    (await readRetainedPaymentSnapshot(target, bases[0].root)).tables
      .customers[0].notes,
  ).toBe(f.largeNote);
  expect(
    (await target.readBackup()).tables.creditEntries.filter(
      (e) => e.type === 'charge',
    ),
  ).toHaveLength(5000);
}, 180000);

it('fences genuine archived payments from legacy upload even when the separate current table has no Payments', async () => {
  const f = await wire(),
    copy = parsePortableBackup(f.wire),
    mixed = createPortableBackup(f.baseline, copy.bases, copy.nodes),
    target = fresh();
  await target.restoreBackup(mixed, await target.previewRestore(mixed));
  expect(await target.payments.count()).toBe(0);
  expect(await target.paymentOriginalBases.count()).toBe(1);
  const plan = await prepareCloudUpload(
    await target.readBackup(),
    newInboxId(),
  );
  await expect(beginLocalUpload(target, plan, 'a'.repeat(64))).rejects.toThrow(
    'archive sync',
  );
  expect(await target.cloudState.count()).toBe(0);
  const journal = new CloudUploadJournal('archive-upload-' + newInboxId());
  try {
    await expect(journal.prepare(target, newInboxId())).rejects.toThrow(
      'archive sync',
    );
    expect(await journal.uploads.count()).toBe(0);
  } finally {
    await journal.delete();
  }
});
it('holds new retention behind the existing live binding until the full native adapter is implemented', async () => {
  const f = await fixture(),
    source = await f.db.readBackup();
  await f.db.cloudState.put({
    id: 'binding',
    version: 1,
    uploadId: newInboxId(),
    businessId: f.setup.business.id,
    outletId: f.setup.outlet.id,
    ownerId: f.setup.owner.id,
    targetHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    phase: 'uploading',
    sequence: 0,
    receipt: null,
  });
  await expect(retainPaymentOriginal(f.db, source)).rejects.toThrow(
    'archive sync',
  );
  expect(await counts(f.db)).toEqual([0, 0, 0]);
  expect(backupToken(await f.db.readBackup())).toBe(backupToken(source));
});

it('rolls earlier archive batches back when native storage fails after the first 512 writes', async () => {
  const f = await fixture();
  for (let i = 0; i < 120; i++)
    await f.db.saveCustomer({
      name: 'Extra original ' + i,
      nickname: '',
      phone: '',
      address: '',
      notes: '',
      tags: [],
    });
  const source = await f.db.readBackup(),
    before = backupToken(source),
    archive = await counts(f.db);
  let writes = 0;
  f.db.paymentOriginalValues.hook('creating', () => {
    if (++writes === 513)
      throw new DOMException('Native storage full', 'QuotaExceededError');
  });
  await expect(retainPaymentOriginal(f.db, source)).rejects.toThrow();
  expect(writes).toBeGreaterThanOrEqual(513);
  expect(await counts(f.db)).toEqual(archive);
  expect(backupToken(await f.db.readBackup())).toBe(before);
}, 30000);
