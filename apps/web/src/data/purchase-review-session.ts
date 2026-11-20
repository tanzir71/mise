import Dexie from 'dexie';
import { newInboxId } from '@mise/core/inbox';
import {
  isPurchaseCommand,
  type ShopCommandReceipt,
} from '@mise/core/shop-commands';
import {
  parseLocalPurchaseReview,
  purchaseReviewQuote,
  purchaseReviewQuoteHash as purchaseQuoteHash,
  type LocalPurchaseReview,
  type PurchaseReviewChoice,
} from '@mise/core/purchase-review-journal';
import { originalPurchaseFacts, type OriginalPurchaseFacts } from '@mise/core/purchase-review';
import { syncDownloadToken } from '@mise/core/sync-download';
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
import { preparePurchaseReviewSource } from './purchase-review-source';
import { createCloudPurchaseReviewRemote } from './cloud-purchase-review-remote';
import { assertCommandReceipt, type CommandAccount } from './command-request';
import { requestSync } from './sync-session';
import {readAcknowledgedPurchaseReview,confirmAcknowledgedPurchaseReview} from './purchase-review-history';

type Observation = Awaited<ReturnType<typeof readLocalActionReviews>>[number];
export interface PurchaseReviewWorkspace {
  source: Observation;
  record: LocalPurchaseReview | null;
  original: OriginalPurchaseFacts;
  acknowledged: boolean;
}
export interface PurchaseReviewOptions {
  config: CloudConnection;
  account: CommandAccount;
  send?: typeof fetch;
}
const same = (a: unknown, b: unknown) =>
  syncDownloadToken(a) === syncDownloadToken(b);
export {purchaseQuoteHash};
function tables(db: MiseDatabase) {
  return [
    db.cloudState,
    db.operatorState,
    db.outbox,
    db.syncActionReviews,
    db.purchaseReviews,
  ];
}
async function source(
  db: MiseDatabase,
  id?: string,
): Promise<PurchaseReviewWorkspace | null> {
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
      : [...observations].reverse().find((v) =>
          v.review.confirmedAt !== null && isPurchaseCommand(v.command) &&
          'purchaseId' in v.command);
  }
  if (
    !selected ||
    !isPurchaseCommand(selected.command) ||
    !('purchaseId' in selected.command)
  )
    return null;
  const raw = await db.purchaseReviews.get(selected.review.id);
  const record = raw ? parseLocalPurchaseReview(raw) : null,
    r = selected.review;
  const packet = await preparePurchaseReviewSource(
    {
      ...selected.entry,
      status: 'pending',
      receipts: selected.entry.receipts.slice(0, r.commandIndex),
    },
    r.commandIndex,
    record?.packet.id ?? newInboxId(),
    record?.packet.replacementId ?? newInboxId(),
  );
  if (record && (
    record.id !== r.id ||
    record.uploadId !== r.uploadId ||
    record.entryId !== r.entryId ||
    record.commandIndex !== r.commandIndex ||
    record.identityHash !== r.identityHash ||
    record.commandHash !== r.commandHash ||
    !same(packet, record.packet) ||
    (record.quoteHash !== null &&
      record.quoteHash !== (await purchaseQuoteHash(record.quote!))) ||
    (record.quote &&
      [
        record.quote.businessId,
        record.quote.outletId,
        record.quote.actorId,
      ].join(',') !== [r.businessId, r.outletId, r.actorId].join(','))
  ))
    throw Error(
      'Keep the complete original purchase review, source and chosen values.',
    );
  return { source: selected, record, original: originalPurchaseFacts(packet), acknowledged: false };
}
export async function readPurchaseReviewWorkspace(
  db: MiseDatabase,
  id?: string,
): Promise<PurchaseReviewWorkspace | null> {
  return (await source(db, id)) ?? readAcknowledgedPurchaseReview(db, id);
}
/** Display availability only. Opening a review still verifies its full source,
 * operator and account independently, including complete original image bytes. */
export async function hasSavedPurchaseReview(db: MiseDatabase, uploadId: string): Promise<boolean> {
  if (await db.purchaseReviews.where('uploadId').equals(uploadId).count()) return true;
  const rows = await db.outbox.where('uploadId').equals(uploadId).sortBy('sequence'),
    first = rows.find(row => row.status !== 'accepted' && !isLocalInboxRetention(row)),
    command = first?.commands[first.receipts.length];
  if (!first || first.status !== 'pending' || !command ||
      !isPurchaseCommand(command) || !('purchaseId' in command)) return false;
  return (await db.syncActionReviews.where('uploadId').equals(uploadId).toArray())
    .some(review => review.entryId === first.id && review.commandId === command.id &&
      review.commandIndex === first.receipts.length && review.confirmedAt === null);
}
async function change(
  db: MiseDatabase,
  id: string,
  revision: number | null,
  options: PurchaseReviewOptions,
  signal: AbortSignal | undefined,
  update: (
    workspace: PurchaseReviewWorkspace,
  ) => Promise<LocalPurchaseReview> | LocalPurchaseReview,
  proof?: object,
): Promise<LocalPurchaseReview> {
  const authorization = await options.account.getAuth(),
    workspace = await source(db, id);
  if (!workspace) throw Error('Keep the complete original review source.');
  return db.transaction('rw', tables(db), async () => {
    const tx = Dexie.currentTransaction,
      identity = await localReviewIdentity(db),
      raw = await db.purchaseReviews.get(id),
      current = raw ? parseLocalPurchaseReview(raw) : null;
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
    const next = parseLocalPurchaseReview(
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
    await db.purchaseReviews.put(next);
    guard();
    const afterIdentity = await localReviewIdentity(db),
      afterEntry = await db.outbox.get(entry.id),
      saved = await db.purchaseReviews.get(id);
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
const next = (record: LocalPurchaseReview, patch: Partial<LocalPurchaseReview>) => ({
  ...record,
  ...patch,
  revision: record.revision + 1,
});
async function selectedRemote(
  db: MiseDatabase,
  record: LocalPurchaseReview,
  options: PurchaseReviewOptions,
) {
  const view = await readPurchaseReviewWorkspace(db, record.id);
  if (!view) throw Error('Keep the original saved purchase action.');
  const r = view.source.review;
  return createCloudPurchaseReviewRemote(
    options.config,
    options.account,
    { businessId: r.businessId, outletId: r.outletId, actorId: r.actorId },
    options.send,
  );
}
async function confirm(
  db: MiseDatabase,
  record: LocalPurchaseReview,
  receipt: ShopCommandReceipt,
  options: PurchaseReviewOptions,
  signal?: AbortSignal,
) {
  assertCommandReceipt(receipt);
  const command = record.packet.command;
  const before = await readPurchaseReviewWorkspace(db, record.id);
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
  const actual = await readPurchaseReviewWorkspace(db, record.id);
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
        receipt: receipt as LocalPurchaseReview['receipt'],
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
export async function prepareSavedPurchaseReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number | null,
  options: PurchaseReviewOptions,
  signal?: AbortSignal,
): Promise<LocalPurchaseReview> {
  const historical = await readPurchaseReviewWorkspace(db, id);
  if (historical?.acknowledged)
    return confirmAcknowledgedPurchaseReview(db,id,expectedRevision,options,signal);
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
        packet = await preparePurchaseReviewSource(
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
  const quote = purchaseReviewQuote(result.review),
    quoteHash = await purchaseQuoteHash(quote);
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
export async function decideSavedPurchaseReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number,
  choice: PurchaseReviewChoice,
  options: PurchaseReviewOptions,
  signal?: AbortSignal,
): Promise<{ record: LocalPurchaseReview; changed: boolean }> {
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
        (r.phase !== 'review' && !same(r.choice, choice)) ||
        (choice.outcome === 'replaced' && !r.quote.proposal.enabled)
      )
        throw Error(
          'Review the selected current values before choosing an outcome.',
        );
      if (choice.outcome === 'replaced' && r.quote.proposal.enabled &&
          r.quote.proposal.invoice.currency !== originalPurchaseFacts(r.packet).currency)
        throw Error('Keep the original invoice currency.');
      return next(r, {
        phase: 'deciding',
        choice,
        attempts: [
          ...r.attempts,
          { ...choice, quoteHash: r.quoteHash, at: Date.now() },
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
    const quote = purchaseReviewQuote(fresh.review),
      quoteHash = await purchaseQuoteHash(quote);
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
      { ...record.packet, token: fresh.review.token, ...choice },
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
