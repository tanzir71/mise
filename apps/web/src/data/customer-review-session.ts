import Dexie from 'dexie';
import { newInboxId } from '@mise/core/inbox';
import {
  isCustomerCommand,
  type ShopCommandReceipt,
} from '@mise/core/shop-commands';
import {
  parseLocalCustomerReview,
  customerReviewQuote,
  customerReviewQuoteHash as customerQuoteHash,
  type LocalCustomerReview,
  type CustomerReviewChoice,
} from '@mise/core/customer-review-journal';
import { parseCustomerReviewSource, type CustomerReviewSource } from '@mise/core/customer-review-source';
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
import { prepareCustomerReviewSource } from './customer-review-source';
import { createCloudCustomerReviewRemote } from './cloud-customer-review-remote';
import { assertCommandReceipt, type CommandAccount } from './command-request';
import { requestSync } from './sync-session';
import {readAcknowledgedCustomerReview,confirmAcknowledgedCustomerReview} from './customer-review-history';

type Observation = Awaited<ReturnType<typeof readLocalActionReviews>>[number];
export interface CustomerReviewWorkspace {
  source: Observation;
  record: LocalCustomerReview | null;
  original: CustomerReviewSource;
  acknowledged: boolean;
}
export interface CustomerReviewOptions {
  config: CloudConnection;
  account: CommandAccount;
  send?: typeof fetch;
}
const same = (a: unknown, b: unknown) =>
  syncDownloadToken(a) === syncDownloadToken(b);
export {customerQuoteHash};
function tables(db: MiseDatabase) {
  return [
    db.cloudState,
    db.operatorState,
    db.outbox,
    db.syncActionReviews,
    db.customerReviews,
  ];
}
async function source(
  db: MiseDatabase,
  id?: string,
): Promise<CustomerReviewWorkspace | null> {
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
          v.review.confirmedAt !== null && isCustomerCommand(v.command));
  }
  if (
    !selected ||
    !isCustomerCommand(selected.command)
  )
    return null;
  const raw = await db.customerReviews.get(selected.review.id);
  const record = raw ? parseLocalCustomerReview(raw) : null,
    r = selected.review;
  const packet = await prepareCustomerReviewSource(
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
      record.quoteHash !== (await customerQuoteHash(record.quote!))) ||
    (record.quote &&
      [
        record.quote.businessId,
        record.quote.outletId,
        record.quote.actorId,
      ].join(',') !== [r.businessId, r.outletId, r.actorId].join(','))
  ))
    throw Error(
      'Keep the complete original customer review, source and chosen values.',
    );
  return { source: selected, record, original: parseCustomerReviewSource(packet), acknowledged: false };
}
export async function readCustomerReviewWorkspace(
  db: MiseDatabase,
  id?: string,
): Promise<CustomerReviewWorkspace | null> {
  return (await source(db, id)) ?? readAcknowledgedCustomerReview(db, id);
}
/** Display availability only. Opening a review still verifies its full source,
 * operator and account independently, including complete original image bytes. */
export async function hasSavedCustomerReview(db: MiseDatabase, uploadId: string): Promise<boolean> {
  if (await db.customerReviews.where('uploadId').equals(uploadId).count()) return true;
  const rows = await db.outbox.where('uploadId').equals(uploadId).sortBy('sequence'),
    first = rows.find(row => row.status !== 'accepted' && !isLocalInboxRetention(row)),
    command = first?.commands[first.receipts.length];
  if (!first || first.status !== 'pending' || !command ||
      !isCustomerCommand(command)) return false;
  return (await db.syncActionReviews.where('uploadId').equals(uploadId).toArray())
    .some(review => review.entryId === first.id && review.commandId === command.id &&
      review.commandIndex === first.receipts.length && review.confirmedAt === null);
}
async function change(
  db: MiseDatabase,
  id: string,
  revision: number | null,
  options: CustomerReviewOptions,
  signal: AbortSignal | undefined,
  update: (
    workspace: CustomerReviewWorkspace,
  ) => Promise<LocalCustomerReview> | LocalCustomerReview,
  proof?: object,
): Promise<LocalCustomerReview> {
  const authorization = await options.account.getAuth(),
    workspace = await source(db, id);
  if (!workspace) throw Error('Keep the complete original review source.');
  return db.transaction('rw', tables(db), async () => {
    const tx = Dexie.currentTransaction,
      identity = await localReviewIdentity(db),
      raw = await db.customerReviews.get(id),
      current = raw ? parseLocalCustomerReview(raw) : null;
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
    const next = parseLocalCustomerReview(
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
    await db.customerReviews.put(next);
    guard();
    const afterIdentity = await localReviewIdentity(db),
      afterEntry = await db.outbox.get(entry.id),
      saved = await db.customerReviews.get(id);
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
const next = (record: LocalCustomerReview, patch: Partial<LocalCustomerReview>) => ({
  ...record,
  ...patch,
  revision: record.revision + 1,
});
async function selectedRemote(
  db: MiseDatabase,
  record: LocalCustomerReview,
  options: CustomerReviewOptions,
) {
  const view = await readCustomerReviewWorkspace(db, record.id);
  if (!view) throw Error('Keep the original saved customer action.');
  const r = view.source.review;
  return createCloudCustomerReviewRemote(
    options.config,
    options.account,
    { businessId: r.businessId, outletId: r.outletId, actorId: r.actorId },
    options.send,
  );
}
async function confirm(
  db: MiseDatabase,
  record: LocalCustomerReview,
  receipt: ShopCommandReceipt,
  options: CustomerReviewOptions,
  signal?: AbortSignal,
) {
  assertCommandReceipt(receipt);
  const command = record.packet.command;
  const before = await readCustomerReviewWorkspace(db, record.id);
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
  const actual = await readCustomerReviewWorkspace(db, record.id);
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
        receipt: receipt as LocalCustomerReview['receipt'],
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
export async function prepareSavedCustomerReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number | null,
  options: CustomerReviewOptions,
  signal?: AbortSignal,
): Promise<LocalCustomerReview> {
  const historical = await readCustomerReviewWorkspace(db, id);
  if (historical?.acknowledged)
    return confirmAcknowledgedCustomerReview(db,id,expectedRevision,options,signal);
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
        packet = await prepareCustomerReviewSource(
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
  const quote = customerReviewQuote(result.review),
    quoteHash = await customerQuoteHash(quote);
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
export async function decideSavedCustomerReview(
  db: MiseDatabase,
  id: string,
  expectedRevision: number,
  choice: CustomerReviewChoice,
  options: CustomerReviewOptions,
  signal?: AbortSignal,
): Promise<{ record: LocalCustomerReview; changed: boolean }> {
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
    const quote = customerReviewQuote(fresh.review),
      quoteHash = await customerQuoteHash(quote);
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
