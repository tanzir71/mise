import { prepareNativeCanonicalCopy } from './native-canonical-copy';
import { parseBackup } from './backup';
import { MAX_BACKUP_BYTES, type MiseBackup } from './backup-tables';
import { literalToken } from './literal-token';
import { isNativeSyncTable } from './native-sync-records';
import type { CanonicalRecord } from './sync-canonical';
import {
  projectNativePaymentCanonical,
  type NativePaymentOriginalLoader,
} from './native-payment-canonical';
import {
  createPortableBackup,
  verifyPaymentArchive,
  paymentArchiveMaxExpandedBytes,
  type PortableBackup,
} from './payment-archive';
import type {
  PaymentOriginalBasis,
  PaymentOriginalNode,
} from './payment-originals';
import {
  inspectOriginalCopy,
  parseOriginalCopyManifest,
  originalCopyNodeRefs,
  type OriginalCopyManifest,
} from './original-copy';
import {
  sharedJsonHash,
  sharedJsonWriter,
  sharedJsonReader,
  sharedJsonMaxNodes,
  type SharedJsonNode,
} from './shared-json';

/** Complete source and independently current money. No account, cursor, live
 * authorization, delivery envelope or instruction to send is restored. */
export interface NativePaymentBackup {
  format: 'mise-backup';
  formatVersion: 3;
  schemaVersion: 13;
  encoding: 'mise-native-shared-json-v1';
  exportedAt: number;
  root: string;
  values: SharedJsonNode[];
}
export interface NativePaymentLegacyArchive {
  bases: PaymentOriginalBasis[];
  nodes: PaymentOriginalNode[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const hex = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
function ensure(v: unknown): asserts v {
  if (!v)
    throw Error(
      'Keep the complete native payment originals and current shop backup.',
    );
}
function bounded(input: unknown): NativePaymentBackup {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  ensure(
    typeof text === 'string' &&
      text.length <= MAX_BACKUP_BYTES &&
      encoder.encode(text).length <= MAX_BACKUP_BYTES,
  );
  const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  ensure(
    object(v) &&
      exact(
        v,
        'format,formatVersion,schemaVersion,encoding,exportedAt,root,values',
      ) &&
      v.format === 'mise-backup' &&
      v.formatVersion === 3 &&
      v.schemaVersion === 13 &&
      v.encoding === 'mise-native-shared-json-v1' &&
      typeof v.root === 'string' &&
      hex.test(v.root) &&
      Number.isSafeInteger(v.exportedAt) &&
      (v.exportedAt as number) >= 0 &&
      Array.isArray(v.values) &&
      v.values.length <= sharedJsonMaxNodes,
  );
  return v as unknown as NativePaymentBackup;
}
function addNodes(
  pool: Map<string, string>,
  values: readonly SharedJsonNode[],
) {
  for (const n of values) {
    ensure(
      object(n) &&
        exact(n, 'digest,json') &&
        typeof n.digest === 'string' &&
        hex.test(n.digest) &&
        typeof n.json === 'string' &&
        sharedJsonHash(n.json) === n.digest,
    );
    const old = pool.get(n.digest);
    ensure(old === undefined || old === n.json);
    pool.set(n.digest, n.json);
  }
  ensure(pool.size <= sharedJsonMaxNodes);
}
function scope(current: MiseBackup) {
  ensure(
    current.tables.businesses.length === 1 &&
      current.tables.outlets.length === 1 &&
      !current.tables.payments.length,
  );
  return {
    businessId: current.tables.businesses[0].id,
    outletId: current.tables.outlets[0].id,
  };
}
/** A shared graph uses genuine copy roots as structural edges. Complete copy
 * bodies are retained once, without nesting another encoded value pool. */
export async function createNativePaymentBackup(
  currentInput: MiseBackup,
  incoming: readonly CanonicalRecord[],
  loadOriginal: NativePaymentOriginalLoader,
  legacy: NativePaymentLegacyArchive = { bases: [], nodes: [] },
): Promise<NativePaymentBackup> {
  const current = parseBackup(JSON.stringify(currentInput)),
    target = scope(current),
    records = structuredClone(
      incoming.filter((r) => isNativeSyncTable(r.table)),
    ),
    pool = new Map<string, string>(),
    copies = new Map<string, OriginalCopyManifest>(),
    portableCopies = new Map<string, PortableBackup>();
  ensure(records.length > 0);
  const projection = await projectNativePaymentCanonical(
    records,
    current,
    target,
    async (link) => {
      const input = await loadOriginal(link),
        checked = prepareNativeCanonicalCopy(
          input.portable,
          {
            businessId: link.businessId,
            outletId: link.outletId,
            actorId: link.actorId,
          },
          link.retention.copy.id,
        ),
        loaded = {
          link: structuredClone(input.link),
          portable: checked.portable,
        },
        plan = checked.plan;
      const old = copies.get(plan.manifest.id);
      ensure(!old || literalToken(old) === literalToken(plan.manifest));
      copies.set(plan.manifest.id, plan.manifest);
      portableCopies.set(plan.manifest.id, loaded.portable);
      addNodes(pool, plan.nodes);
      return loaded;
    },
  );
  const archive = createPortableBackup(current, legacy.bases, legacy.nodes),
    originals = archive.formatVersion === 2 ? archive.originals : [],
    bases = archive.formatVersion === 2 ? archive.bases : [];
  if (archive.formatVersion === 2) addNodes(pool, archive.values);
  const writer = sharedJsonWriter(pool),
    manifests = [...copies.values()].sort((a, b) => a.id.localeCompare(b.id)),
    header = writer.write({
      format: 'mise-native-payment-backup-header',
      version: 1,
      records: records.sort(
        (a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id),
      ),
      copies: manifests,
      bases,
      originals,
    }),
    currentRoot = writer.write(current),
    json = literalToken([
      'a',
      [
        header,
        currentRoot,
        ...manifests.map((c) => c.root),
        ...originals.map((n) => n.value),
      ],
    ]),
    root = sharedJsonHash(json);
  writer.nodes.set(root, json);
  // A prior current image can contain values no longer used by the replacement.
  // Keep every source graph, while excluding only unreachable encoding nodes.
  const used = new Map<string, string>(),
    pending = [root];
  let bytes = 0;
  while (pending.length) {
    const key = pending.pop()!;
    if (used.has(key)) continue;
    const node = writer.nodes.get(key);
    ensure(node !== undefined);
    bytes += encoder.encode(node).length;
    ensure(bytes <= paymentArchiveMaxExpandedBytes);
    used.set(key, node);
    pending.push(...originalCopyNodeRefs(node));
  }
  const wire = bounded({
    format: 'mise-backup',
    formatVersion: 3,
    schemaVersion: 13,
    encoding: 'mise-native-shared-json-v1',
    exportedAt: current.exportedAt,
    root,
    values: [...used]
      .map(([digest, json]) => ({ digest, json }))
      .sort((a, b) => a.digest.localeCompare(b.digest)),
  });
  // The strict projection, original-copy preparation, legacy validator and
  // structural encoder have checked this exact private graph already. Reuse
  // that complete result only while all serialized bytes remain identical.
  const value: DecodedNativePaymentBackup = {
    wire,
    current,
    records,
    projection,
    bases: structuredClone(bases),
    nodes: structuredClone(legacy.nodes),
    loadOriginal: async (link) => {
      const portable = portableCopies.get(link.retention.copy.id);
      ensure(portable);
      return { link: structuredClone(link), portable };
    },
  };
  lastDecoded = { token: sharedJsonHash(JSON.stringify(wire)), value };
  return structuredClone(wire);
}

/** Revalidate every source and original financial child. A serialized file is
 * never a fresh SDK session, accepted cursor, pending send or write capability. */
async function decodeNativePaymentBackup(wire: NativePaymentBackup) {
  const pool = new Map<string, string>();
  for (const n of wire.values) {
    ensure(!pool.has(n.digest));
    addNodes(pool, [n]);
  }
  ensure(
    [...pool.values()].reduce((n, s) => n + encoder.encode(s).length, 0) <=
      paymentArchiveMaxExpandedBytes,
  );
  const rootJson = pool.get(wire.root);
  ensure(rootJson !== undefined);
  originalCopyNodeRefs(rootJson);
  const root: unknown = JSON.parse(rootJson);
  ensure(
    Array.isArray(root) &&
      root[0] === 'a' &&
      root.length === 2 &&
      Array.isArray(root[1]) &&
      root[1].length >= 3,
  );
  const reader = sharedJsonReader(pool),
    header = reader.read(root[1][0], paymentArchiveMaxExpandedBytes + 4096);
  ensure(
    object(header) &&
      exact(header, 'format,version,records,copies,bases,originals') &&
      header.format === 'mise-native-payment-backup-header' &&
      header.version === 1 &&
      Array.isArray(header.records) &&
      header.records.length > 0 &&
      Array.isArray(header.copies) &&
      Array.isArray(header.bases) &&
      Array.isArray(header.originals),
  );
  const current = parseBackup(reader.read(root[1][1]));
  ensure(current.exportedAt === wire.exportedAt);
  const target = scope(current),
    manifests = header.copies.map(parseOriginalCopyManifest),
    copies = new Map<
      string,
      ReturnType<typeof inspectOriginalCopy>['portable']
    >(),
    used = new Set([wire.root]);
  ensure(new Set(manifests.map((m) => m.id)).size === manifests.length);
  for (const m of manifests) {
    ensure(
      m.businessId === target.businessId && m.outletId === target.outletId,
    );
    copies.set(
      m.id,
      inspectOriginalCopy(m, (key) => {
        used.add(key);
        return pool.get(key);
      }).portable,
    );
  }
  const originals = header.originals.map((n) => {
    ensure(
      object(n) &&
        exact(n, 'digest,value') &&
        typeof n.digest === 'string' &&
        hex.test(n.digest) &&
        typeof n.value === 'string',
    );
    const json = reader.read(n.value, MAX_BACKUP_BYTES * 2 + 4098);
    ensure(typeof json === 'string' && sharedJsonHash(json) === n.digest);
    return { digest: n.digest, json, value: n.value };
  });
  ensure(
    literalToken(root[1].slice(2)) ===
      literalToken([
        ...manifests.map((m) => m.root),
        ...originals.map((n) => n.value),
      ]),
  );
  const legacyBases = header.bases as PaymentOriginalBasis[],
    legacyNodes = originals.map(({ digest, json }) => ({ digest, json }));
  ensure(new Set(legacyNodes.map((n) => n.digest)).size === legacyNodes.length);
  verifyPaymentArchive(
    current,
    legacyBases,
    new Map(legacyNodes.map((n) => [n.digest, n.json])),
  );
  for (const n of reader.used) used.add(n);
  ensure(used.size === pool.size);
  const records = header.records.map((r) => {
    ensure(
      object(r) &&
        exact(r, 'table,id,changeId,operation,row,rowHash') &&
        typeof r.table === 'string' &&
        isNativeSyncTable(r.table) &&
        typeof r.id === 'string' &&
        typeof r.changeId === 'string' &&
        typeof r.rowHash === 'string' &&
        (r.operation === 'upsert' || r.operation === 'delete') &&
        (r.row === null || object(r.row)),
    );
    return r as unknown as CanonicalRecord;
  });
  const usedCopies = new Set<string>();
  const loadOriginal: NativePaymentOriginalLoader = async (link) => {
    const copy = copies.get(link.retention.copy.id);
    ensure(copy);
    usedCopies.add(link.retention.copy.id);
    return { link: structuredClone(link), portable: copy };
  };
  const projection = await projectNativePaymentCanonical(
    records,
    current,
    target,
    loadOriginal,
    { freshOriginals: true },
  );
  ensure(usedCopies.size === manifests.length);
  return {
    wire,
    current,
    records,
    projection,
    bases: legacyBases,
    nodes: legacyNodes,
    loadOriginal,
  };
}

type DecodedNativePaymentBackup = Awaited<
  ReturnType<typeof decodeNativePaymentBackup>
>;
let lastDecoded:
  { token: string; value: DecodedNativePaymentBackup } | undefined;
/** Validate identical complete bytes once, without sharing mutable decoded data.
 * One bounded entry retains no SDK identity, cursor or write permission. */
export async function parseNativePaymentBackup(
  input: unknown,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<DecodedNativePaymentBackup> {
  const wire = bounded(input),
    token = sharedJsonHash(JSON.stringify(wire));
  if (fresh || lastDecoded?.token !== token) {
    const value = await decodeNativePaymentBackup(wire);
    lastDecoded = { token, value };
  }
  return copyNativePaymentBackup(lastDecoded.value);
}
/** Copies are lazy so checking a root or identity need not duplicate all source
 * bytes. Each returned view owns its copies; the validated cache stays private. */
export function copyNativePaymentBackup(
  d: DecodedNativePaymentBackup,
): DecodedNativePaymentBackup {
  let current: DecodedNativePaymentBackup['current'] | undefined,
    records: DecodedNativePaymentBackup['records'] | undefined,
    projection: DecodedNativePaymentBackup['projection'] | undefined,
    bases: DecodedNativePaymentBackup['bases'] | undefined,
    nodes: DecodedNativePaymentBackup['nodes'] | undefined,
    values: NativePaymentBackup['values'] | undefined;
  const wire: NativePaymentBackup = {
    format: d.wire.format,
    formatVersion: d.wire.formatVersion,
    schemaVersion: d.wire.schemaVersion,
    encoding: d.wire.encoding,
    exportedAt: d.wire.exportedAt,
    root: d.wire.root,
    get values() {
      return (values ??= structuredClone(d.wire.values));
    },
  };
  return {
    wire,
    get current() {
      return (current ??= structuredClone(d.current));
    },
    get records() {
      return (records ??= structuredClone(d.records));
    },
    get projection() {
      return (projection ??= structuredClone(d.projection));
    },
    get bases() {
      return (bases ??= structuredClone(d.bases));
    },
    get nodes() {
      return (nodes ??= structuredClone(d.nodes));
    },
    loadOriginal: async (link) =>
      structuredClone(await d.loadOriginal(structuredClone(link))),
  };
}

export const localNativePaymentStateTableNames = [
  'nativePaymentState',
  'nativePaymentValues',
] as const;
export interface StoredNativePaymentState {
  id: 'active';
  version: 1;
  mode: 'canonical' | 'restored';
  baseHash: string | null;
  root: string;
  exportedAt: number;
  hash: string;
}
