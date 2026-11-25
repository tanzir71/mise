import Dexie from 'dexie';
import type { MiseDatabase } from './db';
import type { OriginalCopyIdentity } from './original-copies';
import type { NativePaymentMutation } from '@mise/core/payment-native-commands';
import {
  createNativePaymentOutbox,
  parseNativePaymentOutbox,
  nativePaymentOutboxMaxEntries,
  nativePaymentOutboxMaxBytes,
  type NativePaymentOutboxEntry,
  type NativePaymentMarker,
} from '@mise/core/native-payment-outbox';
import { parseNativePaymentInvocation } from '@mise/core/payment-invocations';
import { literalToken } from '@mise/core/literal-token';
import type { LocalRowChange } from '@mise/core/local-outbox';
import { withNativeOutboxCapture } from './outbox-capture';

/** Composition proves that a retained legacy marker contains ONLY its explicit
 * native actions. No unrelated retained/raw writes may be skipped by delivery. */
export function composeNativePaymentChanges(
  rows: readonly NativePaymentOutboxEntry[],
) {
  const changes = new Map<string, LocalRowChange>();
  for (const row of rows)
    for (const change of row.original.changes) {
      const key = change.table + ':' + change.key,
        old = changes.get(key);
      if (old && literalToken(old.after) !== literalToken(change.before))
        throw Error(
          'Keep native action rows in their actual transaction order.',
        );
      changes.set(key, { ...change, before: old ? old.before : change.before });
    }
  return [...changes.values()];
}
const sorted = (rows: readonly LocalRowChange[]) =>
  rows
    .slice()
    .sort((a, b) =>
      (a.table + ':' + a.key).localeCompare(b.table + ':' + b.key),
    );
export function nativePaymentChangesEqual(
  a: readonly LocalRowChange[],
  b: readonly LocalRowChange[],
) {
  return literalToken(sorted(a)) === literalToken(sorted(b));
}
/** The same native transaction owns money, all original audits, this immutable
 * journal and its shared legacy queue position. A caught failure still aborts. */
export async function recordNativePaymentMutation<T>(
  db: MiseDatabase,
  mutation: NativePaymentMutation,
  write: () => Promise<T>,
  identity: OriginalCopyIdentity | null = null,
  current: () => void = () => {},
) {
  const tx = Dexie.currentTransaction;
  if (!tx || tx.db !== db || tx.mode !== 'readwrite')
    throw Error('Record the native payment and its outbox in one transaction.');
  try {
    current();
    const invocation = parseNativePaymentInvocation(mutation.invocation.after),
      c = invocation.command,
      saved = await db.nativePaymentActions.get(c.id);
    if (saved)
      throw Error('Recover the original native action before reusing its ID.');
    const captured = await withNativeOutboxCapture(db, c.id, write);
    if (identity && !captured.marker)
      throw Error('Keep the native payment in its actual connected queue.');
    let marker: NativePaymentMarker | null = null;
    if (captured.marker) {
      const { state, entry } = captured.marker;
      if (
        !identity ||
        state.phase !== 'ready' ||
        state.businessId !== c.businessId ||
        state.outletId !== c.outletId ||
        state.ownerId !== c.actorId ||
        identity.businessId !== c.businessId ||
        identity.outletId !== c.outletId ||
        identity.actorId !== c.actorId ||
        identity.targetHash !== state.targetHash ||
        entry.status !== 'retained' ||
        entry.commands.length ||
        entry.receipts.length
      )
        throw Error(
          'Use the actual native payment account, scope and queue position.',
        );
      marker = {
        entryId: entry.id,
        uploadId: state.uploadId,
        sequence: entry.sequence,
        targetHash: identity.targetHash,
        accountHash: identity.accountHash,
      };
    }
    const row = createNativePaymentOutbox({
      invocation,
      group: captured.group,
      marker,
      // Match the complete portable JSON used by native backups: optional
      // undefined properties are absent; literal text and every value remain.
      changes: JSON.parse(literalToken(captured.changes)),
    });
    const prior = (await db.nativePaymentActions.toArray()).map(
        parseNativePaymentOutbox,
      ),
      group = prior
        .filter((v) => v.original.group.id === row.original.group.id)
        .sort((a, b) => a.original.group.index - b.original.group.index);
    if (
      group.length !== row.original.group.index ||
      group.some(
        (v, i) =>
          v.seal !== null ||
          v.original.group.index !== i ||
          literalToken(v.original.marker) !== literalToken(marker),
      )
    )
      throw Error(
        'Keep every native action in its original transaction group.',
      );
    if (
      captured.marker &&
      !nativePaymentChangesEqual(
        composeNativePaymentChanges([...group, row]),
        captured.marker.entry.changes,
      )
    )
      throw Error(
        'Keep unrelated retained work separate from native payment delivery.',
      );
    const encoder = new TextEncoder(),
      bytes = prior.reduce(
        (n, v) => n + encoder.encode(literalToken(v)).length,
        encoder.encode(literalToken(row)).length,
      );
    if (
      prior.length >= nativePaymentOutboxMaxEntries ||
      bytes > nativePaymentOutboxMaxBytes
    )
      throw Error(
        'Keep the complete original native journal; its bounded capacity is full.',
      );
    current();
    await db.nativePaymentActions.add(row);
    current();
    return captured.result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Preserve the first failure after native abort. */
    }
    throw error;
  }
}
