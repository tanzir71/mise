import Dexie from 'dexie';
import { newInboxId } from '@mise/core/inbox';
import {
  isOrderCommand,
  type ShopCommandReceipt,
} from '@mise/core/shop-commands';
import {
  parseLocalOrderReview,
  orderReviewQuote,
  type LocalOrderReview,
  type OrderReviewQuote,
  type OrderReviewOutcome,
} from '@mise/core/order-review-journal';
import { syncDownloadToken } from '@mise/core/sync-download';
import { syncHash } from '@mise/core/sync-read';
import { isLocalInboxRetention } from '@mise/core/local-inbox';
import type { CloudConnection } from '@mise/core/cloud-connection';
import type { MiseDatabase } from './db';
import {
  readLocalActionReviews,
  deliverLocalOutbox,
  localReviewIdentity,
  parseLocalOutboxEntry,
} from './local-outbox';
import { nativeRowHash } from './canonical-writes';
import { prepareOrderReviewSource } from './order-review-source';
import { createCloudOrderReviewRemote } from './cloud-order-review-remote';
import { assertCommandReceipt, type CommandAccount } from './command-request';
import { requestSync } from './sync-session';

type Observation = Awaited<ReturnType<typeof readLocalActionReviews>>[number];
export interface OrderReviewWorkspace {
  source: Observation;
  record: LocalOrderReview | null;
}
export interface OrderReviewOptions {
  config: CloudConnection;
  account: CommandAccount;
  send?: typeof fetch;
}
const same = (a: unknown, b: unknown) =>
  syncDownloadToken(a) === syncDownloadToken(b);
export async function orderQuoteHash(quote: OrderReviewQuote): Promise<string> {
  const { at, expiresAt, ...values } = quote;
  void at;
  void expiresAt;
  return syncHash(new TextEncoder().encode(syncDownloadToken(values)));
}
function tables(db: MiseDatabase) {
  return [
    db.cloudState,
    db.operatorState,
    db.outbox,
    db.syncActionReviews,
    db.orderReviews,
  ];
}
async function source(
  db: MiseDatabase,
  id?: string,
): Promise<OrderReviewWorkspace | null> {
  const observations = await readLocalActionReviews(db);
  let selected: Observation | undefined;
  if (id) selected = observations.find((v) => v.review.id === id);
  else {
    const rows = (await db.outbox.toArray()).sort(
        (a, b) => a.sequence - b.sequence,
      ),
      first = rows.find(
        (r) => r.status !== 'accepted' && !isLocalInboxRetention(r),
      );
    selected = first
      ? observations.find(
          (v) =>
            v.entry.id === first.id &&
            v.review.commandIndex === first.receipts.length,
        )
      : [...observations].reverse().find((v) => v.review.confirmedAt !== null);
  }
  if (
    !selected ||
    !isOrderCommand(selected.command) ||
    selected.command.type === 'order.warning-settings'
  )
    return null;
  const raw = await db.orderReviews.get(selected.review.id);
  if (!raw) return { source: selected, record: null };
  const record = parseLocalOrderReview(raw),
    r = selected.review;
  const packet = await prepareOrderReviewSource(
    {
      ...selected.entry,
      status: 'pending',
      receipts: selected.entry.receipts.slice(0, r.commandIndex),
    },
    r.commandIndex,
    record.packet.id,
    record.packet.replacementId,
  );
  if (
    record.id !== r.id ||
    record.uploadId !== r.uploadId ||
    record.entryId !== r.entryId ||
    record.commandIndex !== r.commandIndex ||
    record.identityHash !== r.identityHash ||
    record.commandHash !== r.commandHash ||
    !same(packet, record.packet) ||
    (record.quoteHash !== null &&
      record.quoteHash !== (await orderQuoteHash(record.quote!))) ||
    (record.quote &&
      [
        record.quote.businessId,
        record.quote.outletId,
        record.quote.actorId,
      ].join(',') !== [r.businessId, r.outletId, r.actorId].join(','))
  )
    throw Error(
      'Keep the complete original order review, source and chosen values.',
    );
  return { source: selected, record };
}
export function readOrderReviewWorkspace(
  db: MiseDatabase,
  id?: string,
): Promise<OrderReviewWorkspace | null> {
  return source(db, id);
}
/** Display availability only. Opening a review still verifies its full source,
 * operator and account independently, including complete original image bytes. */
export async function hasSavedOrderReview(db: MiseDatabase, uploadId: string): Promise<boolean> {
  if (await db.orderReviews.where('uploadId').equals(uploadId).count()) return true;
  const rows = await db.outbox.where('uploadId').equals(uploadId).sortBy('sequence'),
    first = rows.find(row => row.status !== 'accepted' && !isLocalInboxRetention(row)),
    command = first?.commands[first.receipts.length];
  if (!first || first.status !== 'pending' || !command ||
      !isOrderCommand(command) || command.type === 'order.warning-settings') return false;
  return (await db.syncActionReviews.where('uploadId').equals(uploadId).toArray())
    .some(review => review.entryId === first.id && review.commandId === command.id &&
      review.commandIndex === first.receipts.length && review.confirmedAt === null);
}
async function change(
  db: MiseDatabase,
  id: string,
  revision: number | null,
  options: OrderReviewOptions,
  signal: AbortSignal | undefined,
  update: (
    workspace: OrderReviewWorkspace,
  ) => Promise<LocalOrderReview> | LocalOrderReview,
  proof?: object,
): Promise<LocalOrderReview> {
  const authorization = await options.account.getAuth(),
    workspace = await source(db, id);
  if (!workspace) throw Error('Keep the complete original review source.');
  return db.transaction('rw', tables(db), async () => {
    const tx = Dexie.currentTransaction,
      identity = await localReviewIdentity(db),
      raw = await db.orderReviews.get(id),
      current = raw ? parseLocalOrderReview(raw) : null;
    if (
      (current?.revision ?? null) !== revision ||
      !same(current, workspace.record)
    )
      throw Error('The selected review changed. Read its saved state again.');
    const entry = parseLocalOutboxEntry(
      (await db.outbox.get(workspace.source.entry.id))!,
      identity.binding,
    );
    const originalEntryHash = await Dexie.waitFor(nativeRowHash(entry));
    if (
      identity.identityHash !== workspace.source.review.identityHash ||
      (await Dexie.waitFor(
        nativeRowHash({ ...entry, status: 'pending', receipts: [] }),
      )) !== workspace.source.review.sourceHash
    )
      throw Error('Keep the original operator and complete saved source.');
    const r = workspace.source.review;
    if (
      options.account.targetHash !== r.targetHash ||
      options.account.accountHash !== r.accountHash
    )
      throw Error('Verify the original phone account for this saved action.');
    const next = parseLocalOrderReview(
      await Dexie.waitFor(Promise.resolve(update(workspace))),
    );
    if (
      next.id !== r.id ||
      next.identityHash !== r.identityHash ||
      next.revision !== (revision === null ? 0 : revision + 1)
    )
      throw Error('Keep the original review generation.');
    const guard = () => {
      signal?.throwIfAborted();
      const result: unknown = options.account.assertCurrent(authorization);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw Error('Keep a synchronous original-account check.');
      }
      if (proof) assertCommandReceipt(proof);
      if (
        !tx ||
        Dexie.currentTransaction !== tx ||
        !tx.active ||
        tx.db !== db ||
        tx.mode !== 'readwrite'
      )
        throw Error(
          'The saved review transaction expired. Keep the original action.',
        );
    };
    const nextToken = syncDownloadToken(next);
    guard();
    await db.orderReviews.put(next);
    guard();
    const afterIdentity = await localReviewIdentity(db),
      afterEntry = await db.outbox.get(entry.id),
      saved = await db.orderReviews.get(id);
    if (
      afterIdentity.identityHash !== identity.identityHash ||
      !afterEntry ||
      (await Dexie.waitFor(nativeRowHash(afterEntry))) !== originalEntryHash ||
      syncDownloadToken(saved) !== nextToken
    )
      throw Error('Keep the original operator, source and saved review.');
    guard();
    return next;
  });
}
const next = (record: LocalOrderReview, patch: Partial<LocalOrderReview>) => ({
  ...record,
  ...patch,
  revision: record.revision + 1,
});
async function selectedRemote(
  db: MiseDatabase,
  record: LocalOrderReview,
  options: OrderReviewOptions,
) {
  const view = await readOrderReviewWorkspace(db, record.id);
  if (!view) throw Error('Keep the original saved order.');
  const r = view.source.review;
  return createCloudOrderReviewRemote(
    options.config,
    options.account,
    { businessId: r.businessId, outletId: r.outletId, actorId: r.actorId },
    options.send,
  );
}
async function confirm(
  db: MiseDatabase,
  record: LocalOrderReview,
  receipt: ShopCommandReceipt,
  options: OrderReviewOptions,
  signal?: AbortSignal,
) {
  assertCommandReceipt(receipt);
  const command = record.packet.command;
  const before = await readOrderReviewWorkspace(db, record.id);
  if (!before) throw Error('Keep the original source.');
  const existing = before.source.entry.receipts[record.commandIndex];
  if (existing && !same(existing, receipt))
    throw Error('Keep the actual original server outcome.');
  if (!existing)
    await deliverLocalOutbox(
      db,
      options.account.targetHash,
      async (value) => {
        signal?.throwIfAborted();
        assertCommandReceipt(receipt);
        if (value.id !== command.id || !same(value, command))
          throw Error('Review saved actions in their original order.');
        return receipt;
      },
      command.id,
    );
  const actual = await readOrderReviewWorkspace(db, record.id);
  if (
    !actual?.source.entry.receipts[record.commandIndex] ||
    !same(actual.source.entry.receipts[record.commandIndex], receipt)
  )
    throw Error(
      'Keep the server outcome unconfirmed until its original action is acknowledged.',
    );
  const result = await change(
    db,
    record.id,
    record.revision,
    options,
    signal,
    () =>
      next(record, {
        phase: 'confirmed',
        receipt: receipt as LocalOrderReview['receipt'],
      }),
    receipt,
  );
  try {
    await requestSync(db, true);
  } catch {
    /* The genuine outcome is saved; normal sync remains resumable. */
  }
  return result;
}
export async function prepareSavedOrderReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number | null,
  options: OrderReviewOptions,
  signal?: AbortSignal,
): Promise<LocalOrderReview> {
  let record = await change(
    db,
    id,
    expectedRevision,
    options,
    signal,
    async (workspace) => {
      if (workspace.record)
        return next(workspace.record, {
          phase:
            workspace.record.phase === 'confirmed' ? 'confirmed' : 'preparing',
        });
      const r = workspace.source.review,
        packet = await prepareOrderReviewSource(
          workspace.source.entry,
          r.commandIndex,
          newInboxId(),
          newInboxId(),
        );
      return {
        id: r.id,
        version: 1,
        revision: 0,
        uploadId: r.uploadId,
        entryId: r.entryId,
        commandIndex: r.commandIndex,
        identityHash: r.identityHash,
        commandHash: r.commandHash,
        packet,
        phase: 'preparing',
        quote: null,
        quoteHash: null,
        choice: null,
        attempts: [],
        receipt: null,
      };
    },
  );
  if (record.phase === 'confirmed') return record;
  const result = await (
    await selectedRemote(db, record, options)
  ).prepare(record.packet, signal);
  if (result.done) return confirm(db, record, result.receipt, options, signal);
  const quote = orderReviewQuote(result.review),
    quoteHash = await orderQuoteHash(quote);
  record = await change(
    db,
    id,
    record.revision,
    options,
    signal,
    () => next(record, { phase: 'review', quote, quoteHash, choice: null }),
    result.review,
  );
  return record;
}
export async function decideSavedOrderReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number,
  outcome: OrderReviewOutcome,
  options: OrderReviewOptions,
  signal?: AbortSignal,
): Promise<{ record: LocalOrderReview; changed: boolean }> {
  let record = await change(
    db,
    id,
    expectedRevision,
    options,
    signal,
    (workspace) => {
      const r = workspace.record;
      if (
        !r?.quote ||
        !r.quoteHash ||
        !['review', 'deciding', 'unconfirmed'].includes(r.phase) ||
        (r.phase !== 'review' && r.choice !== outcome) ||
        (outcome === 'replaced' && !r.quote.proposal.enabled)
      )
        throw Error(
          'Review the selected current values before choosing an outcome.',
        );
      if (outcome === 'replaced' && r.quote.proposal.enabled) {
        const saved = workspace.source.entry.changes.find(
          (v) =>
            v.table === 'orders' &&
            v.key ===
              ('orderId' in r.packet.command
                ? r.packet.command.orderId
                : undefined),
        )?.after as { currency?: string } | undefined;
        if (saved?.currency !== r.quote.proposal.currency)
          throw Error(
            'Keep the original monetary currency. Withdraw this action and record the correct amount manually.',
          );
      }
      return next(r, {
        phase: 'deciding',
        choice: outcome,
        attempts: [
          ...r.attempts,
          { outcome, quoteHash: r.quoteHash, at: Date.now() },
        ],
      });
    },
  );
  try {
    const request = await selectedRemote(db, record, options),
      fresh = await request.prepare(record.packet, signal);
    if (fresh.done)
      return {
        record: await confirm(db, record, fresh.receipt, options, signal),
        changed: false,
      };
    const quote = orderReviewQuote(fresh.review),
      quoteHash = await orderQuoteHash(quote);
    if (quoteHash !== record.quoteHash)
      return {
        record: await change(
          db,
          id,
          record.revision,
          options,
          signal,
          () =>
            next(record, { phase: 'review', quote, quoteHash, choice: null }),
          fresh.review,
        ),
        changed: true,
      };
    record = await change(
      db,
      id,
      record.revision,
      options,
      signal,
      () => next(record, { quote, quoteHash }),
      fresh.review,
    );
    // No token is persisted. This freshly verified view must match the exact
    // displayed values before the original deliberate choice can be submitted.
    const receipt = await request.resolve(
      { ...record.packet, token: fresh.review.token, outcome },
      signal,
    );
    return {
      record: await confirm(db, record, receipt, options, signal),
      changed: false,
    };
  } catch (error) {
    try {
      await change(db, id, record.revision, options, undefined, () =>
        next(record, { phase: 'unconfirmed' }),
      );
    } catch {
      /* Retain the original durable choice on account/storage changes. */
    }
    throw error;
  }
}
