import Dexie from 'dexie';
import type { MiseDatabase } from './db';
import { readDatabaseBackup } from './backup';
import { backupToken } from '@mise/core/backup';
import type { MiseBackup } from '@mise/core/backup-tables';
import { parseLocalOutboxEntry } from './local-outbox';
import { newInboxId } from '@mise/core/inbox';
import { literalToken } from '@mise/core/literal-token';
import {
  paymentInvocationHash,
  readNativePaymentInvocation,
} from '@mise/core/payment-invocations';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import {
  parseNativePaymentOutbox,
  nativePaymentOutboxMaxBytes,
  type NativePaymentOutboxEntry,
} from '@mise/core/native-payment-outbox';
import {
  assertNativePaymentAccess,
  assertNativePaymentScope,
  type NativePaymentAccess,
} from './native-payment-access';
import {
  composeNativePaymentChanges,
  nativePaymentChangesEqual,
} from './native-payment-outbox';
import {
  retainPaymentOriginal,
  readRetainedPaymentAction,
} from './payment-original-retention';

const keep = () =>
  Error(
    'Keep the complete original payment actions and their actual queue order.',
  );
/** Prove every queued row still has a complete original witness in the native
 * source. Later current rows may differ; genuine audit before/after snapshots
 * retain the actual earlier rows. This never turns a row difference into intent. */
function assertSource(source: MiseBackup, rows: NativePaymentOutboxEntry[]) {
  const events = new Map(source.tables.events.map((e) => [e.id, e]));
  const missing = new Set<string>(),
    wanted = new Map<string, Set<string>>();
  const witness = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const row = v as Record<string, unknown>;
    if (typeof row.id !== 'string') return;
    const keys = wanted.get(row.id);
    if (!keys) return;
    const hash = paymentInvocationHash(row);
    for (const key of keys) if (key.endsWith(':' + hash)) missing.delete(key);
  };
  for (const row of rows) {
    const c = row.original.invocation.command,
      event = events.get(c.id);
    if (
      !event ||
      literalToken(readNativePaymentInvocation(event, source.tables.events)) !==
        literalToken(row.original.invocation)
    )
      throw keep();
    for (const change of row.original.changes) {
      if (change.table === 'events') {
        if (literalToken(events.get(change.key)) !== literalToken(change.after))
          throw keep();
        continue;
      }
      for (const value of [change.before, change.after])
        if (value !== null) {
          const key =
            change.table +
            ':' +
            change.key +
            ':' +
            paymentInvocationHash(value);
          missing.add(key);
          const keys = wanted.get(change.key) ?? new Set<string>();
          keys.add(key);
          wanted.set(change.key, keys);
        }
      const current = source.tables[change.table].find(
        (v) => v.id === change.key,
      );
      witness(current);
    }
  }
  // Walk only actual audit snapshots. Repeated source/evidence is shared by the
  // existing archive; no snapshot per action or arbitrary JSON field is trusted.
  const stack: unknown[] = source.tables.events.flatMap((e) => [
    e.before,
    e.after,
  ]);
  while (stack.length && missing.size) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    witness(value);
    for (const child of Object.values(value)) stack.push(child);
  }
  if (missing.size) throw keep();
}
/** Seal the pending connected batch BEFORE canonical replacement. A cumulative
 * basis shares complete literal source/evidence across all actions. Historical
 * unbound actions are preserved, and are never manufactured into new sends. */
export async function sealNativePaymentBatch(
  db: MiseDatabase,
  access: NativePaymentAccess,
) {
  return db.transaction('rw', db.tables, async () => {
    const tx = Dexie.currentTransaction!;
    try {
      const identity = await assertNativePaymentScope(access, db),
        binding = parseLocalCloudState(await db.cloudState.get('binding')),
        all = (await db.nativePaymentActions.toArray()).map(
          parseNativePaymentOutbox,
        ),
        pending = all.filter((r) => r.original.marker && !r.seal);
      if (!pending.length) return null;
      for (const row of pending) {
        const c = row.original.invocation.command,
          m = row.original.marker!;
        if (
          c.businessId !== identity.businessId ||
          c.outletId !== identity.outletId ||
          c.actorId !== identity.actorId ||
          m.accountHash !== identity.accountHash ||
          m.targetHash !== identity.targetHash ||
          m.uploadId !== binding.uploadId
        )
          throw keep();
      }
      const markerIds = new Set(pending.map((r) => r.original.marker!.entryId));
      for (const entryId of markerIds) {
        const group = all
            .filter((r) => r.original.marker?.entryId === entryId)
            .sort((a, b) => a.original.group.index - b.original.group.index),
          rawMarker = await db.outbox.get(entryId);
        if (!rawMarker) throw keep();
        const marker = parseLocalOutboxEntry(rawMarker, binding),
          first = group[0];
        if (
          !first ||
          marker.status !== 'retained' ||
          marker.commands.length ||
          marker.receipts.length ||
          group.some(
            (r, i) =>
              r.seal ||
              r.original.group.id !== first.original.group.id ||
              r.original.group.index !== i ||
              literalToken(r.original.marker) !==
                literalToken(first.original.marker),
          ) ||
          marker.sequence !== first.original.marker!.sequence ||
          !nativePaymentChangesEqual(
            composeNativePaymentChanges(group),
            marker.changes,
          )
        )
          throw keep();
      }
      const source = await readDatabaseBackup(db),
        token = backupToken(source);
      assertSource(source, pending);
      const basis = await retainPaymentOriginal(db, source, access),
        copyId = newInboxId();
      const sealed = pending.map((row) =>
        parseNativePaymentOutbox({
          ...row,
          seal: {
            copyId,
            ref: {
              root: basis.root,
              paymentId: row.original.invocation.command.paymentId,
              revision: row.original.invocation.command.revision + 1,
              eventId: row.id,
            },
          },
        }),
      );
      const replacements = new Map(sealed.map((r) => [r.id, r])),
        expected = all.map((r) => replacements.get(r.id) ?? r);
      if (
        new TextEncoder().encode(literalToken(expected)).length >
        nativePaymentOutboxMaxBytes
      )
        throw keep();
      assertNativePaymentAccess(access, db);
      await db.nativePaymentActions.bulkPut(sealed);
      if (
        backupToken(await readDatabaseBackup(db)) !== token ||
        literalToken(
          (await db.nativePaymentActions.toArray()).map(
            parseNativePaymentOutbox,
          ),
        ) !== literalToken(expected)
      )
        throw keep();
      await assertNativePaymentScope(access, db);
      return { copyId, root: basis.root, actionIds: sealed.map((r) => r.id) };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* A caught seal failure still aborts all writes. */
      }
      throw error;
    }
  });
}
/** Read the independent original, never substitute a newer current Payment. */
export async function readSealedNativePaymentAction(
  db: MiseDatabase,
  id: string,
) {
  return db.transaction('r', db.tables, async () => {
    const row = parseNativePaymentOutbox(await db.nativePaymentActions.get(id));
    if (!row.seal) throw keep();
    const original = await readRetainedPaymentAction(db, row.seal.ref);
    const event = row.original.changes.find(
      (c) => c.table === 'events' && c.key === id,
    )?.after;
    if (
      literalToken(original.invocation) !==
        literalToken(row.original.invocation) ||
      literalToken(original.event) !== literalToken(event)
    )
      throw keep();
    return { row, original };
  });
}
