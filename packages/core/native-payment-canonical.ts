import { prepareOriginalCopy, parseOriginalCopyReceipt } from './original-copy';
import { currentPaymentReceipt } from './payment-receipts';
import type { AuditEvent, Payment } from './models';
import type { MiseBackup } from './backup-tables';
import { parseBackup } from './backup';
import { literalToken } from './literal-token';
import {
  decodeNativeSyncRecord,
  isNativeSyncTable,
} from './native-sync-records';
import type { CanonicalRecord } from './sync-canonical';
import {
  parseNativePaymentInvocation,
  paymentInvocationHash,
  nativePaymentId,
  type NativePaymentInvocation,
} from './payment-invocations';
import {
  parseNativePaymentBackendReceipt,
  type NativePaymentBackendReceipt,
} from './payment-backend';
import {
  parseNativePaymentOriginalLink,
  assertNativePaymentOriginalLink,
  type NativePaymentOriginalLink,
} from './native-payment-originals';
import {
  parsePortableBackup,
  verifyPaymentArchive,
  paymentArchiveMaxExpandedBytes,
  type PortableBackup,
} from './payment-archive';
import {
  paymentOriginalActionReader,
  readPaymentOriginalBasis,
  type PaymentOriginalAction,
  type PaymentOriginalBasis,
  type PaymentOriginalNode,
} from './payment-originals';
import {
  PaymentEvidenceReader,
  paymentEvidenceCommand,
} from './payment-evidence';
import { validatePaymentHistory } from './payment-history';

export class NativePaymentCanonicalError extends Error {
  constructor(
    readonly reason: 'incomplete' | 'original-required' | 'metadata-removed',
    readonly actionId: string | null = null,
  ) {
    super(
      'Keep the complete native payment download and exact originals before reconciling this shop.',
    );
  }
}
export type NativePaymentOriginalLoader = (
  link: NativePaymentOriginalLink,
) => Promise<{ link: NativePaymentOriginalLink; portable: PortableBackup }>;
export interface NativePaymentCanonicalAction {
  invocation: NativePaymentInvocation;
  receipt: NativePaymentBackendReceipt;
  source: NativePaymentOriginalLink;
}
export interface NativePaymentRowComparison {
  table: 'orders' | 'sales' | 'creditEntries' | 'events';
  id: string;
  state: 'same' | 'changed' | 'missing';
  originalHash: string;
  currentHash: string | null;
}
export interface NativePaymentCurrentComparison {
  paymentId: string;
  association: NativePaymentRowComparison | null;
  postings: {
    eventId: string;
    receipt: NativePaymentRowComparison;
    currentReceipt: { eligible: boolean; matchesOriginal: boolean };
    events: NativePaymentRowComparison[];
    nativeUndo: null | {
      eventId: string;
      mode: 'performed' | 'already-undone';
      events: NativePaymentRowComparison[];
    };
  }[];
}
/** Read evidence only. Current money is the independent ordinary snapshot.
 * This is neither a portable backup nor an installation/write capability. */
export interface NativePaymentCanonicalProjection {
  format: 'mise-native-payment-canonical-read';
  version: 1;
  businessId: string;
  outletId: string;
  payments: Payment[];
  events: AuditEvent[];
  actions: NativePaymentCanonicalAction[];
  originals: { bases: PaymentOriginalBasis[]; nodes: PaymentOriginalNode[] };
  current: NativePaymentCurrentComparison[];
}
function ensure(v: unknown): asserts v {
  if (!v) throw new NativePaymentCanonicalError('incomplete');
}
const same = (a: unknown, b: unknown) => literalToken(a) === literalToken(b);
const actionCommand = (e: AuditEvent) => e.command.startsWith('payment.');
const scopeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);

/** Verify the complete merged native projection against actual linked originals.
 * Metadata deletion or an older action with no genuine source remains retained
 * in the download; it must never become invented history or an empty install. */
export async function projectNativePaymentCanonical(
  records: readonly CanonicalRecord[],
  currentInput: MiseBackup,
  scope: { businessId: string; outletId: string },
  load: NativePaymentOriginalLoader,
): Promise<NativePaymentCanonicalProjection> {
  const current = parseBackup(currentInput),
    t = current.tables;
  ensure(
    scopeId(scope.businessId) &&
      scopeId(scope.outletId) &&
      t.businesses.length === 1 &&
      t.outlets.length === 1 &&
      t.businesses[0].id === scope.businessId &&
      t.outlets[0].id === scope.outletId &&
      t.outlets[0].businessId === scope.businessId,
  );
  // Ordinary records must stay independently valid and must not contain an
  // unverified mixture of the private native history being reconstructed.
  ensure(!t.payments.length);
  const payments: Payment[] = [],
    events: AuditEvent[] = [],
    actions = new Map<string, Omit<NativePaymentCanonicalAction, 'source'>>(),
    links = new Map<string, NativePaymentOriginalLink>(),
    identities = new Set<string>(),
    ordinals = new Set<string>();
  for (const r of records) {
    if (!isNativeSyncTable(r.table)) continue;
    if (r.operation === 'delete')
      throw new NativePaymentCanonicalError('metadata-removed', r.id);
    ensure(
      r.operation === 'upsert' &&
        r.row &&
        /^[1-9][0-9]{0,18}$/.test(r.changeId) &&
        BigInt(r.changeId) <= 9223372036854775807n,
    );
    ensure(!identities.has(r.table + '\0' + r.id) && !ordinals.has(r.changeId));
    identities.add(r.table + '\0' + r.id);
    ordinals.add(r.changeId);
    ensure(paymentInvocationHash(r.row) === r.rowHash);
    const row = decodeNativeSyncRecord(r.table, r.row, scope);
    ensure(row.id === r.id);
    if (r.table === 'native_payments')
      payments.push(JSON.parse(row.record_json as string) as Payment);
    else if (r.table === 'native_payment_events')
      events.push(JSON.parse(row.record_json as string) as AuditEvent);
    else if (r.table === 'native_payment_originals')
      links.set(
        r.id,
        parseNativePaymentOriginalLink(JSON.parse(row.record_json as string)),
      );
    else {
      const invocation = parseNativePaymentInvocation(
          JSON.parse(row.intent_json as string),
        ),
        receipt = parseNativePaymentBackendReceipt(
          row.receipt,
          invocation.command,
        );
      // A source is assigned only after its distinct same-snapshot row is checked.
      actions.set(r.id, { invocation, receipt });
    }
  }
  const byPayment = new Map(payments.map((p) => [p.id, p])),
    byEvent = new Map(events.map((e) => [e.id, e]));
  ensure(
    byPayment.size === payments.length &&
      byEvent.size === events.length &&
      events.every((e) => !t.events.some((other) => other.id === e.id)),
  );
  ensure(
    [...links.keys()].every((id) => actions.has(id)) &&
      events.filter(actionCommand).length === actions.size &&
      events.filter((e) => e.command === 'source.payment-invocation').length ===
        actions.size,
  );
  const copies = new Map<
      string,
      {
        bases: PaymentOriginalBasis[];
        retention: NativePaymentOriginalLink['retention'];
      }
    >(),
    verifiedActions: NativePaymentCanonicalAction[] = [],
    roots = new Map<
      string,
      {
        basis: PaymentOriginalBasis;
        snapshot: MiseBackup;
        read: ReturnType<typeof paymentOriginalActionReader>;
      }
    >(),
    pool = new Map<string, string>(),
    availableNodes = new Map<string, string>(),
    usedEvidence = new Set<string>(),
    originals = new Map<string, PaymentOriginalAction>(),
    sources = new Map<string, PaymentOriginalAction['source']>();
  let nodeBytes = 0,
    snapshotBytes = 0;
  for (const [id, a] of actions) {
    const link = links.get(id);
    if (!link) throw new NativePaymentCanonicalError('original-required', id);
    const i = a.invocation,
      c = i.command;
    ensure(
      byPayment.has(c.paymentId) &&
        byEvent.has(c.id) &&
        byEvent.has(nativePaymentId(c.id, 'invocation')),
    );
    assertNativePaymentOriginalLink(
      link,
      i,
      a.receipt,
      link.retention.copy,
      link.ref,
    );
    let copy = copies.get(link.retention.copy.id);
    if (!copy) {
      const loaded = await load(structuredClone(link));
      ensure(same(loaded.link, link));
      const plan = prepareOriginalCopy(
        loaded.portable,
        {
          businessId: link.businessId,
          outletId: link.outletId,
          actorId: link.actorId,
        },
        link.retention.copy.id,
      );
      parseOriginalCopyReceipt(link.retention.copy, plan.manifest);
      const decoded = parsePortableBackup(loaded.portable);
      for (const n of decoded.nodes) {
        const old = availableNodes.get(n.digest);
        ensure(old === undefined || old === n.json);
        if (old === undefined) {
          nodeBytes += new TextEncoder().encode(n.json).length;
          ensure(nodeBytes <= paymentArchiveMaxExpandedBytes);
          availableNodes.set(n.digest, n.json);
        }
      }
      copy = { bases: decoded.bases, retention: link.retention };
      copies.set(link.retention.copy.id, copy);
    } else ensure(same(copy.retention, link.retention));
    // Check this exact copy even when another copy supplied the same root.
    const basis = copy.bases.find((b) => b.root === link.ref.root);
    ensure(basis);
    let root = roots.get(link.ref.root);
    if (root) ensure(same(root.basis, basis));
    else {
      snapshotBytes += basis.snapshotBytes;
      ensure(snapshotBytes <= paymentArchiveMaxExpandedBytes);
      const used = new Set<string>(),
        snapshot = readPaymentOriginalBasis(basis, (key) => {
          used.add(key);
          return availableNodes.get(key);
        });
      for (const key of used) {
        const json = availableNodes.get(key);
        ensure(json !== undefined);
        pool.set(key, json);
      }
      root = {
        basis,
        snapshot,
        read: paymentOriginalActionReader(basis, (key) =>
          availableNodes.get(key),
        ),
      };
      roots.set(basis.root, root);
    }
    ensure(
      root.basis.scope.businessId === scope.businessId &&
        root.basis.scope.outletId === scope.outletId,
    );
    const original = root.read(link.ref);
    ensure(
      same(original.invocation, i) &&
        same(original.event, byEvent.get(id)) &&
        paymentInvocationHash(original.after) === i.paymentHash &&
        paymentInvocationHash(original.before) === c.beforeHash,
    );
    parseNativePaymentBackendReceipt(a.receipt, c, original.after);
    const invocationEvent = root.snapshot.tables.events.find(
      (e) => e.id === nativePaymentId(id, 'invocation'),
    );
    ensure(
      invocationEvent && same(invocationEvent, byEvent.get(invocationEvent.id)),
    );
    const oldSource = sources.get(original.source.id);
    // The immutable source payload must be identical across all revisions. Its
    // current sorting metadata is independent and is never substituted here.
    if (oldSource)
      ensure(
        same(
          {
            title: oldSource.title,
            text: oldSource.text,
            url: oldSource.url,
            createdAt: oldSource.createdAt,
          },
          {
            title: original.source.title,
            text: original.source.text,
            url: original.source.url,
            createdAt: original.source.createdAt,
          },
        ),
      );
    else sources.set(original.source.id, original.source);
    const evidence = new PaymentEvidenceReader(
      events,
      root.snapshot.tables.creditEntries,
    );
    for (const p of [original.after]) {
      if (p.association)
        evidence.expand(p.association.fingerprint, p.association.at);
      for (const posting of p.postings ?? []) {
        evidence.expand(posting.target.fingerprint, posting.at);
        evidence.expand(posting.receipt.fingerprint, posting.at);
        if (posting.undo)
          evidence.expand(posting.undo.fingerprint, posting.undo.at);
      }
    }
    for (const used of evidence.usedEventIds()) {
      const expected = root.snapshot.tables.events.find((e) => e.id === used);
      ensure(expected && same(expected, byEvent.get(used)));
      usedEvidence.add(used);
    }
    verifiedActions.push({ ...a, source: link });
    originals.set(id, original);
  }
  for (const e of events)
    if (e.command === paymentEvidenceCommand) ensure(usedEvidence.has(e.id));
  validatePaymentHistory(payments, events, [...sources.values()]);
  for (const p of payments) {
    const latest = originals.get(p.eventId);
    ensure(latest && same(latest.after, p));
  }
  const bases = [...roots.values()]
      .map((r) => r.basis)
      .sort((a, b) => a.root.localeCompare(b.root)),
    nodes = [...pool]
      .map(([digest, json]) => ({ digest, json }))
      .sort((a, b) => a.digest.localeCompare(b.digest));
  verifyPaymentArchive(current, bases, pool);
  const currentRows = {
    orders: new Map(t.orders.map((r) => [r.id, r])),
    sales: new Map(t.sales.map((r) => [r.id, r])),
    creditEntries: new Map(t.creditEntries.map((r) => [r.id, r])),
    events: new Map(t.events.map((r) => [r.id, r])),
  };
  function compare(
    table: NativePaymentRowComparison['table'],
    row: Record<string, unknown>,
  ): NativePaymentRowComparison {
    ensure(scopeId(row.id));
    const now = currentRows[table].get(row.id),
      originalHash = paymentInvocationHash(row),
      currentHash = now ? paymentInvocationHash(now) : null;
    return {
      table,
      id: row.id,
      state:
        currentHash === null
          ? 'missing'
          : currentHash === originalHash
            ? 'same'
            : 'changed',
      originalHash,
      currentHash,
    };
  }
  ensure(t.members.length > 0);
  const receiptRecords = {
    setup: {
      business: t.businesses[0],
      outlet: t.outlets[0],
      owner: t.members[0],
    },
    orders: t.orders,
    sales: t.sales,
    entries: t.creditEntries,
    accounts: t.creditAccounts,
    customers: t.customers,
    refunds: t.orderRefunds,
    events: t.events,
  };
  const comparisons: NativePaymentCurrentComparison[] = payments.map((p) => {
    const latest = originals.get(p.eventId)!;
    const a = p.association,
      s = latest.association;
    const association = a
      ? (ensure(s),
        compare(
          a.kind === 'order'
            ? 'orders'
            : a.kind === 'sale'
              ? 'sales'
              : 'creditEntries',
          s[a.kind === 'credit' ? 'entry' : a.kind] as Record<string, unknown>,
        ))
      : null;
    return {
      paymentId: p.id,
      association,
      postings: (p.postings ?? []).map((posting) => {
        const origin = originals.get(posting.eventId),
          f = origin?.financial;
        ensure(f);
        let nativeUndo: NativePaymentCurrentComparison['postings'][number]['nativeUndo'] =
          null;
        if (posting.undo) {
          const undone = originals.get(posting.undo.eventId);
          ensure(undone?.financial?.undo);
          nativeUndo = {
            eventId: posting.undo.eventId,
            mode: posting.undo.mode,
            events: undone.financial.undo.events.map((e) =>
              compare('events', e as unknown as Record<string, unknown>),
            ),
          };
        }
        const actual = currentPaymentReceipt(
          receiptRecords,
          posting.receipt.kind,
          posting.receipt.id,
        );
        return {
          eventId: posting.eventId,
          currentReceipt: {
            eligible: !!actual,
            matchesOriginal:
              !!actual &&
              paymentInvocationHash(JSON.parse(actual.fingerprint)) ===
                paymentInvocationHash(f.receipt),
          },
          receipt: compare(
            posting.receipt.kind === 'sale' ? 'sales' : 'creditEntries',
            f.receipt[
              posting.receipt.kind === 'sale' ? 'sale' : 'entry'
            ] as Record<string, unknown>,
          ),
          events: f.events.map((e) =>
            compare('events', e as unknown as Record<string, unknown>),
          ),
          nativeUndo,
        };
      }),
    };
  });
  return structuredClone({
    format: 'mise-native-payment-canonical-read',
    version: 1,
    businessId: scope.businessId,
    outletId: scope.outletId,
    payments: payments.sort((a, b) => a.id.localeCompare(b.id)),
    events: events.sort((a, b) => a.id.localeCompare(b.id)),
    actions: verifiedActions.sort((a, b) =>
      a.invocation.command.id.localeCompare(b.invocation.command.id),
    ),
    originals: { bases, nodes },
    current: comparisons.sort((a, b) => a.paymentId.localeCompare(b.paymentId)),
  });
}
