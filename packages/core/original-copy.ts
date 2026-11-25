import { MAX_BACKUP_BYTES } from './backup-tables';
import {
  parsePortableBackup,
  type SharedPaymentBackup,
  type PortableBackup,
  type DecodedPortableBackup,
} from './payment-archive';
import { literalToken } from './literal-token';
import {
  sharedJsonHash,
  sharedJsonWriter,
  sharedJsonReader,
  sharedJsonMaxNodes,
  type SharedJsonNode,
} from './shared-json';
export const originalCopyPartBytes = 144 * 1024;
export const originalCopyBatchBytes = 192 * 1024;
export interface OriginalCopyScope {
  businessId: string;
  outletId: string;
  actorId: string;
}
export interface OriginalCopyManifest extends OriginalCopyScope {
  format: 'mise-original-copy';
  version: 1;
  id: string;
  root: string;
  nodeCount: number;
  nodeBytes: number;
}
export interface OriginalCopyPlan {
  manifest: OriginalCopyManifest;
  nodes: SharedJsonNode[];
}
export interface OriginalCopyReceipt extends OriginalCopyManifest {
  acceptedAt: number;
  manifestHash: string;
  verification: 'content-addressed-copy';
}
const hex = /^[a-f0-9]{64}$/,
  id = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const encoder = new TextEncoder();
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, s: string) =>
  Object.keys(v).sort().join(',') === s.split(',').sort().join(',');
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the complete original copy and use the same account and shop.',
    );
}
export const originalCopyHash = (v: unknown) => sharedJsonHash(literalToken(v));
export function parseOriginalCopyManifest(v: unknown): OriginalCopyManifest {
  ensure(
    object(v) &&
      exact(
        v,
        'format,version,id,businessId,outletId,actorId,root,nodeCount,nodeBytes',
      ) &&
      v.format === 'mise-original-copy' &&
      v.version === 1,
  );
  for (const k of ['id', 'businessId', 'outletId', 'actorId'])
    ensure(typeof v[k] === 'string' && id.test(v[k] as string));
  ensure(
    typeof v.root === 'string' &&
      hex.test(v.root) &&
      Number.isSafeInteger(v.nodeCount) &&
      (v.nodeCount as number) > 0 &&
      (v.nodeCount as number) <= sharedJsonMaxNodes &&
      Number.isSafeInteger(v.nodeBytes) &&
      (v.nodeBytes as number) > 0 &&
      (v.nodeBytes as number) <= MAX_BACKUP_BYTES,
  );
  return structuredClone(v) as unknown as OriginalCopyManifest;
}
export function parseOriginalCopyReceipt(
  v: unknown,
  m: OriginalCopyManifest,
): OriginalCopyReceipt {
  m = parseOriginalCopyManifest(m);
  ensure(
    object(v) &&
      exact(
        v,
        'format,version,id,businessId,outletId,actorId,root,nodeCount,nodeBytes,acceptedAt,manifestHash,verification',
      ),
  );
  const { acceptedAt, manifestHash, verification, ...manifest } = v;
  ensure(
    literalToken(manifest) === literalToken(m) &&
      Number.isSafeInteger(acceptedAt) &&
      (acceptedAt as number) >= 0 &&
      (acceptedAt as number) <= 253402300799999 &&
      manifestHash === originalCopyHash(m) &&
      verification === 'content-addressed-copy',
  );
  return structuredClone(v) as unknown as OriginalCopyReceipt;
}
/** Strict original validation occurs before a copy is prepared and after readback.
 * A storage receipt never becomes authority for financial or member changes. */
export function prepareOriginalCopy(
  input: PortableBackup,
  scope: OriginalCopyScope,
  copyId: string,
): OriginalCopyPlan {
  scope = {
    businessId: scope.businessId,
    outletId: scope.outletId,
    actorId: scope.actorId,
  };
  const decoded = parsePortableBackup(input);
  ensure(input.formatVersion === 2 && decoded.bases.length > 0);
  const portable = input as SharedPaymentBackup;
  ensure(
    decoded.current.tables.businesses[0]?.id === scope.businessId &&
      decoded.current.tables.outlets[0]?.id === scope.outletId,
  );
  const writer = sharedJsonWriter(
      new Map(portable.values.map((n) => [n.digest, n.json])),
    ),
    header = writer.write({
      format: 'mise-original-copy-header',
      version: 1,
      scope,
      exportedAt: portable.exportedAt,
      bases: portable.bases,
      originals: portable.originals,
    });
  // These are actual graph edges, rather than user strings interpreted as references.
  const json = literalToken([
      'a',
      [header, portable.current, ...portable.originals.map((n) => n.value)],
    ]),
    root = sharedJsonHash(json);
  writer.nodes.set(root, json);
  const nodes = [...writer.nodes]
      .map(([digest, json]) => ({ digest, json }))
      .sort((a, b) => a.digest.localeCompare(b.digest)),
    nodeBytes = nodes.reduce((n, v) => n + encoder.encode(v.json).length, 0);
  const manifest = parseOriginalCopyManifest({
    format: 'mise-original-copy',
    version: 1,
    id: copyId,
    ...scope,
    root,
    nodeCount: nodes.length,
    nodeBytes,
  });
  return { manifest, nodes };
}
/** Bounded structural references, without constructing a potentially expanded value. */
export function originalCopyNodeRefs(json: string): string[] {
  ensure(
    typeof json === 'string' && encoder.encode(json).length <= MAX_BACKUP_BYTES,
  );
  const n: unknown = JSON.parse(json);
  ensure(Array.isArray(n) && literalToken(n) === json);
  let refs: unknown[] = [];
  if (n[0] === 'z') ensure(n.length === 1);
  else if (['s', 'b', 'n'].includes(n[0]))
    ensure(
      n.length === 2 &&
        (n[0] === 's'
          ? typeof n[1] === 'string'
          : n[0] === 'b'
            ? typeof n[1] === 'boolean'
            : typeof n[1] === 'number' && Number.isFinite(n[1])),
    );
  else if (n[0] === 'j') {
    ensure(n.length === 2);
    refs = [n[1]];
  } else {
    ensure(n.length === 2 && Array.isArray(n[1]) && ['a', 'o'].includes(n[0]));
    let prior: string | undefined;
    for (const v of n[1])
      if (n[0] === 'a') refs.push(v);
      else {
        ensure(
          Array.isArray(v) &&
            v.length === 2 &&
            typeof v[0] === 'string' &&
            (prior === undefined || prior < v[0]),
        );
        prior = v[0];
        refs.push(v[1]);
      }
  }
  ensure(refs.every((r) => typeof r === 'string' && hex.test(r)));
  return refs as string[];
}
export function inspectOriginalCopy(
  plan: OriginalCopyManifest,
  read: (digest: string) => string | undefined,
): { portable: SharedPaymentBackup; decoded: DecodedPortableBackup } {
  const m = parseOriginalCopyManifest(plan),
    nodes = new Map<string, string>(),
    pending = [m.root];
  let bytes = 0;
  while (pending.length) {
    const digest = pending.pop()!;
    if (nodes.has(digest)) continue;
    const json = read(digest);
    ensure(typeof json === 'string' && sharedJsonHash(json) === digest);
    nodes.set(digest, json);
    bytes += encoder.encode(json).length;
    ensure(nodes.size <= m.nodeCount && bytes <= m.nodeBytes);
    for (const ref of originalCopyNodeRefs(json)) pending.push(ref);
  }
  ensure(nodes.size === m.nodeCount && bytes === m.nodeBytes);
  const root = JSON.parse(nodes.get(m.root)!);
  ensure(root[0] === 'a' && root[1].length >= 3);
  const reader = sharedJsonReader(nodes),
    header = reader.read(root[1][0]);
  ensure(
    object(header) &&
      exact(header, 'format,version,scope,exportedAt,bases,originals') &&
      header.format === 'mise-original-copy-header' &&
      header.version === 1 &&
      literalToken(header.scope) ===
        literalToken({
          businessId: m.businessId,
          outletId: m.outletId,
          actorId: m.actorId,
        }) &&
      Array.isArray(header.originals),
  );
  const originalRefs = header.originals.map((v) => {
    ensure(object(v) && typeof v.value === 'string');
    return v.value;
  });
  ensure(literalToken(root[1].slice(2)) === literalToken(originalRefs));
  const used = new Map<string, string>(),
    queue = [root[1][1], ...originalRefs];
  while (queue.length) {
    const key = queue.pop()!;
    if (used.has(key)) continue;
    const json = nodes.get(key);
    ensure(json !== undefined);
    used.set(key, json);
    for (const ref of originalCopyNodeRefs(json)) queue.push(ref);
  }
  const portable = {
    format: 'mise-backup',
    formatVersion: 2,
    schemaVersion: 13,
    encoding: 'mise-shared-json-v1',
    exportedAt: header.exportedAt,
    current: root[1][1],
    bases: header.bases,
    originals: header.originals,
    values: [...used].map(([digest, json]) => ({ digest, json })),
  };
  const decoded = parsePortableBackup(portable);
  ensure(
    decoded.current.tables.businesses[0]?.id === m.businessId &&
      decoded.current.tables.outlets[0]?.id === m.outletId,
  );
  return { portable: portable as SharedPaymentBackup, decoded };
}
export function readOriginalCopy(
  plan: OriginalCopyManifest,
  read: (digest: string) => string | undefined,
): DecodedPortableBackup {
  return inspectOriginalCopy(plan, read).decoded;
}
export function originalCopyBatches(
  nodes: readonly SharedJsonNode[],
): SharedJsonNode[][] {
  const batches: SharedJsonNode[][] = [];
  let batch: SharedJsonNode[] = [],
    bytes = 2;
  for (const n of nodes) {
    const size = encoder.encode(JSON.stringify(n)).length + 1;
    if (size > originalCopyBatchBytes) {
      if (batch.length) batches.push(batch);
      batch = [];
      bytes = 2;
      batches.push([n]);
      continue;
    }
    if (batch.length >= 512 || bytes + size > originalCopyBatchBytes) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(n);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function originalCopyBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 16384)
    s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s);
}
export function originalCopyBytes(base64: string): Uint8Array {
  ensure(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    ),
  );
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
