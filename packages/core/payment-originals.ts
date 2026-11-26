import {
  readNativePaymentInvocation,
  type NativePaymentInvocation,
} from './payment-invocations';
import { validatePaymentFinanceLinks } from './payment-finance-links.ts';
import type { AuditEvent, Payment, PaymentPosting } from './models.ts';
import { sha256 } from '@noble/hashes/sha2';
import { parseBackup } from './backup.ts';
import { MAX_BACKUP_BYTES, type MiseBackup } from './backup-tables.ts';
import { literalToken } from './literal-token.ts';

// Frozen schema-13 contract. Adding a native table requires a new basis version;
// an older original must never silently acquire or lose a table on the wire.
export const paymentOriginalTables = [
  'businesses',
  'outlets',
  'members',
  'categories',
  'items',
  'events',
  'sales',
  'customers',
  'creditAccounts',
  'creditEntries',
  'orders',
  'orderNotes',
  'orderCommunications',
  'orderRefunds',
  'stockItems',
  'stockMoves',
  'suppliers',
  'supplierMessages',
  'dayClosings',
  'purchases',
  'inboxItems',
  'payments',
] as const;
export type PaymentOriginalTable = (typeof paymentOriginalTables)[number];
type Scope = { businessId: string; outletId: string };
export interface PaymentOriginalNode {
  readonly digest: string;
  readonly json: string;
}
export interface PaymentOriginalBasis {
  readonly format: 'mise-payment-original-basis';
  readonly version: 1;
  readonly scope: Readonly<Scope>;
  readonly root: string;
  readonly exportedAt: number;
  readonly counts: Readonly<Record<PaymentOriginalTable, number>>;
  readonly nodeCount: number;
  readonly nodeBytes: number;
  readonly snapshotBytes: number;
  readonly snapshotHash: string;
}
export interface PaymentOriginalPlan {
  readonly basis: PaymentOriginalBasis;
  /** Only missing immutable nodes. Existing nodes must match complete bytes. */
  readonly added: readonly PaymentOriginalNode[];
}
export const paymentOriginalLeafRows = 64;
export const paymentOriginalMaxNodeBytes = MAX_BACKUP_BYTES + 2048;
export const paymentOriginalMaxGraphBytes = MAX_BACKUP_BYTES * 4;
const maxRows = Math.floor(MAX_BACKUP_BYTES / 32);
const encoder = new TextEncoder();
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, fields: string) =>
  Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const same = (a: unknown, b: unknown) => literalToken(a) === literalToken(b);
function ensure(value: unknown): asserts value {
  if (!value)
    throw Error(
      'Keep the complete original payment snapshot and all its checked records.',
    );
}
const hashBytes = (bytes: Uint8Array) =>
  Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const hash = (text: string) => hashBytes(encoder.encode(text));
const identity = (scope: Scope, table: PaymentOriginalTable, rowId: string) =>
  hash(literalToken(['mise-payment-original-key-v1', scope, table, rowId]));
function scope(value: unknown): asserts value is Scope {
  ensure(
    object(value) &&
      exact(value, 'businessId,outletId') &&
      id(value.businessId) &&
      id(value.outletId),
  );
}
function counts(
  value: unknown,
): asserts value is Record<PaymentOriginalTable, number> {
  ensure(object(value) && exact(value, paymentOriginalTables.join(',')));
  let total = 0;
  for (const table of paymentOriginalTables) {
    ensure(integer(value[table], 0, maxRows));
    total += value[table] as number;
  }
  ensure(
    total <= maxRows &&
      value.businesses === 1 &&
      value.outlets === 1 &&
      (value.payments as number) > 0,
  );
}
export function parsePaymentOriginalBasis(
  value: unknown,
): PaymentOriginalBasis {
  ensure(
    object(value) &&
      exact(
        value,
        'format,version,scope,root,exportedAt,counts,nodeCount,nodeBytes,snapshotBytes,snapshotHash',
      ) &&
      value.format === 'mise-payment-original-basis' &&
      value.version === 1,
  );
  scope(value.scope);
  counts(value.counts);
  ensure(
    digest(value.root) &&
      digest(value.snapshotHash) &&
      integer(value.exportedAt, 0, 253402300799999) &&
      integer(
        value.nodeCount,
        1,
        maxRows * 2 + paymentOriginalTables.length * 65 + 1,
      ) &&
      integer(value.nodeBytes, 1, paymentOriginalMaxGraphBytes) &&
      integer(value.snapshotBytes, 1, MAX_BACKUP_BYTES),
  );
  return Object.freeze({
    format: 'mise-payment-original-basis',
    version: 1,
    scope: Object.freeze({ ...value.scope }),
    root: value.root,
    exportedAt: value.exportedAt,
    counts: Object.freeze({ ...value.counts }),
    nodeCount: value.nodeCount,
    nodeBytes: value.nodeBytes,
    snapshotBytes: value.snapshotBytes,
    snapshotHash: value.snapshotHash,
  });
}
function originalScope(backup: MiseBackup, expected?: Scope): Scope {
  const t = backup.tables;
  ensure(
    backup.schemaVersion === 13 &&
      Object.keys(t).sort().join(',') ===
        [...paymentOriginalTables].sort().join(',') &&
      t.businesses.length === 1 &&
      t.outlets.length === 1 &&
      t.payments.length > 0,
  );
  const s = { businessId: t.businesses[0].id, outletId: t.outlets[0].id };
  scope(s);
  if (expected) ensure(same(s, expected));
  ensure(
    t.outlets[0].businessId === s.businessId &&
      t.members.every((m) => m.businessId === s.businessId) &&
      t.customers.every((c) => c.businessId === s.businessId),
  );
  for (const table of paymentOriginalTables)
    for (const row of t[table])
      if ('outletId' in row) ensure(row.outletId === s.outletId);
  return s;
}
function canonicalSnapshot(backup: MiseBackup) {
  return {
    format: 'mise-backup',
    formatVersion: 1,
    schemaVersion: 13,
    exportedAt: backup.exportedAt,
    tables: Object.fromEntries(
      paymentOriginalTables.map((table) => [
        table,
        [...backup.tables[table]].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      ]),
    ),
  };
}
/** A complete original, not canonical money or write authority. It uses the
 * existing strict backup/financial validators; it never edits their rows.
 * Identity-hashed radix buckets share unaffected leaves when a row is inserted
 * or updated, unlike fixed array pages which shift after an earlier insertion. */
export function preparePaymentOriginalBasis(
  source: MiseBackup,
  available: ReadonlyMap<string, string> = new Map(),
): PaymentOriginalPlan {
  const backup = parseBackup(JSON.stringify(source)),
    s = originalScope(backup),
    snapshot = canonicalSnapshot(backup),
    snapshotJson = literalToken(snapshot),
    snapshotBytes = encoder.encode(snapshotJson).byteLength;
  ensure(snapshotBytes <= MAX_BACKUP_BYTES);
  const added: PaymentOriginalNode[] = [],
    used = new Map<string, string>();
  let nodeBytes = 0;
  function intern(value: Record<string, unknown>) {
    const json = literalToken({
        format: 'mise-payment-original-node',
        version: 1,
        scope: s,
        ...value,
      }),
      bytes = encoder.encode(json);
    ensure(bytes.length <= paymentOriginalMaxNodeBytes);
    const key = hashBytes(bytes),
      old = used.get(key);
    if (old !== undefined) {
      ensure(old === json);
      return key;
    }
    const existing = available.get(key);
    ensure(existing === undefined || existing === json);
    used.set(key, json);
    nodeBytes += bytes.length;
    ensure(nodeBytes <= paymentOriginalMaxGraphBytes);
    if (existing === undefined)
      added.push(Object.freeze({ digest: key, json }));
    return key;
  }
  const tableRoots: Record<string, { root: string; count: number }> = {};
  const rowCounts = {} as Record<PaymentOriginalTable, number>;
  for (const table of paymentOriginalTables) {
    const rows = snapshot.tables[table].map((row) => ({
      id: row.id,
      key: identity(s, table, row.id),
      digest: intern({ kind: 'record', table, value: row }),
    }));
    rowCounts[table] = rows.length;
    function bucket(values: typeof rows, prefix: string): string {
      if (values.length <= paymentOriginalLeafRows)
        return intern({
          kind: 'leaf',
          table,
          prefix,
          rows: values.map(({ id, digest }) => ({ id, digest })),
        });
      ensure(prefix.length < 64);
      const groups = new Map<string, typeof rows>();
      for (const row of values) {
        const nibble = row.key[prefix.length];
        const group = groups.get(nibble);
        if (group) group.push(row);
        else groups.set(nibble, [row]);
      }
      const children = [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([nibble, group]) => ({
          nibble,
          root: bucket(group, prefix + nibble),
        }));
      return intern({
        kind: 'branch',
        table,
        prefix,
        count: values.length,
        children,
      });
    }
    tableRoots[table] = { root: bucket(rows, ''), count: rows.length };
  }
  const root = intern({
    kind: 'root',
    schemaVersion: 13,
    exportedAt: backup.exportedAt,
    tables: tableRoots,
  });
  return Object.freeze({
    basis: parsePaymentOriginalBasis({
      format: 'mise-payment-original-basis',
      version: 1,
      scope: s,
      root,
      exportedAt: backup.exportedAt,
      counts: rowCounts,
      nodeCount: used.size,
      nodeBytes,
      snapshotBytes,
      snapshotHash: hash(snapshotJson),
    }),
    added: Object.freeze(added),
  });
}

/** Missing, changed, cross-scope or incomplete nodes fail before a snapshot is
 * returned. Shared pool rows belonging to other roots are never read as proof. */
export function readPaymentOriginalBasis(
  input: unknown,
  readNode: (digest: string) => string | undefined,
): MiseBackup {
  const basis = parsePaymentOriginalBasis(input),
    loaded = new Map<string, Record<string, unknown>>();
  let nodeBytes = 0,
    recordBytes = 0;
  const sizes = new Map<string, number>();
  function load(key: unknown, limit = 16384): Record<string, unknown> {
    ensure(digest(key));
    const prior = loaded.get(key);
    if (prior) {
      ensure(sizes.get(key)! <= limit);
      return prior;
    }
    const json = readNode(key);
    ensure(typeof json === 'string' && json.length <= limit);
    const bytes = encoder.encode(json);
    nodeBytes += bytes.length;
    ensure(
      bytes.length <= paymentOriginalMaxNodeBytes &&
        nodeBytes <= basis.nodeBytes &&
        loaded.size < basis.nodeCount &&
        hashBytes(bytes) === key,
    );
    let node: unknown;
    try {
      node = JSON.parse(json);
    } catch {
      throw Error('Keep the literal original payment node.');
    }
    ensure(
      object(node) &&
        node.format === 'mise-payment-original-node' &&
        node.version === 1 &&
        same(node.scope, basis.scope) &&
        literalToken(node) === json,
    );
    loaded.set(key, node);
    sizes.set(key, bytes.length);
    return node;
  }
  const header = load(basis.root);
  ensure(
    exact(
      header,
      'format,version,scope,kind,schemaVersion,exportedAt,tables',
    ) &&
      header.kind === 'root' &&
      header.schemaVersion === 13 &&
      header.exportedAt === basis.exportedAt &&
      object(header.tables) &&
      exact(header.tables, paymentOriginalTables.join(',')),
  );
  const tables: Record<string, unknown[]> = {};
  for (const table of paymentOriginalTables) {
    const declaration = header.tables[table];
    ensure(
      object(declaration) &&
        exact(declaration, 'root,count') &&
        declaration.count === basis.counts[table],
    );
    const rows: Record<string, unknown>[] = [],
      ids = new Set<string>();
    function walk(key: unknown, prefix: string): number {
      const node = load(key);
      ensure(
        node.table === table && node.prefix === prefix && prefix.length <= 64,
      );
      if (node.kind === 'leaf') {
        ensure(
          exact(node, 'format,version,scope,kind,table,prefix,rows') &&
            Array.isArray(node.rows) &&
            node.rows.length <= paymentOriginalLeafRows,
        );
        let previous = '';
        for (const ref of node.rows) {
          ensure(
            object(ref) &&
              exact(ref, 'id,digest') &&
              id(ref.id) &&
              ref.id > previous &&
              !ids.has(ref.id) &&
              identity(basis.scope, table, ref.id).startsWith(prefix),
          );
          previous = ref.id;
          ids.add(ref.id);
          ensure(ids.size <= basis.counts[table]);
          const record = load(ref.digest, paymentOriginalMaxNodeBytes);
          ensure(
            exact(record, 'format,version,scope,kind,table,value') &&
              record.kind === 'record' &&
              record.table === table &&
              object(record.value) &&
              record.value.id === ref.id,
          );
          recordBytes += encoder.encode(literalToken(record.value)).length;
          ensure(recordBytes <= basis.snapshotBytes);
          rows.push(record.value);
        }
        return node.rows.length;
      }
      ensure(
        node.kind === 'branch' &&
          exact(
            node,
            'format,version,scope,kind,table,prefix,count,children',
          ) &&
          prefix.length < 64 &&
          integer(
            node.count,
            paymentOriginalLeafRows + 1,
            basis.counts[table],
          ) &&
          Array.isArray(node.children) &&
          node.children.length > 0 &&
          node.children.length <= 16,
      );
      let previous = '',
        count = 0;
      for (const child of node.children) {
        ensure(
          object(child) &&
            exact(child, 'nibble,root') &&
            typeof child.nibble === 'string' &&
            /^[0-9a-f]$/.test(child.nibble) &&
            child.nibble > previous,
        );
        previous = child.nibble;
        const size = walk(child.root, prefix + child.nibble);
        ensure(size > 0);
        count += size;
      }
      ensure(count === node.count);
      return count;
    }
    ensure(walk(declaration.root, '') === declaration.count);
    tables[table] = rows.sort((a, b) =>
      (a.id as string) < (b.id as string)
        ? -1
        : (a.id as string) > (b.id as string)
          ? 1
          : 0,
    );
  }
  ensure(loaded.size === basis.nodeCount && nodeBytes === basis.nodeBytes);
  const snapshot = {
      format: 'mise-backup',
      formatVersion: 1,
      schemaVersion: 13,
      exportedAt: basis.exportedAt,
      tables,
    },
    json = literalToken(snapshot),
    bytes = encoder.encode(json);
  ensure(
    bytes.length === basis.snapshotBytes &&
      hashBytes(bytes) === basis.snapshotHash,
  );
  const backup = parseBackup(json);
  originalScope(backup, basis.scope);
  return backup;
}

export interface PaymentOriginalActionRef {
  readonly root: string;
  readonly paymentId: string;
  readonly revision: number;
  readonly eventId: string;
}
export interface PaymentOriginalAction {
  basis: PaymentOriginalBasis;
  ref: PaymentOriginalActionRef;
  /** Genuine native facts. These do not assert a canonical outcome or grant a write. */
  event: AuditEvent;
  invocation: NativePaymentInvocation | null;
  before: Payment | null;
  after: Payment;
  source: MiseBackup['tables']['inboxItems'][number];
  association: Record<string, unknown> | null;
  financial: {
    posting: PaymentPosting;
    target: Record<string, unknown>;
    receipt: Record<string, unknown>;
    events: AuditEvent[];
    undo: { snapshot: Record<string, unknown>; events: AuditEvent[] } | null;
  } | null;
}
export function parsePaymentOriginalActionRef(
  value: unknown,
): PaymentOriginalActionRef {
  ensure(
    object(value) &&
      exact(value, 'root,paymentId,revision,eventId') &&
      digest(value.root) &&
      id(value.paymentId) &&
      id(value.eventId) &&
      value.eventId !== value.paymentId &&
      integer(value.revision, 1, Number.MAX_SAFE_INTEGER),
  );
  return Object.freeze({
    root: value.root,
    paymentId: value.paymentId,
    revision: value.revision,
    eventId: value.eventId,
  });
}
/** Resolve a specific retained native revision before canonical comparison.
 * In particular, a financial undo retains the original financial recording and
 * its own genuine domain reversal. No user choice absent from the original
 * audit (for example a matching-window preference) is invented here. */
export function paymentOriginalActionReader(
  input: unknown,
  readNode: (digest: string) => string | undefined,
): (requested: unknown) => PaymentOriginalAction {
  const basis = parsePaymentOriginalBasis(input),
    backup = readPaymentOriginalBasis(basis, readNode),
    t = backup.tables,
    reader = validatePaymentFinanceLinks(t.payments, t),
    events = new Map(t.events.map((e) => [e.id, e]));
  // Only this closure holds the strictly validated snapshot. Returned objects
  // are copied so a caller cannot change a later original action lookup.
  return (requested: unknown) => {
    const ref = parsePaymentOriginalActionRef(requested);
    ensure(ref.root === basis.root);
    const payment = t.payments.find((p) => p.id === ref.paymentId),
      event = t.events.find((e) => e.id === ref.eventId);
    ensure(
      payment &&
        event &&
        event.paymentId === payment.id &&
        event.paymentRevision === ref.revision &&
        ref.revision <= payment.revision &&
        event.outletId === basis.scope.outletId,
    );
    const after = event.after as Payment,
      before = event.before as Payment | null;
    ensure(
      after.id === payment.id &&
        after.revision === ref.revision &&
        after.eventId === event.id,
    );
    const source = t.inboxItems.find((i) => i.id === after.inboxId);
    ensure(source);
    const posting =
      event.command === 'payment.record'
        ? after.postings?.find((p) => p.eventId === event.id)
        : event.command === 'payment.record-undo'
          ? after.postings?.find((p) => p.undo?.eventId === event.id)
          : undefined;
    if (
      event.command === 'payment.record' ||
      event.command === 'payment.record-undo'
    )
      ensure(posting);
    const actual = (ids: string[]) =>
      ids.map((id) => {
        const value = events.get(id);
        ensure(value);
        return value;
      });
    const result = structuredClone({
      basis,
      ref,
      event,
      invocation: readNativePaymentInvocation(event, t.events),
      before,
      after,
      source,
      association: after.association
        ? reader.expand(after.association.fingerprint, after.association.at)
        : null,
      financial: posting
        ? {
            posting,
            target: reader.expand(posting.target.fingerprint, posting.at),
            receipt: reader.expand(posting.receipt.fingerprint, posting.at),
            events: actual(posting.receipt.eventIds),
            undo:
              event.command === 'payment.record-undo' && posting.undo
                ? {
                    snapshot: reader.expand(
                      posting.undo.fingerprint,
                      posting.undo.at,
                    ),
                    events: actual(posting.undo.eventIds),
                  }
                : null,
          }
        : null,
    });
    // Preserve the existing frozen identity descriptors while copying all
    // mutable action/source values out of the private checked snapshot.
    result.basis = basis;
    result.ref = ref;
    return result;
  };
}

export function readPaymentOriginalAction(
  input: unknown,
  readNode: (digest: string) => string | undefined,
  requested: unknown,
): PaymentOriginalAction {
  const basis = parsePaymentOriginalBasis(input),
    ref = parsePaymentOriginalActionRef(requested);
  ensure(ref.root === basis.root);
  return paymentOriginalActionReader(basis, readNode)(ref);
}

export interface VerifiedPaymentOriginalDelta {
  readonly basis: PaymentOriginalBasis;
  readonly added: readonly PaymentOriginalNode[];
  /** Independent original source facts, never a current canonical money view. */
  readonly snapshot: MiseBackup;
}
/** Backend retention boundary: verify the entire reachable graph before a
 * caller persists any new node. Reject unreferenced payloads and replacements
 * of existing content addresses; a failed verification changes no pool. Live
 * actor authorization and atomic canonical-outcome checks remain separate. */
export function verifyPaymentOriginalDelta(
  input: unknown,
  existing: (digest: string) => string | undefined,
): VerifiedPaymentOriginalDelta {
  ensure(object(input) && exact(input, 'basis,added'));
  const basis = parsePaymentOriginalBasis(input.basis);
  ensure(Array.isArray(input.added) && input.added.length <= basis.nodeCount);
  const added = new Map<string, string>();
  let bytes = 0;
  for (const value of input.added) {
    ensure(
      object(value) &&
        exact(value, 'digest,json') &&
        digest(value.digest) &&
        typeof value.json === 'string' &&
        value.json.length <= paymentOriginalMaxNodeBytes &&
        !added.has(value.digest),
    );
    const raw = encoder.encode(value.json);
    bytes += raw.length;
    ensure(
      raw.length <= paymentOriginalMaxNodeBytes &&
        bytes <= basis.nodeBytes &&
        hashBytes(raw) === value.digest,
    );
    const previous = existing(value.digest);
    ensure(previous === undefined || previous === value.json);
    added.set(value.digest, value.json);
  }
  const used = new Set<string>();
  const snapshot = readPaymentOriginalBasis(basis, (key) => {
    used.add(key);
    return added.get(key) ?? existing(key);
  });
  for (const key of added.keys()) ensure(used.has(key));
  return Object.freeze({
    basis,
    snapshot,
    added: Object.freeze(
      [...added].map(([digest, json]) => Object.freeze({ digest, json })),
    ),
  });
}
