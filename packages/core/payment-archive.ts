import { parseBackup } from './backup';
import { MAX_BACKUP_BYTES, type MiseBackup } from './backup-tables';
import {
  parsePaymentOriginalBasis,
  readPaymentOriginalBasis,
  type PaymentOriginalBasis,
  type PaymentOriginalNode,
  paymentOriginalMaxNodeBytes,
} from './payment-originals';
import {
  sharedJsonHash,
  sharedJsonWriter,
  sharedJsonReader,
  sharedJsonMaxNodes,
  type SharedJsonNode,
} from './shared-json';
export const localPaymentArchiveTableNames = [
  'paymentOriginalBases',
  'paymentOriginalNodes',
  'paymentOriginalValues',
] as const;
export const paymentArchiveMaxExpandedBytes = MAX_BACKUP_BYTES * 4;
export interface StoredPaymentOriginalBasis {
  id: string;
  basis: PaymentOriginalBasis;
}
export interface StoredPaymentOriginalNode {
  digest: string;
  value: string;
}
export interface SharedPaymentBackup {
  format: 'mise-backup';
  formatVersion: 2;
  schemaVersion: 13;
  exportedAt: number;
  encoding: 'mise-shared-json-v1';
  current: string;
  bases: PaymentOriginalBasis[];
  originals: StoredPaymentOriginalNode[];
  values: SharedJsonNode[];
}
export type PortableBackup = MiseBackup | SharedPaymentBackup;
export interface DecodedPortableBackup {
  current: MiseBackup;
  bases: PaymentOriginalBasis[];
  nodes: PaymentOriginalNode[];
}
const hex = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the complete payment originals and current shop in the supported backup.',
    );
}
function bounded(input: unknown): unknown {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  ensure(
    typeof json === 'string' &&
      json.length <= MAX_BACKUP_BYTES &&
      new TextEncoder().encode(json).length <= MAX_BACKUP_BYTES,
  );
  try {
    return JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw Error('Choose a complete Mise JSON backup.');
  }
}
export function verifyPaymentArchive(
  current: MiseBackup,
  bases: readonly PaymentOriginalBasis[],
  nodes: ReadonlyMap<string, string>,
): void {
  ensure(bases.length <= 512);
  const roots = new Set<string>(),
    used = new Set<string>();
  let total = 0;
  ensure(
    !bases.length ||
      (current.tables.businesses.length === 1 &&
        current.tables.outlets.length === 1),
  );
  for (const raw of bases) {
    const b = parsePaymentOriginalBasis(raw);
    ensure(!roots.has(b.root));
    roots.add(b.root);
    ensure(
      b.scope.businessId === current.tables.businesses[0].id &&
        b.scope.outletId === current.tables.outlets[0].id,
    );
    total += b.snapshotBytes;
    ensure(total <= paymentArchiveMaxExpandedBytes);
    readPaymentOriginalBasis(b, (key) => {
      used.add(key);
      return nodes.get(key);
    });
  }
  ensure(used.size === nodes.size);
}
/** Legacy files keep their exact schema-13 shape. Originals use an explicit
 * outer format v2; every original is still a frozen strict schema-13 snapshot. */
export function createPortableBackup(
  current: MiseBackup,
  bases: readonly PaymentOriginalBasis[] = [],
  originals: readonly PaymentOriginalNode[] = [],
): PortableBackup {
  const copy = parseBackup(JSON.stringify(current)),
    raw = new Map<string, string>();
  for (const n of originals) {
    ensure(
      hex.test(n.digest) &&
        !raw.has(n.digest) &&
        sharedJsonHash(n.json) === n.digest,
    );
    raw.set(n.digest, n.json);
  }
  verifyPaymentArchive(copy, bases, raw);
  if (!bases.length) return copy;
  const writer = sharedJsonWriter(),
    root = writer.write(copy),
    index = originals
      .map((n) => ({ digest: n.digest, value: writer.write(n.json) }))
      .sort((a, b) => a.digest.localeCompare(b.digest));
  const result: SharedPaymentBackup = {
    format: 'mise-backup',
    formatVersion: 2,
    schemaVersion: 13,
    exportedAt: copy.exportedAt,
    encoding: 'mise-shared-json-v1',
    current: root,
    bases: [...bases].sort((a, b) => a.root.localeCompare(b.root)),
    originals: index,
    values: [...writer.nodes]
      .map(([digest, json]) => ({ digest, json }))
      .sort((a, b) => a.digest.localeCompare(b.digest)),
  };
  bounded(result);
  return result;
}
export function parsePortableBackup(input: unknown): DecodedPortableBackup {
  const value = bounded(input);
  ensure(object(value));
  if (value.formatVersion !== 2)
    return { current: parseBackup(value), bases: [], nodes: [] };
  ensure(
    exact(
      value,
      'format,formatVersion,schemaVersion,exportedAt,encoding,current,bases,originals,values',
    ) &&
      value.format === 'mise-backup' &&
      value.schemaVersion === 13 &&
      value.encoding === 'mise-shared-json-v1' &&
      typeof value.current === 'string' &&
      Array.isArray(value.bases) &&
      value.bases.length > 0 &&
      value.bases.length <= 512 &&
      Array.isArray(value.originals) &&
      value.originals.length <= sharedJsonMaxNodes &&
      Array.isArray(value.values) &&
      value.values.length <= sharedJsonMaxNodes,
  );
  const values = new Map<string, string>();
  for (const n of value.values) {
    ensure(
      object(n) &&
        exact(n, 'digest,json') &&
        typeof n.digest === 'string' &&
        hex.test(n.digest) &&
        typeof n.json === 'string' &&
        !values.has(n.digest),
    );
    values.set(n.digest, n.json);
  }
  const reader = sharedJsonReader(values),
    current = parseBackup(reader.read(value.current));
  ensure(current.exportedAt === value.exportedAt);
  const bases = value.bases.map(parsePaymentOriginalBasis),
    nodes: PaymentOriginalNode[] = [],
    seen = new Set<string>();
  for (const n of value.originals) {
    ensure(
      object(n) &&
        exact(n, 'digest,value') &&
        typeof n.digest === 'string' &&
        hex.test(n.digest) &&
        typeof n.value === 'string' &&
        !seen.has(n.digest),
    );
    seen.add(n.digest);
    const json = reader.read(n.value, paymentOriginalMaxNodeBytes * 2 + 2);
    ensure(typeof json === 'string' && sharedJsonHash(json) === n.digest);
    nodes.push({ digest: n.digest, json });
  }
  reader.assertComplete();
  verifyPaymentArchive(
    current,
    bases,
    new Map(nodes.map((n) => [n.digest, n.json])),
  );
  return { current, bases, nodes };
}
export function paymentArchiveToken(
  bases: readonly PaymentOriginalBasis[],
): string {
  return sharedJsonHash(
    JSON.stringify([...bases].sort((a, b) => a.root.localeCompare(b.root))),
  );
}
