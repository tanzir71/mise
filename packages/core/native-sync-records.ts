import {parseNativePaymentOriginalLink,paymentOriginalLinkMaxBytes} from './native-payment-originals';
import { validateBackupRow } from './backup-schema';
import { MAX_BACKUP_BYTES } from './backup-tables';
import {
  nativePaymentBodyLimit,
  parseNativePaymentBackendReceipt,
} from './payment-backend';
import {
  parseNativePaymentInvocation,
  paymentInvocationHash,
  nativePaymentId,
} from './payment-invocations';
import { literalToken } from './literal-token';
import type { AuditEvent, Payment } from './models';

/** Explicit feed projections, never private table grants or write permissions. */
export const nativeSyncRecordColumns = Object.freeze({
  native_payment_originals: Object.freeze(['id','business_id','outlet_id','record_json']),
  native_payments: Object.freeze([
    'id',
    'business_id',
    'outlet_id',
    'record_json',
  ]),
  native_payment_events: Object.freeze([
    'id',
    'business_id',
    'outlet_id',
    'record_json',
  ]),
  native_payment_actions: Object.freeze([
    'id',
    'business_id',
    'outlet_id',
    'actor_id',
    'request_hash',
    'intent_json',
    'receipt',
  ]),
});
export type NativeSyncTable = keyof typeof nativeSyncRecordColumns;
export const isNativeSyncTable = (value: string): value is NativeSyncTable =>
  Object.hasOwn(nativeSyncRecordColumns, value);
/** Bound the outer JSON string before allocating a complete incoming record.
 * JSON escaping can double the original literal bytes. Legacy limits stay intact. */
export function nativeSyncRecordByteLimit(table: NativeSyncTable): number {
  if(table==='native_payment_originals')return 2*paymentOriginalLinkMaxBytes+4096;
  return table === 'native_payment_actions'
    ? 2 * nativePaymentBodyLimit + 8192
    : 2 * MAX_BACKUP_BYTES + 4096;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
function ensure(v: unknown): asserts v {
  if (!v)
    throw Error(
      'Keep the complete scoped native payment projection and original download.',
    );
}
const commands = new Set([
  'payment.capture',
  'payment.edit',
  'payment.match',
  'payment.unmatch',
  'payment.void',
  'payment.reopen',
  'payment.record',
  'payment.record-undo',
]);
function json(value: unknown, maximum: number): unknown {
  ensure(
    typeof value === 'string' &&
      value.length <= maximum &&
      new TextEncoder().encode(value).length <= maximum,
  );
  return JSON.parse(value);
}
/** Only row-level decoding. Whole-history/original financial validation and live
 * canonical installation are separate requirements; this creates no authority. */
export function decodeNativeSyncRecord(
  table: NativeSyncTable,
  value: unknown,
  scope: { businessId: string; outletId: string },
): Record<string, unknown> {
  ensure(
    object(value) &&
      Object.keys(value).sort().join(',') ===
        [...nativeSyncRecordColumns[table]].sort().join(','),
  );
  ensure(
    id(value.id) &&
      value.business_id === scope.businessId &&
      value.outlet_id === scope.outletId &&
      id(scope.businessId) &&
      id(scope.outletId),
  );
  if(table==='native_payment_originals'){
    const link=parseNativePaymentOriginalLink(json(value.record_json,paymentOriginalLinkMaxBytes));
    ensure(link.id===value.id&&link.businessId===scope.businessId&&link.outletId===scope.outletId);
  } else if (table === 'native_payment_actions') {
    const invocation = parseNativePaymentInvocation(
        json(value.intent_json, nativePaymentBodyLimit),
      ),
      c = invocation.command;
    ensure(
      c.id === value.id &&
        c.businessId === scope.businessId &&
        c.outletId === scope.outletId &&
        c.actorId === value.actor_id &&
        value.intent_json === literalToken(invocation) &&
        value.request_hash === paymentInvocationHash(invocation),
    );
    const receipt = parseNativePaymentBackendReceipt(value.receipt, c);
    ensure(receipt.paymentHash === invocation.paymentHash);
  } else if (table === 'native_payments') {
    const payment = json(value.record_json, MAX_BACKUP_BYTES) as Payment;
    validateBackupRow('payments', payment, 'native payment');
    ensure(payment.id === value.id && payment.outletId === scope.outletId);
  } else {
    const event = json(value.record_json, MAX_BACKUP_BYTES) as AuditEvent;
    validateBackupRow('events', event, 'native payment audit');
    ensure(event.id === value.id && event.outletId === scope.outletId);
    if (commands.has(event.command)) {
      validateBackupRow('payments', event.after, 'native payment result');
      if (event.before !== null)
        validateBackupRow(
          'payments',
          event.before,
          'native payment predecessor',
        );
      const after = event.after as Payment;
      ensure(
        event.paymentId === after.id &&
          event.paymentRevision === after.revision &&
          after.eventId === event.id &&
          event.actor.type === 'member',
      );
    } else if (event.command === 'source.payment-invocation') {
      const invocation = parseNativePaymentInvocation(event.after),
        c = invocation.command;
      ensure(
        event.before === null &&
          event.id === nativePaymentId(c.id, 'invocation') &&
          event.outletId === c.outletId &&
          c.businessId === scope.businessId &&
          event.actor.type === 'member' &&
          event.actor.id === c.actorId &&
          event.at === c.occurredAt,
      );
    } else ensure(event.command === 'source.payment-evidence');
  }
  // Preserve the exact original JSON strings rather than serializing a newer view.
  return structuredClone(value);
}
