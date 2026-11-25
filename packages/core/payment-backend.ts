import type { AuditEvent, Payment, SetupSnapshot } from './models';
import {
  decodeCommandRecord,
  encodeCommandRecord,
  type CloudRecord,
} from './cloud-records';
import type { BackupTable } from './backup-tables';
import { validateBackupRow } from './backup-schema';
import { validatePaymentHistory } from './payment-history';
import { validatePaymentFinanceLinks } from './payment-finance-links';
import { validateInboxHistory } from './inbox-history';
import { validateInboxItem, type InboxItem } from './inbox';
import {
  previewPaymentMoneyUndo,
  type PaymentFinanceRecords,
} from './payment-finance';
import {
  executeNativePaymentCommand,
  type NativePaymentMutation,
} from './payment-native-commands';
import {
  parseNativePaymentCommand,
  parseNativePaymentInvocation,
  paymentInvocationHash,
  nativePaymentId,
  type NativePaymentCommand,
  type NativePaymentInvocation,
} from './payment-invocations';
import { literalToken } from './literal-token';

export const nativePaymentHeader = 'X-Mise-Native-Payment';
export const nativePaymentBodyLimit = 256000;
export interface NativePaymentBackendReceipt {
  format: 'mise-native-payment-receipt';
  version: 1;
  id: string;
  type: NativePaymentCommand['type'];
  businessId: string;
  outletId: string;
  actorId: string;
  paymentId: string;
  inboxId: string;
  occurredAt: number;
  at: number;
  revision: number;
  paymentHash: string;
  eventId: string;
  invocationId: string;
  financial: null | {
    kind: 'record' | 'undo';
    postingEventId: string;
    receiptKind: 'sale' | 'credit';
    receiptId: string;
    eventIds: string[];
    mode: 'performed' | 'already-undone' | null;
  };
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 253402300799999;
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the original native payment request and actual scoped backend records.',
    );
}
export class NativePaymentBackendConflict extends Error {}
export function nativePaymentWritePlan(input: NativePaymentInvocation) {
  const i = parseNativePaymentInvocation(input),
    c = i.command;
  return {
    businessId: c.businessId,
    actorId: c.actorId,
    paymentId: c.paymentId,
    inboxId: c.inboxId,
    revision: c.revision,
    paymentHash: i.paymentHash,
    intentJson: literalToken(i),
  };
}
const recordTables = {
  orders: 'orders',
  sales: 'sales',
  creditEntries: 'entries',
  creditAccounts: 'accounts',
  customers: 'customers',
  orderRefunds: 'refunds',
  events: 'events',
} as const;
/** Only current authenticated preparation can supply this context. It is never
 * returned by the HTTP handler, and a serialized graph supplies no write rights. */
export function nativePaymentBackendMutation(
  value: unknown,
  input: NativePaymentInvocation,
): NativePaymentMutation {
  const invocation = parseNativePaymentInvocation(input),
    c = invocation.command;
  ensure(
    object(value) &&
      id(value.businessId) &&
      value.businessId === c.businessId &&
      value.outletId === c.outletId &&
      value.actorId === c.actorId &&
      time(value.at) &&
      typeof value.contextJson === 'string',
  );
  const raw: unknown = JSON.parse(value.contextJson);
  ensure(
    object(raw) &&
      exact(
        raw,
        'business,outlet,member,memberOutlets,inboxItems,images,payments,nativeEvents,orders,sales,creditEntries,creditAccounts,customers,orderRefunds,events',
      ) &&
      object(raw.business) &&
      object(raw.outlet) &&
      object(raw.member) &&
      Array.isArray(raw.memberOutlets) &&
      raw.memberOutlets.every(id),
  );
  const decode = (table: BackupTable, row: unknown) => {
    ensure(object(row));
    if (table !== 'businesses' && table !== 'outlets' && table !== 'members')
      ensure(
        row.business_id === c.businessId &&
          (table === 'customers' || row.outlet_id === c.outletId),
      );
    const decoded = decodeCommandRecord(table, row);
    if (table !== 'inboxItems')
      validateBackupRow(table, decoded, `native backend ${table}`);
    return decoded;
  };
  const member = {
    ...decodeCommandRecord('members', raw.member),
    outletIds: raw.memberOutlets,
  };
  validateBackupRow('members', member, 'native backend member');
  const setup = {
    business: decode('businesses', raw.business),
    outlet: decode('outlets', raw.outlet),
    owner: member,
  } as unknown as SetupSnapshot;
  ensure(
    setup.business.id === c.businessId &&
      setup.outlet.id === c.outletId &&
      setup.outlet.businessId === c.businessId &&
      setup.owner.businessId === c.businessId &&
      setup.owner.id === c.actorId,
  );
  ensure(
    Array.isArray(raw.inboxItems) &&
      Array.isArray(raw.images) &&
      Array.isArray(raw.payments) &&
      Array.isArray(raw.nativeEvents),
  );
  const images = new Map<string, InboxItem['images']>();
  for (const row of raw.images) {
    ensure(
      object(row) &&
        row.business_id === c.businessId &&
        row.outlet_id === c.outletId &&
        id(row.inbox_item_id) &&
        id(row.id) &&
        typeof row.name === 'string' &&
        typeof row.type === 'string' &&
        typeof row.size === 'number',
    );
    const list = images.get(row.inbox_item_id) ?? [];
    ensure(row.position === list.length);
    list.push({
      id: row.id,
      name: row.name,
      type: row.type as InboxItem['images'][number]['type'],
      size: row.size,
    });
    images.set(row.inbox_item_id, list);
  }
  const sources = raw.inboxItems.map((row) => {
    const item = {
      ...decode('inboxItems', row),
      images: images.get((row as { id: string }).id) ?? [],
    } as unknown as InboxItem;
    validateInboxItem(item);
    return item;
  });
  const payments = raw.payments.map((data) => {
    ensure(typeof data === 'string');
    const p: unknown = JSON.parse(data);
    validateBackupRow('payments', p, 'native backend payment');
    ensure((p as Payment).outletId === c.outletId);
    return p as Payment;
  });
  const nativeEvents = raw.nativeEvents.map((data) => {
    ensure(typeof data === 'string');
    const e: unknown = JSON.parse(data);
    validateBackupRow('events', e, 'native backend event');
    ensure((e as AuditEvent).outletId === c.outletId);
    return e as AuditEvent;
  });
  const records = { setup } as PaymentFinanceRecords;
  for (const [table, key] of Object.entries(recordTables)) {
    const rows = raw[table];
    ensure(Array.isArray(rows));
    Object.assign(records, {
      [key]: rows.map((row) => decode(table as BackupTable, row)),
    });
  }
  records.events = [...records.events, ...nativeEvents];
  validateInboxHistory(sources, records.events);
  validatePaymentHistory(payments, records.events, sources);
  validatePaymentFinanceLinks(payments, {
    outlets: [setup.outlet],
    orders: records.orders.slice(),
    sales: records.sales.slice(),
    creditEntries: records.entries.slice(),
    creditAccounts: records.accounts.slice(),
    customers: records.customers.slice(),
    events: records.events.slice(),
  });
  const source = sources.find((s) => s.id === c.inboxId);
  ensure(source);
  if (c.occurredAt > value.at + 300000)
    throw new NativePaymentBackendConflict(
      'Check the device clock before saving the original payment.',
    );
  try {
    // A caller cannot backdate an expired undo into fresh backend authority.
    if (c.type === 'payment.record-undo') {
      const current = payments.find((p) => p.id === c.paymentId);
      ensure(current);
      const liveUndo = previewPaymentMoneyUndo(current, records, value.at);
      if (
        !liveUndo.alreadyUndone &&
        (liveUndo.expired || value.at < liveUndo.recordedAt)
      )
        throw new NativePaymentBackendConflict(
          'The original backend undo window expired.',
        );
    }
    const change = executeNativePaymentCommand(c, records, payments, source);
    if (
      paymentInvocationHash(change.payment.payment) !== invocation.paymentHash
    )
      throw new NativePaymentBackendConflict(
        'The backend result differs from the retained original native action.',
      );
    return change;
  } catch (error) {
    if (error instanceof NativePaymentBackendConflict) throw error;
    throw new NativePaymentBackendConflict(
      'The original source or financial comparison changed. Open its current review.',
    );
  }
}
export function nativePaymentWriteFields(
  value: unknown,
  input: NativePaymentInvocation,
  ticketId: string,
) {
  const invocation = parseNativePaymentInvocation(input),
    c = invocation.command;
  ensure(
    object(value) &&
      value.done === false &&
      value.ticketId === ticketId &&
      id(ticketId) &&
      typeof value.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token),
  );
  const change = nativePaymentBackendMutation(value, invocation),
    records: CloudRecord[] = [];
  for (const row of change.orders)
    records.push(encodeCommandRecord('orders', row, c.businessId));
  for (const row of change.sales)
    records.push(encodeCommandRecord('sales', row, c.businessId));
  for (const row of change.entries)
    records.push(encodeCommandRecord('creditEntries', row, c.businessId));
  const privateEvents: AuditEvent[] = [
    change.payment.event,
    ...(change.payment.evidenceEvents ?? []),
    change.invocation,
  ];
  for (const event of change.events)
    if (event.command === 'source.payment-evidence') privateEvents.push(event);
    else records.push(encodeCommandRecord('events', event, c.businessId));
  return {
    p_ticket_id: ticketId,
    p_token: value.token,
    p_payment_json: literalToken(change.payment.payment),
    p_events: privateEvents.map(literalToken),
    p_records: records,
  };
}
export function nativePaymentReceiptFor(
  c: NativePaymentCommand,
  payment: Payment,
  at: number,
): NativePaymentBackendReceipt {
  c = parseNativePaymentCommand(c);
  ensure(
    time(at) &&
      payment.id === c.paymentId &&
      payment.revision === c.revision + 1 &&
      payment.eventId === c.id,
  );
  const p = payment.postings?.at(-1),
    financial =
      c.type === 'payment.record'
        ? (ensure(p && p.eventId === c.id),
          {
            kind: 'record' as const,
            postingEventId: p.eventId,
            receiptKind: p.receipt.kind,
            receiptId: p.receipt.id,
            eventIds: p.receipt.eventIds,
            mode: null,
          })
        : c.type === 'payment.record-undo'
          ? (ensure(p?.undo && p.undo.eventId === c.id),
            {
              kind: 'undo' as const,
              postingEventId: p.eventId,
              receiptKind: p.receipt.kind,
              receiptId: p.receipt.id,
              eventIds: p.undo.eventIds,
              mode: p.undo.mode,
            })
          : null;
  return {
    format: 'mise-native-payment-receipt',
    version: 1,
    id: c.id,
    type: c.type,
    businessId: c.businessId,
    outletId: c.outletId,
    actorId: c.actorId,
    paymentId: c.paymentId,
    inboxId: c.inboxId,
    occurredAt: c.occurredAt,
    at,
    revision: payment.revision,
    paymentHash: paymentInvocationHash(payment),
    eventId: c.id,
    invocationId: nativePaymentId(c.id, 'invocation'),
    financial,
  };
}
export function parseNativePaymentBackendReceipt(
  value: unknown,
  input: NativePaymentCommand,
  expected?: Payment,
): NativePaymentBackendReceipt {
  const c = parseNativePaymentCommand(input);
  ensure(
    object(value) &&
      exact(
        value,
        'format,version,id,type,businessId,outletId,actorId,paymentId,inboxId,occurredAt,at,revision,paymentHash,eventId,invocationId,financial',
      ) &&
      value.format === 'mise-native-payment-receipt' &&
      value.version === 1 &&
      value.id === c.id &&
      value.type === c.type &&
      value.businessId === c.businessId &&
      value.outletId === c.outletId &&
      value.actorId === c.actorId &&
      value.paymentId === c.paymentId &&
      value.inboxId === c.inboxId &&
      value.occurredAt === c.occurredAt &&
      time(value.at) &&
      value.revision === c.revision + 1 &&
      hash(value.paymentHash) &&
      value.eventId === c.id &&
      value.invocationId === nativePaymentId(c.id, 'invocation'),
  );
  if (c.type === 'payment.record' || c.type === 'payment.record-undo') {
    const f = value.financial;
    ensure(
      object(f) &&
        exact(f, 'kind,postingEventId,receiptKind,receiptId,eventIds,mode') &&
        f.kind === (c.type === 'payment.record' ? 'record' : 'undo') &&
        id(f.postingEventId) &&
        ['sale', 'credit'].includes(f.receiptKind as string) &&
        id(f.receiptId) &&
        Array.isArray(f.eventIds) &&
        f.eventIds.length <= 3 &&
        f.eventIds.every(id) &&
        new Set(f.eventIds).size === f.eventIds.length,
    );
    if (c.type === 'payment.record')
      ensure(
        f.postingEventId === c.id &&
          f.mode === null &&
          f.eventIds.length > 0 &&
          f.receiptId ===
            nativePaymentId(
              c.id,
              f.receiptKind === 'sale' ? 'money-sale' : 'money-entry',
            ),
      );
    else ensure(['performed', 'already-undone'].includes(f.mode as string));
  } else ensure(value.financial === null);
  if (expected)
    ensure(
      literalToken(value) ===
        literalToken(nativePaymentReceiptFor(c, expected, value.at)),
    );
  return structuredClone(value) as unknown as NativePaymentBackendReceipt;
}
