import type { AuditEvent } from './models';
import { validateBackupRow } from './backup-schema';
import type { LocalRowChange } from './local-outbox';
import {
  parseNativePaymentInvocation,
  readNativePaymentInvocation,
  paymentInvocationHash,
  type NativePaymentInvocation,
} from './payment-invocations';
import {
  parseNativePaymentBackendReceipt,
  type NativePaymentBackendReceipt,
} from './payment-backend';
import {
  parsePaymentOriginalActionRef,
  type PaymentOriginalActionRef,
} from './payment-originals';
import {
  parseOriginalCopyManifest,
  parseOriginalCopyReceipt,
  type OriginalCopyReceipt,
} from './original-copy';
import { literalToken } from './literal-token';

export const localNativePaymentTableNames = ['nativePaymentActions'] as const;
export const nativePaymentOutboxMaxEntries = 512;
export const nativePaymentOutboxMaxEntryBytes = 50 * 1024 * 1024;
export const nativePaymentOutboxMaxBytes = 200 * 1024 * 1024;
export const nativePaymentWriteTables = [
  'payments',
  'events',
  'orders',
  'sales',
  'creditEntries',
] as const;
export interface NativePaymentMarker {
  entryId: string;
  uploadId: string;
  sequence: number;
  targetHash: string;
  accountHash: string;
}
export interface NativePaymentOriginal {
  invocation: NativePaymentInvocation;
  group: { id: string; index: number };
  marker: NativePaymentMarker | null;
  /** Exact native before/after rows, never a raw-write request or permission. */
  changes: LocalRowChange[];
}
export interface NativePaymentOutboxEntry {
  id: string;
  version: 1;
  original: NativePaymentOriginal;
  originalHash: string;
  state: 'local' | 'pending' | 'review' | 'applied';
  seal: { ref: PaymentOriginalActionRef; copyId: string } | null;
  copyReceipt: OriginalCopyReceipt | null;
  nativeReceipt: NativePaymentBackendReceipt | null;
  outcomeHash: string | null;
  review: {
    firstAt: number;
    lastAt: number;
    observations: number;
    status: 409;
  } | null;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (
  v: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
function ensure(v: unknown): asserts v {
  if (!v)
    throw Error(
      'Keep the exact native payment action, original rows and delivery receipts.',
    );
}
export function nativePaymentOriginalHash(v: NativePaymentOriginal) {
  return paymentInvocationHash(['mise-native-payment-original-v1', v]);
}
export function parseNativePaymentOriginal(
  value: unknown,
): NativePaymentOriginal {
  ensure(object(value) && exact(value, 'invocation,group,marker,changes'));
  const invocation = parseNativePaymentInvocation(value.invocation),
    c = invocation.command;
  ensure(
    object(value.group) &&
      exact(value.group, 'id,index') &&
      id(value.group.id) &&
      integer(value.group.index, 0, 999),
  );
  const marker = value.marker;
  if (marker !== null)
    ensure(
      object(marker) &&
        exact(marker, 'entryId,uploadId,sequence,targetHash,accountHash') &&
        id(marker.entryId) &&
        id(marker.uploadId) &&
        integer(marker.sequence, 1) &&
        hash(marker.targetHash) &&
        hash(marker.accountHash),
    );
  ensure(
    Array.isArray(value.changes) &&
      value.changes.length > 0 &&
      value.changes.length <= 8192,
  );
  const changes = value.changes as LocalRowChange[],
    keys = new Set<string>();
  for (const change of changes) {
    ensure(
      object(change) &&
        exact(change, 'table,key,before,after') &&
        (nativePaymentWriteTables as readonly string[]).includes(
          change.table,
        ) &&
        id(change.key),
    );
    ensure(!keys.has(change.table + ':' + change.key));
    keys.add(change.table + ':' + change.key);
    ensure(change.before !== null || change.after !== null);
    for (const row of [change.before, change.after])
      if (row !== null) {
        ensure(object(row) && row.id === change.key);
        validateBackupRow(change.table, row, 'native original');
        ensure(row.outletId === c.outletId);
      }
    if (change.table === 'events')
      ensure(change.before === null && change.after !== null);
    if (change.table === 'payments') ensure(change.key === c.paymentId);
  }
  const payment = changes.find(
      (r) => r.table === 'payments' && r.key === c.paymentId,
    ),
    events = changes
      .filter((r) => r.table === 'events')
      .map((r) => r.after as AuditEvent),
    event = events.find((e) => e.id === c.id);
  ensure(
    payment &&
      event &&
      paymentInvocationHash(payment.before) === c.beforeHash &&
      paymentInvocationHash(payment.after) === invocation.paymentHash,
  );
  ensure(
    literalToken(readNativePaymentInvocation(event, events)) ===
      literalToken(invocation),
  );
  ensure(
    new TextEncoder().encode(literalToken(value)).length <=
      nativePaymentOutboxMaxEntryBytes,
  );
  return structuredClone({
    invocation,
    group: value.group,
    marker,
    changes,
  }) as NativePaymentOriginal;
}
export function nativePaymentOutcomeHash(
  entry: Pick<
    NativePaymentOutboxEntry,
    'originalHash' | 'seal' | 'copyReceipt' | 'nativeReceipt'
  >,
) {
  return paymentInvocationHash([
    'mise-native-payment-outcome-v1',
    entry.originalHash,
    entry.seal,
    entry.copyReceipt,
    entry.nativeReceipt,
  ]);
}
export function parseNativePaymentOutbox(
  value: unknown,
): NativePaymentOutboxEntry {
  ensure(
    object(value) &&
      exact(
        value,
        'id,version,original,originalHash,state,seal,copyReceipt,nativeReceipt,outcomeHash,review',
      ) &&
      value.version === 1,
  );
  const original = parseNativePaymentOriginal(value.original),
    c = original.invocation.command;
  ensure(
    value.id === c.id &&
      value.originalHash === nativePaymentOriginalHash(original),
  );
  let seal: NativePaymentOutboxEntry['seal'] = null;
  if (value.seal !== null) {
    ensure(
      object(value.seal) &&
        exact(value.seal, 'ref,copyId') &&
        id(value.seal.copyId),
    );
    const ref = parsePaymentOriginalActionRef(value.seal.ref);
    ensure(
      ref.paymentId === c.paymentId &&
        ref.eventId === c.id &&
        ref.revision === c.revision + 1,
    );
    seal = { ref, copyId: value.seal.copyId };
  }
  let copyReceipt: OriginalCopyReceipt | null = null,
    nativeReceipt: NativePaymentBackendReceipt | null = null;
  if (value.copyReceipt !== null) {
    ensure(seal && object(value.copyReceipt));
    const { acceptedAt, manifestHash, verification, ...fields } =
      value.copyReceipt;
    void acceptedAt;
    void manifestHash;
    void verification;
    copyReceipt = parseOriginalCopyReceipt(
      value.copyReceipt,
      parseOriginalCopyManifest(fields),
    );
    ensure(
      copyReceipt.id === seal.copyId &&
        copyReceipt.businessId === c.businessId &&
        copyReceipt.outletId === c.outletId &&
        copyReceipt.actorId === c.actorId,
    );
  }
  if (value.nativeReceipt !== null) {
    ensure(original.marker && seal && copyReceipt);
    nativeReceipt = parseNativePaymentBackendReceipt(value.nativeReceipt, c);
    ensure(nativeReceipt.paymentHash === original.invocation.paymentHash);
  }
  if (value.review !== null)
    ensure(
      object(value.review) &&
        exact(value.review, 'firstAt,lastAt,observations,status') &&
        integer(value.review.firstAt, 0, 253402300799999) &&
        integer(value.review.lastAt, value.review.firstAt, 253402300799999) &&
        integer(value.review.observations, 1) &&
        value.review.status === 409 &&
        original.marker,
    );
  const state =
    original.marker === null
      ? 'local'
      : nativeReceipt
        ? 'applied'
        : value.review
          ? 'review'
          : 'pending';
  ensure(
    value.state === state &&
      (nativeReceipt
        ? value.outcomeHash ===
          nativePaymentOutcomeHash({
            originalHash: value.originalHash as string,
            seal,
            copyReceipt,
            nativeReceipt,
          })
        : value.outcomeHash === null),
  );
  return structuredClone({
    id: c.id,
    version: 1,
    original,
    originalHash: value.originalHash,
    state,
    seal,
    copyReceipt,
    nativeReceipt,
    outcomeHash: value.outcomeHash,
    review: value.review,
  }) as NativePaymentOutboxEntry;
}
export function createNativePaymentOutbox(
  value: NativePaymentOriginal,
): NativePaymentOutboxEntry {
  const original = parseNativePaymentOriginal(value);
  return parseNativePaymentOutbox({
    id: original.invocation.command.id,
    version: 1,
    original,
    originalHash: nativePaymentOriginalHash(original),
    state: original.marker ? 'pending' : 'local',
    seal: null,
    copyReceipt: null,
    nativeReceipt: null,
    outcomeHash: null,
    review: null,
  });
}
