import {
  parseOriginalCopyManifest,
  parseOriginalCopyReceipt,
  type OriginalCopyReceipt,
} from './original-copy';
import {
  parseNativePaymentInvocation,
  paymentInvocationHash,
  nativePaymentSourceRef,
  type NativePaymentInvocation,
} from './payment-invocations';
import {
  parseNativePaymentBackendReceipt,
  type NativePaymentBackendReceipt,
} from './payment-backend';
import {
  parsePaymentOriginalActionRef,
  readPaymentOriginalAction,
  type PaymentOriginalActionRef,
} from './payment-originals';
import { parsePortableBackup, type PortableBackup } from './payment-archive';
import { literalToken } from './literal-token';

export interface PaymentOriginalRetention {
  format: 'mise-payment-original-retention';
  version: 1;
  copy: OriginalCopyReceipt;
  retainedAt: number;
}
/** Immutable locator and content retention, never financial acceptance or a role. */
export interface NativePaymentOriginalLink {
  format: 'mise-native-payment-original-link';
  version: 1;
  id: string;
  businessId: string;
  outletId: string;
  actorId: string;
  requestHash: string;
  paymentHash: string;
  receiptHash: string;
  ref: PaymentOriginalActionRef;
  retention: PaymentOriginalRetention;
  linkedAt: number;
}
export const paymentOriginalLinkMaxBytes = 8192;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 253402300799999;
function ensure(v: unknown): asserts v {
  if (!v)
    throw Error(
      'Keep the exact payment action, retained original and complete source graph.',
    );
}
export function parsePaymentOriginalRetention(
  value: unknown,
): PaymentOriginalRetention {
  ensure(
    object(value) &&
      exact(value, 'format,version,copy,retainedAt') &&
      value.format === 'mise-payment-original-retention' &&
      value.version === 1 &&
      time(value.retainedAt) &&
      object(value.copy),
  );
  const { acceptedAt, manifestHash, verification, ...manifest } = value.copy;
  const copy = parseOriginalCopyReceipt(
    { acceptedAt, manifestHash, verification, ...manifest },
    parseOriginalCopyManifest(manifest),
  );
  return {
    format: 'mise-payment-original-retention',
    version: 1,
    copy,
    retainedAt: value.retainedAt,
  };
}
export function parseNativePaymentOriginalLink(
  value: unknown,
): NativePaymentOriginalLink {
  ensure(
    object(value) &&
      new TextEncoder().encode(literalToken(value)).length <=
        paymentOriginalLinkMaxBytes &&
      exact(
        value,
        'format,version,id,businessId,outletId,actorId,requestHash,paymentHash,receiptHash,ref,retention,linkedAt',
      ) &&
      value.format === 'mise-native-payment-original-link' &&
      value.version === 1,
  );
  ensure(
    [value.id, value.businessId, value.outletId, value.actorId].every(id) &&
      [value.requestHash, value.paymentHash, value.receiptHash].every(hash) &&
      time(value.linkedAt),
  );
  const ref = parsePaymentOriginalActionRef(value.ref),
    retention = parsePaymentOriginalRetention(value.retention),
    copy = retention.copy;
  ensure(
    ref.eventId === value.id &&
      copy.businessId === value.businessId &&
      copy.outletId === value.outletId &&
      copy.actorId === value.actorId,
  );
  return structuredClone({
    ...value,
    ref,
    retention,
  }) as unknown as NativePaymentOriginalLink;
}
export function nativePaymentOriginalStageRequest(
  invocation: NativePaymentInvocation,
  copy: OriginalCopyReceipt,
  ref: PaymentOriginalActionRef,
) {
  const i = parseNativePaymentInvocation(invocation),
    c = i.command,
    f = parsePaymentOriginalActionRef(ref);
  const { acceptedAt, manifestHash, verification, ...manifest } = copy;
  parseOriginalCopyReceipt(
    { acceptedAt, manifestHash, verification, ...manifest },
    parseOriginalCopyManifest(manifest),
  );
  ensure(
    f.eventId === c.id &&
      f.paymentId === c.paymentId &&
      f.revision === c.revision + 1 &&
      copy.businessId === c.businessId &&
      copy.outletId === c.outletId &&
      copy.actorId === c.actorId,
  );
  return {
    copyId: copy.id,
    ref: f,
    requestHash: paymentInvocationHash(i),
    paymentHash: i.paymentHash,
  };
}
export function nativePaymentOriginalRequest(
  invocation: NativePaymentInvocation,
  receipt: NativePaymentBackendReceipt,
  copy: OriginalCopyReceipt,
  ref: PaymentOriginalActionRef,
) {
  const i = parseNativePaymentInvocation(invocation),
    c = i.command,
    r = parseNativePaymentBackendReceipt(receipt, c),
    f = parsePaymentOriginalActionRef(ref);
  const { acceptedAt, manifestHash, verification, ...manifest } = copy;
  parseOriginalCopyReceipt(
    { acceptedAt, manifestHash, verification, ...manifest },
    parseOriginalCopyManifest(manifest),
  );
  ensure(
    r.paymentHash === i.paymentHash &&
      f.eventId === c.id &&
      f.paymentId === c.paymentId &&
      f.revision === r.revision &&
      copy.businessId === c.businessId &&
      copy.outletId === c.outletId &&
      copy.actorId === c.actorId,
  );
  return {
    copyId: copy.id,
    ref: f,
    requestHash: paymentInvocationHash(i),
    paymentHash: i.paymentHash,
    receiptHash: paymentInvocationHash(r),
  };
}
export function assertNativePaymentOriginalLink(
  link: unknown,
  invocation: NativePaymentInvocation,
  receipt: NativePaymentBackendReceipt,
  copy: OriginalCopyReceipt,
  ref: PaymentOriginalActionRef,
): NativePaymentOriginalLink {
  const l = parseNativePaymentOriginalLink(link),
    i = parseNativePaymentInvocation(invocation),
    q = nativePaymentOriginalRequest(i, receipt, copy, ref),
    c = i.command;
  ensure(
    l.id === c.id &&
      l.businessId === c.businessId &&
      l.outletId === c.outletId &&
      l.actorId === c.actorId &&
      l.requestHash === q.requestHash &&
      l.paymentHash === q.paymentHash &&
      l.receiptHash === q.receiptHash &&
      literalToken(l.ref) === literalToken(q.ref) &&
      literalToken(l.retention.copy) === literalToken(copy),
  );
  return l;
}
/** A complete strict original proves source/history. The actual server outcome is
 * compared separately; neither this result nor a content receipt permits a write. */
export function readLinkedPaymentOriginal(
  link: unknown,
  invocation: NativePaymentInvocation,
  receipt: NativePaymentBackendReceipt,
  portable: PortableBackup,
) {
  const l = parseNativePaymentOriginalLink(link),
    i = parseNativePaymentInvocation(invocation);
  assertNativePaymentOriginalLink(l, i, receipt, l.retention.copy, l.ref);
  const decoded = parsePortableBackup(portable),
    basis = decoded.bases.find((b) => b.root === l.ref.root);
  ensure(basis);
  const nodes = new Map(decoded.nodes.map((n) => [n.digest, n.json])),
    action = readPaymentOriginalAction(basis, (key) => nodes.get(key), l.ref);
  ensure(
    literalToken(action.invocation) === literalToken(i) &&
      paymentInvocationHash(action.after) === i.paymentHash &&
      paymentInvocationHash(action.before) === i.command.beforeHash &&
      literalToken(nativePaymentSourceRef(action.source)) ===
        literalToken(i.command.source),
  );
  return { link: l, action, decoded };
}

/** The server supplies the actual current member separately from copy origin.
 * Check it on every operation/part; caller-labelled reader IDs create no proof. */
export function paymentOriginalResponse(
  value: unknown,
  reader: { businessId: string; outletId: string; actorId: string },
): unknown {
  ensure(
    object(value) &&
      exact(value, 'reader,value') &&
      object(value.reader) &&
      exact(value.reader, 'businessId,outletId,actorId'),
  );
  ensure(
    value.reader.businessId === reader.businessId &&
      value.reader.outletId === reader.outletId &&
      value.reader.actorId === reader.actorId &&
      [
        value.reader.businessId,
        value.reader.outletId,
        value.reader.actorId,
      ].every(id),
  );
  return value.value;
}
