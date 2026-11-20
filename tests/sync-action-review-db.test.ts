import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  CloudUploadJournal,
  uploadWithLocalOutbox,
} from '../apps/web/src/data/cloud-upload';
import {
  deliverLocalOutbox,
  readLocalActionReviews,
} from '../apps/web/src/data/local-outbox';
import { createCloudCommandRemote } from '../apps/web/src/data/cloud-command-remote';
import {
  CommandRequestError,
  commandReviewProof,
  type CommandAuthorization,
} from '../apps/web/src/data/command-request';
import { nativeRowHash } from '../apps/web/src/data/canonical-writes';
import {assertResolutionSources,assertCanonicalResolutions} from '../apps/web/src/data/command-resolution';
import {prepareOrderReviewSource} from '../apps/web/src/data/order-review-source';
import type {CommandResolutionReceipt} from '../packages/core/command-resolution';
import type {AuditEvent} from '../packages/core/models';
import { backupToken } from '../packages/core/backup';
import { parseSyncActionReview } from '../packages/core/sync-action-review';
import {
  parseShopCommand,
  type ShopCommand,
} from '../packages/core/shop-commands';
import { syncHash } from '../packages/core/sync-read';
import {
  cloudUploadFixture,
  MemoryCloudUpload,
  uploadId,
} from './cloud-upload-fixture';
import { testCommandAccount } from './command-account-fixture';

const config = {
  apiUrl: 'https://cloud.test',
  publishableKey: 'sb_publishable_test_only',
};
const databases: Dexie[] = [];
const reviewId='00000000000000000000000091',replacementId='00000000000000000000000092';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});
async function boot(kind: 'cash' | 'order' = 'order') {
  const db = new MiseDatabase('mise-action-review-' + randomUUID()),
    journal = new CloudUploadJournal(
      'mise-action-review-upload-' + randomUUID(),
    );
  databases.push(db, journal);
  const source = cloudUploadFixture();
  await db.restoreBackup(source, await db.previewRestore(source));
  let auth: CommandAuthorization = {
    jwt: 'original.account.signature',
    userId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
  };
  const account = {
    ...testCommandAccount(config, async () => auth.jwt),
    getAuth: async () => ({ ...auth }),
    assertCurrent: (value: CommandAuthorization) => {
      if (value.generation !== auth.generation || value.userId !== auth.userId)
        throw Error('PRIVATE ACCOUNT CHANGE');
    },
  };
  const plan = await journal.prepare(db, uploadId());
  await uploadWithLocalOutbox(
    db,
    journal,
    plan.manifest.id,
    account.targetHash,
    new MemoryCloudUpload(),
  );
  if (kind === 'cash') await db.recordSale({ expression: '5', method: 'cash' });
  else {
    const order = (await db.orders.toArray())[0];
    await db.settleOrder(order.id, { method: 'cash' }, order.revision);
  }
  const original = await db.outbox.toArray(),
    backup = backupToken(await db.readBackup());
  const rejected = (status = 409) =>
    createCloudCommandRemote(
      config,
      account,
      async () => new Response('PRIVATE PROVIDER DETAILS', { status }),
    );
  return {
    db,
    journal,
    account,
    original,
    backup,
    rejected,
    setAuth: (value: Partial<CommandAuthorization>) => {
      auth = { ...auth, ...value };
    },
  };
}
function cashReceipt(c: ShopCommand) {
  if (c.type !== 'sale.record') throw Error('Expected cash');
  return {
    id: c.id,
    type: c.type,
    outletId: c.outletId,
    occurredAt: c.occurredAt,
    saleId: c.saleId,
    accountId: null,
    entryId: null,
    amount: 500,
    at: c.occurredAt + 1,
    saleUpdatedAt: c.occurredAt,
    entrySequence: null,
    undoOf: null,
  };
}
async function reject(
  f: Awaited<ReturnType<typeof boot>>,
  remote = f.rejected(),
) {
  await expect(
    deliverLocalOutbox(f.db, f.account.targetHash, remote),
  ).rejects.toMatchObject({ kind: 'review' });
}
it('retains the exact financial action and original images after a verified conflict, including offline reopen', async () => {
  const f = await boot();
  await reject(f);
  const [review] = await f.db.syncActionReviews.toArray(),
    row = f.original[0];
  expect(review).toMatchObject({
    entryId: row.id,
    uploadId: row.uploadId,
    commandId: row.commands[0].id,
    commandIndex: 0,
    sequence: row.sequence,
    status: 409,
    observations: 1,
    confirmedAt: null,
    receiptHash: null,
  });
  expect(review.commandHash).toBe(
    await syncHash(
      new TextEncoder().encode(
        JSON.stringify(parseShopCommand(row.commands[0])),
      ),
    ),
  );
  expect(review.sourceHash).toBe(
    await nativeRowHash({ ...row, status: 'pending', receipts: [] }),
  );
  expect(await f.db.outbox.toArray()).toEqual(f.original);
  expect(backupToken(await f.db.readBackup())).toBe(f.backup);
  for (const privateValue of [
    config.apiUrl,
    config.publishableKey,
    'signature',
    'PRIVATE',
    '00000000-0000-4000-8000-000000000001',
  ])
    expect(JSON.stringify(review)).not.toContain(privateValue);
  f.db.close();
  const reopened = new MiseDatabase(f.db.name);
  databases.push(reopened);
  expect(await reopened.syncActionReviews.toArray()).toEqual([review]);
  expect(backupToken(await reopened.readBackup())).toBe(f.backup);
  expect(await readLocalActionReviews(reopened)).toEqual([
    { review, entry: row, command: row.commands[0] },
  ]);
});
it('repeated rejection retains the first observation and original source instead of replacing the action', async () => {
  const f = await boot();
  await reject(f);
  const [first] = await f.db.syncActionReviews.toArray();
  await reject(f);
  const [second] = await f.db.syncActionReviews.toArray();
  expect(second).toMatchObject({
    ...first,
    lastObservedAt: expect.any(Number),
    observations: 2,
  });
  expect(second.lastObservedAt).toBeGreaterThanOrEqual(first.lastObservedAt);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('a rejected second command retains the genuine accepted receipt prefix in its original transaction', async () => {
  const f = await boot('cash');
  await f.db.transaction('rw', f.db.tables, async () => {
    await f.db.recordSale({ expression: '5', method: 'cash' });
    await f.db.recordSale({ expression: '5', method: 'cash' });
  });
  const rows = await f.db.outbox.orderBy('[uploadId+sequence]').toArray(),
    original = rows.at(-1)!;
  expect(original.commands).toHaveLength(2);
  const remote = createCloudCommandRemote(
    config,
    f.account,
    async (_url, init) => {
      const command = JSON.parse(init!.body as string);
      return command.id === original.commands[1].id
        ? new Response('', { status: 409 })
        : Response.json(cashReceipt(command));
    },
  );
  await reject(f, remote);
  const saved = (await f.db.outbox.get(original.id))!,
    [review] = await f.db.syncActionReviews.toArray();
  expect(saved.status).toBe('pending');
  expect(saved.receipts).toHaveLength(1);
  expect(saved.commands).toEqual(original.commands);
  expect(review.commandIndex).toBe(1);
  expect(review.commandId).toBe(original.commands[1].id);
  expect(review.receiptsHash).toBe(await nativeRowHash(saved.receipts));
  const read = await readLocalActionReviews(f.db);
  expect(read[0].entry).toEqual(saved);
  expect(read[0].command.id).toBe(original.commands[1].id);
});
it('a genuine later receipt confirms the observation atomically without erasing it or rewriting the command', async () => {
  const f = await boot('cash');
  await reject(f);
  const [originalReview] = await f.db.syncActionReviews.toArray();
  const remote = createCloudCommandRemote(
    config,
    f.account,
    async (_url, init) =>
      new Response(
        JSON.stringify(cashReceipt(JSON.parse(init!.body as string))),
      ),
  );
  await deliverLocalOutbox(f.db, f.account.targetHash, remote);
  const [row] = await f.db.outbox.toArray(),
    [review] = await f.db.syncActionReviews.toArray();
  expect(row.commands).toEqual(f.original[0].commands);
  expect(row.changes).toEqual(f.original[0].changes);
  expect(row.status).toBe('accepted');
  expect(review.receiptHash).toBe(await nativeRowHash(row.receipts[0]));
  expect(review.confirmedAt).toBeGreaterThanOrEqual(review.lastObservedAt);
  expect(review).toMatchObject({
    ...originalReview,
    confirmedAt: expect.any(Number),
    receiptHash: expect.any(String),
  });
  expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it.each([400, 409, 413, 415])(
  'HTTP %s retains only a fixed response status and account-bound proof',
  async (status) => {
    const f = await boot();
    await reject(f, f.rejected(status));
    expect((await f.db.syncActionReviews.toArray())[0].status).toBe(status);
  },
);
it.each([401, 403, 429, 503])(
  'HTTP %s cannot manufacture a financial review observation',
  async (status) => {
    const f = await boot();
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, f.rejected(status)),
    ).rejects.toBeInstanceOf(CommandRequestError);
    expect(await f.db.syncActionReviews.count()).toBe(0);
    expect(await f.db.outbox.toArray()).toEqual(f.original);
  },
);
it('a local or serialized review error is not proof of a server response', async () => {
  const f = await boot();
  for (const error of [
    new CommandRequestError('review'),
    { kind: 'review', status: 409 },
  ]) {
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, async () => {
        throw error;
      }),
    ).rejects.toEqual(error);
    expect(commandReviewProof(error)).toBeNull();
  }
  expect(await f.db.syncActionReviews.count()).toBe(0);
});
it('a different signed-in account after the HTTP conflict cannot attach its error to the original action', async () => {
  const f = await boot(),
    remote = createCloudCommandRemote(config, f.account, async () => {
      f.setAuth({
        userId: '00000000-0000-4000-8000-000000000002',
        generation: 2,
      });
      return new Response('', { status: 409 });
    });
  await expect(
    deliverLocalOutbox(f.db, f.account.targetHash, remote),
  ).rejects.toMatchObject({ kind: 'auth' });
  expect(await f.db.syncActionReviews.count()).toBe(0);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('a verified response for another action cannot be reused as this financial action review', async () => {
  const f = await boot('cash'),
    other = structuredClone(f.original[0].commands[0]);
  other.id = uploadId(998);
  const error = await f
    .rejected()(other)
    .catch((e) => e);
  await expect(
    deliverLocalOutbox(f.db, f.account.targetHash, async () => {
      throw error;
    }),
  ).rejects.toMatchObject({ kind: 'auth' });
  expect(await f.db.syncActionReviews.count()).toBe(0);
});
it('a changed original queue source during HTTP is never recorded as the reviewed action', async () => {
  const f = await boot(),
    remote = createCloudCommandRemote(config, f.account, async () => {
      await f.db.outbox.update(f.original[0].id, { at: f.original[0].at + 1 });
      return new Response('', { status: 409 });
    });
  await expect(
    deliverLocalOutbox(f.db, f.account.targetHash, remote),
  ).rejects.toThrow('source changed');
  expect(await f.db.syncActionReviews.count()).toBe(0);
  expect((await f.db.outbox.toArray())[0].receipts).toEqual([]);
});
it('review storage failure retains the whole original action and shop without fabricating a receipt', async () => {
  const f = await boot(),
    fail = () => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    };
  f.db.syncActionReviews.hook('creating', fail);
  try {
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, f.rejected()),
    ).rejects.toThrow('Storage full');
  } finally {
    f.db.syncActionReviews.hook('creating').unsubscribe(fail);
  }
  expect(await f.db.syncActionReviews.count()).toBe(0);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
  expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('an account change inside the native review write rolls the observation back', async () => {
  const f = await boot(),
    switchAccount = () => {
      f.setAuth({ generation: 3 });
    };
  f.db.syncActionReviews.hook('creating', switchAccount);
  try {
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, f.rejected()),
    ).rejects.toMatchObject({ kind: 'auth' });
  } finally {
    f.db.syncActionReviews.hook('creating').unsubscribe(switchAccount);
  }
  expect(await f.db.syncActionReviews.count()).toBe(0);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
  expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('receipt and review confirmation roll back together if the original account changes inside the write', async () => {
  const f = await boot('cash');
  await reject(f);
  const [original] = await f.db.syncActionReviews.toArray(),
    switchAccount = () => {
      f.setAuth({ generation: 3 });
    };
  f.db.syncActionReviews.hook('updating', switchAccount);
  const remote = createCloudCommandRemote(
    config,
    f.account,
    async (_url, init) =>
      new Response(
        JSON.stringify(cashReceipt(JSON.parse(init!.body as string))),
      ),
  );
  try {
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, remote),
    ).rejects.toMatchObject({ kind: 'auth' });
  } finally {
    f.db.syncActionReviews.hook('updating').unsubscribe(switchAccount);
  }
  expect(await f.db.syncActionReviews.toArray()).toEqual([original]);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('a concurrent retry records one original observation rather than overwriting queue evidence', async () => {
  const f = await boot(),
    remote = f.rejected();
  await Promise.all([reject(f, remote), reject(f, remote)]);
  const reviews = await f.db.syncActionReviews.toArray();
  expect(reviews).toHaveLength(1);
  expect(reviews[0].observations).toBe(2);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('expired review transactions cannot reopen an independent writer', async () => {
  const f = await boot(),
    get = f.db.syncActionReviews.get.bind(f.db.syncActionReviews),
    spy = vi.spyOn(f.db.syncActionReviews, 'get').mockImplementation(((
      id: string,
    ) =>
      get(id).then(async (row) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return row;
      })) as typeof get);
  try {
    await expect(
      deliverLocalOutbox(f.db, f.account.targetHash, f.rejected()),
    ).rejects.toThrow(/review transaction|TransactionInactive|Premature/);
  } finally {
    spy.mockRestore();
  }
  expect(await f.db.syncActionReviews.count()).toBe(0);
  expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('offline review refuses a changed source and refuses a different active operator', async () => {
  const f = await boot();
  await reject(f);
  await f.db.outbox.update(f.original[0].id, { at: f.original[0].at + 1 });
  await expect(readLocalActionReviews(f.db)).rejects.toThrow(
    'complete original action',
  );
  await f.db.outbox.put(f.original[0]);
  const binding = (await f.db.cloudState.get('binding'))!;
  await f.db.operatorState.put({
    id: 'active',
    version: 1,
    revision: 1,
    phase: 'locked',
    businessId: binding.businessId,
    outletId: binding.outletId,
    actorId: binding.ownerId,
    role: 'owner',
    connection: null,
  });
  await expect(readLocalActionReviews(f.db)).rejects.toThrow('operator');
});
it('strict parsing rejects authority fields, missing hashes and invented confirmations', async () => {
  const f = await boot();
  await reject(f);
  const [review] = await f.db.syncActionReviews.toArray();
  for (const patch of [
    { jwt: 'PRIVATE' },
    { sourceHash: '' },
    { receiptHash: 'a'.repeat(64) },
    { confirmedAt: Date.now() },
    { lastObservedAt: review.firstObservedAt - 1 },
    { observations: 0 },
    { commandIndex: -1 },
    { status: 200 },
  ])
    expect(() => parseSyncActionReview({ ...review, ...patch })).toThrow(
      'original saved action',
    );
});
it('schema 21 upgrades with every original source, image and queue intact and the new review store empty', async () => {
  const f = await boot(),
    legacy = new Dexie('mise-action-review-upgrade-' + randomUUID()),
    stores: Record<string, string> = {};
  databases.push(legacy);
  for (const table of f.db.tables.filter((t) => t.name !== 'syncActionReviews'))
    stores[table.name] = [
      table.schema.primKey.src,
      ...table.schema.indexes.map((index) => index.src),
    ].join(',');
  legacy.version(21).stores(stores);
  for (const name of Object.keys(stores))
    await legacy.table(name).bulkPut(await f.db.table(name).toArray());
  legacy.close();
  const upgraded = new MiseDatabase(legacy.name);
  databases.push(upgraded);
  expect(upgraded.verno).toBe(22);
  expect(upgraded.tables).toHaveLength(36);
  expect(await upgraded.syncActionReviews.count()).toBe(0);
  expect(await upgraded.outbox.toArray()).toEqual(f.original);
  expect(backupToken(await upgraded.readBackup())).toBe(f.backup);
  expect(await upgraded.cloudState.toArray()).toEqual(
    await f.db.cloudState.toArray(),
  );
});

async function resolvedOriginal() {
 const x=await boot(),row=structuredClone(x.original[0]);row.commands=row.commands.map(parseShopCommand);
 const packet=await prepareOrderReviewSource(row,0,reviewId,replacementId),command=packet.command;
 const receipt:CommandResolutionReceipt={id:reviewId,type:'command.resolved',commandId:command.id,commandType:command.type,outletId:command.outletId,occurredAt:command.occurredAt,commandHash:await syncHash(new TextEncoder().encode(JSON.stringify(command))),sourceHash:packet.sourceHash,at:Date.now(),outcome:'withdrawn',replacement:null};
 return {...x,row,packet,receipt};
}
it('a genuine resolution stays bound to the complete original queued source and command',async()=>{
 const {row,receipt}=await resolvedOriginal();row.receipts=[receipt];row.status='accepted';await expect(assertResolutionSources(row)).resolves.toBeUndefined();
 const changed=structuredClone(row);changed.at++;await expect(assertResolutionSources(changed)).rejects.toThrow('original resolved action');
 const forged=structuredClone(row);forged.receipts=[{...receipt,commandHash:'f'.repeat(64)}];await expect(assertResolutionSources(forged)).rejects.toThrow('original resolved action');
});
it('fixed-snapshot coverage requires the exact canonical resolution audit before retiring an original action',async()=>{
 const {row,receipt}=await resolvedOriginal();row.receipts=[receipt];row.status='accepted';const covered=new Set([receipt.commandId]);
 const event:AuditEvent={id:receipt.commandId,outletId:receipt.outletId,actor:{type:'member',id:replacementId},command:'sync.resolve',before:{resolutionId:receipt.id,commandHash:receipt.commandHash,sourceHash:receipt.sourceHash},after:{receipt},at:receipt.at};
 expect(()=>assertCanonicalResolutions([row],[event],covered)).not.toThrow();
 for(const events of [[],[{...event,command:'order.payment'}],[{...event,after:{receipt:{...receipt,sourceHash:'e'.repeat(64)}}}],[{...event,at:receipt.at+1}]])expect(()=>assertCanonicalResolutions([row],events,covered)).toThrow('canonical resolution audit');
 expect(()=>assertCanonicalResolutions([row],[],new Set())).not.toThrow();
});
it('large literal order sources remain exact locally while their reviewed financial capsule stays bounded',async()=>{
 const {row,packet}=await resolvedOriginal(),changed=structuredClone(row),large='original literal '.repeat(160000);
 for(const change of changed.changes)if(change.table==='orders')for(const side of ['before','after'] as const){const order=change[side];if(order&&typeof order==='object')change[side]={...order,sourceText:large};}
 const original=structuredClone(changed),review=await prepareOrderReviewSource(changed,0,reviewId,replacementId);expect(review.sourceJson.length).toBeLessThan(10000);expect(review.sourceJson).not.toContain(large);expect(review.sourceHash).not.toBe(packet.sourceHash);expect(changed).toEqual(original);expect(review.command).toEqual(packet.command);
});
it('a source-substituted resolution cannot acknowledge or rewrite the original outbox action',async()=>{
 const {db,account,original,receipt}=await resolvedOriginal(),remote=createCloudCommandRemote(config,account,async()=>new Response(JSON.stringify({...receipt,sourceHash:'d'.repeat(64)}),{headers:{'Content-Type':'application/json'}}));
 await expect(deliverLocalOutbox(db,account.targetHash,remote)).rejects.toThrow('original');expect(await db.outbox.toArray()).toEqual(original);
});
