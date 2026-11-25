import type { MiseDatabase } from './db';
import type { LocalOutboxEntry } from '@mise/core/local-outbox';
import {
  parseNativePaymentOutbox,
  type NativePaymentOutboxEntry,
} from '@mise/core/native-payment-outbox';
import type { NativePaymentBackendReceipt } from '@mise/core/payment-backend';
import type { OriginalCopyReceipt } from '@mise/core/original-copy';
import { literalToken } from '@mise/core/literal-token';
import {
  assertLiveCommandReceipt,
  CommandRequestError,
} from './command-request';
import {
  assertNativePaymentAccess,
  assertNativePaymentScope,
  type NativePaymentAccess,
} from './native-payment-access';
import {
  composeNativePaymentChanges,
  nativePaymentChangesEqual,
} from './native-payment-outbox';
/** Ephemeral delivery proof only. The v1 marker remains retained and grants no
 * canonical authority. Neither a backup nor serialized receipts can issue this. */
export interface NativePaymentBarriers {
  readonly kind: 'verified-native-payment-barriers';
}
export interface VerifiedNativePaymentGroup {
  marker: LocalOutboxEntry;
  rows: NativePaymentOutboxEntry[];
  receipts: NativePaymentBackendReceipt[];
  copies: OriginalCopyReceipt[];
}
const issued = new WeakMap<
  NativePaymentBarriers,
  {
    db: MiseDatabase;
    access: NativePaymentAccess;
    groups: Map<string, { marker: string; rows: string; receipts: object[] }>;
  }
>();
const fail = () => new CommandRequestError('review');
export function createNativePaymentBarriers(
  db: MiseDatabase,
  access: NativePaymentAccess,
  groups: readonly VerifiedNativePaymentGroup[],
): NativePaymentBarriers {
  const identity = assertNativePaymentAccess(access, db),
    checked = new Map<
      string,
      { marker: string; rows: string; receipts: object[] }
    >();
  for (const group of groups) {
    const rows = group.rows
        .map(parseNativePaymentOutbox)
        .sort((a, b) => a.original.group.index - b.original.group.index),
      marker = group.marker;
    if (
      !rows.length ||
      marker.status !== 'retained' ||
      marker.commands.length ||
      marker.receipts.length ||
      checked.has(marker.id) ||
      rows.length !== group.receipts.length ||
      rows.length !== group.copies.length ||
      !nativePaymentChangesEqual(
        composeNativePaymentChanges(rows),
        marker.changes,
      )
    )
      throw fail();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        m = row.original.marker,
        c = row.original.invocation.command,
        receipt = group.receipts[i],
        copy = group.copies[i];
      assertLiveCommandReceipt(receipt);
      assertLiveCommandReceipt(copy);
      if (
        row.state !== 'applied' ||
        !m ||
        !row.seal ||
        row.original.group.index !== i ||
        row.original.group.id !== rows[0].original.group.id ||
        m.entryId !== marker.id ||
        m.uploadId !== marker.uploadId ||
        m.sequence !== marker.sequence ||
        m.targetHash !== identity.targetHash ||
        m.accountHash !== identity.accountHash ||
        c.businessId !== identity.businessId ||
        c.outletId !== identity.outletId ||
        c.actorId !== identity.actorId ||
        literalToken(row.nativeReceipt) !== literalToken(receipt) ||
        literalToken(row.copyReceipt) !== literalToken(copy)
      )
        throw fail();
    }
    checked.set(marker.id, {
      marker: literalToken(marker),
      rows: literalToken(rows),
      receipts: [...group.receipts, ...group.copies],
    });
  }
  const permit: NativePaymentBarriers = Object.freeze({
    kind: 'verified-native-payment-barriers',
  });
  issued.set(permit, { db, access, groups: checked });
  return permit;
}
/** Recheck the actual native journal and scope under one read lease. A live
 * proof of every original copy/outcome is required each time legacy work passes. */
export async function nativePaymentBarrierAllows(
  db: MiseDatabase,
  permit: NativePaymentBarriers,
  marker: LocalOutboxEntry,
  targetHash: string,
): Promise<boolean> {
  const proof = issued.get(permit);
  if (!proof || proof.db !== db) throw fail();
  const group = proof.groups.get(marker.id);
  if (!group) return false;
  return db.transaction('r', db.tables, async () => {
    const identity = await assertNativePaymentScope(proof.access, db);
    if (
      identity.targetHash !== targetHash ||
      literalToken(marker) !== group.marker ||
      literalToken(await db.outbox.get(marker.id)) !== group.marker
    )
      throw fail();
    const rows = (
      await db.nativePaymentActions
        .where('original.marker.entryId')
        .equals(marker.id)
        .toArray()
    )
      .map(parseNativePaymentOutbox)
      .sort((a, b) => a.original.group.index - b.original.group.index);
    if (literalToken(rows) !== group.rows) throw fail();
    for (const receipt of group.receipts) assertLiveCommandReceipt(receipt);
    await assertNativePaymentScope(proof.access, db);
    return true;
  });
}
