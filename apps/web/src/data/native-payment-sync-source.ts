import type { MiseDatabase } from './db';
import Dexie from 'dexie';
import type { LocalStore } from './local-store';
import type { MiseBackup } from '@mise/core/backup-tables';
import type {
  LocalCloudState,
  LocalOutboxEntry,
} from '@mise/core/local-outbox';
import type { SyncDownloadTarget } from '@mise/core/sync-download';
import {
  nativePaymentQueueGroups,
  nativePaymentCanonicalCoverage,
} from '@mise/core/native-payment-coverage';
import { parseNativePaymentOutbox } from '@mise/core/native-payment-outbox';
import { literalToken } from '@mise/core/literal-token';
import { sharedJsonHash } from '@mise/core/shared-json';
import { ReconciliationError } from '@mise/core/sync-materialize';
import { isLocalInboxRetention } from '@mise/core/local-inbox';
import { readRetainedPaymentOriginals } from './payment-original-retention';
import { readNativePaymentState } from './native-payment-state';
import {
  readCanonicalState,
  assertCanonicalState,
  type CanonicalState,
} from './cloud-canonical-state';
import { nativeRowHash } from './canonical-writes';

export const nativePaymentQueueToken = (
  rows: readonly ReturnType<typeof parseNativePaymentOutbox>[],
) =>
  rows.map((r) => [
    r.id,
    r.originalHash,
    r.state,
    r.seal,
    r.copyReceipt,
    r.nativeReceipt,
    r.outcomeHash,
    r.review,
  ]);

/** Complete local source before planning a canonical replacement. Recognition
 * grants no coverage: every native group still needs its actual downloaded
 * invocation, outcome, original graph and exact financial children. */
export async function readNativePaymentSyncSource(
  db: MiseDatabase,
  working: MiseBackup,
  binding: LocalCloudState,
  queue: readonly LocalOutboxEntry[],
  target: SyncDownloadTarget,
) {
  const rows = (await db.nativePaymentActions.toArray()).map(
      parseNativePaymentOutbox,
    ),
    legacy = await readRetainedPaymentOriginals(db, working);
  if (!rows.length && !legacy.bases.length && !working.tables.payments.length)
    return undefined;
  const groups = nativePaymentQueueGroups(
      rows,
      queue,
      target,
      binding.uploadId,
    ),
    saved = await readNativePaymentState(db),
    known = new Set([
      ...rows.flatMap((r) => (r.seal ? [r.seal.ref.root] : [])),
      ...(saved?.bases.map((b) => b.root) ?? []),
      ...(saved?.projection.originals.bases.map((b) => b.root) ?? []),
    ]);
  if (
    legacy.bases.some((b) => !known.has(b.root)) ||
    working.tables.payments.some(
      (p) =>
        !rows.some(
          (r) =>
            r.id === p.eventId &&
            r.original.invocation.command.paymentId === p.id &&
            r.original.invocation.command.revision + 1 === p.revision,
        ),
    )
  )
    throw new ReconciliationError('retained');
  return {
    rows,
    legacy,
    markerIds: new Set(groups.keys()),
    token: sharedJsonHash(
      literalToken([nativePaymentQueueToken(rows), legacy.bases]),
    ),
  };
}
export type NativePaymentSyncSource = NonNullable<
  Awaited<ReturnType<typeof readNativePaymentSyncSource>>
>;

/** Coverage comes from the installed, strictly validated canonical base. The
 * original marker remains retained, with no invented v1 command receipt. */
async function acceptedNativePaymentMarkers(
  db: LocalStore,
  rows: ReturnType<typeof parseNativePaymentOutbox>[],
  queue: LocalOutboxEntry[],
) {
  if (!rows.length || !(await db.nativePaymentState.count()))
    return { markers: new Set<string>(), canonical: null };
  const accepted = await readCanonicalState(db),
    saved = await readNativePaymentState(db);
  if (!saved) throw new ReconciliationError('retained');
  const scope = accepted.base.snapshot.scope;
  const markers = nativePaymentCanonicalCoverage(
    rows,
    queue,
    { ...scope, targetHash: accepted.binding.targetHash },
    accepted.binding.uploadId,
    saved.projection,
  );
  return { markers, canonical: accepted };
}
export interface SyncWaitingProof {
  readonly kind: 'verified-sync-waiting';
}
const waitingProofs = new WeakMap<
  SyncWaitingProof,
  {
    db: LocalStore;
    count: number;
    token: string;
    canonical: CanonicalState | null;
  }
>();
async function waitingRows(db: LocalStore) {
  return db.transaction('r', db.outbox, db.nativePaymentActions, async () => ({
    queue: (await db.outbox.toArray()).sort((a, b) => a.id.localeCompare(b.id)),
    rows: (await db.nativePaymentActions.toArray()).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  }));
}
/** Decode and hash outside the final writer. Complete Blob/graph verification
 * must not be hidden inside a nested transaction keep-alive. */
export async function prepareSyncWaitingProof(
  db: LocalStore,
): Promise<SyncWaitingProof> {
  const snapshot = await waitingRows(db),
    rows = snapshot.rows.map(parseNativePaymentOutbox),
    token = await nativeRowHash(snapshot);
  for (const row of rows)
    if (
      !row.original.marker ||
      !snapshot.queue.some(
        (q) => q.id === row.original.marker!.entryId && q.status === 'retained',
      )
    )
      throw new ReconciliationError('retained');
  const accepted = await acceptedNativePaymentMarkers(db, rows, snapshot.queue),
    count = snapshot.queue.filter(
      (r) =>
        r.status !== 'accepted' &&
        !isLocalInboxRetention(r) &&
        !accepted.markers.has(r.id),
    ).length,
    proof: SyncWaitingProof = Object.freeze({ kind: 'verified-sync-waiting' });
  waitingProofs.set(proof, { db, count, token, canonical: accepted.canonical });
  return proof;
}
/** The final writer rereads the exact queue, originals and canonical admission.
 * A serialized count/hash cannot issue this proof or confirm a cursor. */
export async function assertSyncWaitingProof(
  db: LocalStore,
  proof: SyncWaitingProof,
) {
  const known = waitingProofs.get(proof);
  if (!known || known.db !== db) throw new ReconciliationError('integrity');
  const snapshot = await waitingRows(db);
  if ((await Dexie.waitFor(nativeRowHash(snapshot))) !== known.token)
    throw new ReconciliationError('review');
  if (known.canonical) await assertCanonicalState(db, known.canonical);
  return known.count;
}
/** Invalid/incomplete evidence always leaves a waiting action in presentation.
 * The status never obtains financial or delivery authority from this number. */
export async function syncWaitingCount(db: LocalStore) {
  try {
    const proof = await prepareSyncWaitingProof(db);
    // A concurrent approval, outcome or canonical writer invalidates this view.
    return await db.transaction('r', db.tables, () =>
      assertSyncWaitingProof(db, proof),
    );
  } catch {
    return Math.max(
      1,
      (await db.outbox.toArray()).filter(
        (r) => r.status !== 'accepted' && !isLocalInboxRetention(r),
      ).length,
    );
  }
}
