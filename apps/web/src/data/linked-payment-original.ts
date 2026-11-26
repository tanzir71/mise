import {
  inspectOriginalCopy,
  parseOriginalCopyManifest,
  originalCopyBytes,
  originalCopyNodeRefs,
  originalCopyPartBytes,
} from '@mise/core/original-copy';
import {
  parseNativePaymentOriginalLink,
  type NativePaymentOriginalLink,
} from '@mise/core/native-payment-originals';
import { sharedJsonHash } from '@mise/core/shared-json';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
function ensure(v: unknown): asserts v {
  if (!v)
    throw Error(
      'Keep the complete linked original and retry the same payment source.',
    );
}
/** Read-only, bounded traversal. Origin actor and actual reader remain distinct.
 * A completed graph is source evidence, never a canonical install or permission. */
export async function downloadLinkedPaymentOriginal(
  input: NativePaymentOriginalLink,
  call: (op: string, body: Record<string, unknown>) => Promise<unknown>,
  current: () => void,
) {
  const link = parseNativePaymentOriginalLink(input),
    copy = link.retention.copy,
    manifest = parseOriginalCopyManifest({
      format: copy.format,
      version: copy.version,
      id: copy.id,
      businessId: copy.businessId,
      outletId: copy.outletId,
      actorId: copy.actorId,
      root: copy.root,
      nodeCount: copy.nodeCount,
      nodeBytes: copy.nodeBytes,
    }),
    nodes = new Map<string, string>(),
    pending = [manifest.root],
    discovered = new Set(pending),
    encoder = new TextEncoder();
  let bytes = 0;
  const invoke = async (op: string, body: Record<string, unknown>) => {
    current();
    const v = await call(op, body);
    current();
    return v;
  };
  const keep = (key: string, json: string) => {
    ensure(!nodes.has(key) && sharedJsonHash(json) === key);
    bytes += encoder.encode(json).length;
    ensure(nodes.size + 1 <= manifest.nodeCount && bytes <= manifest.nodeBytes);
    nodes.set(key, json);
    for (const ref of originalCopyNodeRefs(json))
      if (!discovered.has(ref)) {
        discovered.add(ref);
        ensure(discovered.size <= manifest.nodeCount);
        pending.push(ref);
      }
  };
  while (pending.length) {
    const keys = [
      ...new Set(pending.splice(Math.max(0, pending.length - 128), 128)),
    ].filter((k) => !nodes.has(k));
    if (!keys.length) continue;
    const result = await invoke('payment-read', { digests: keys });
    ensure(
      object(result) &&
        Object.keys(result).sort().join(',') === 'large,nodes' &&
        Array.isArray(result.nodes) &&
        Array.isArray(result.large),
    );
    const seen = new Set<string>();
    for (const n of result.nodes) {
      ensure(
        object(n) &&
          Object.keys(n).sort().join(',') === 'digest,json' &&
          typeof n.digest === 'string' &&
          keys.includes(n.digest) &&
          !seen.has(n.digest) &&
          typeof n.json === 'string',
      );
      seen.add(n.digest);
      keep(n.digest, n.json);
    }
    for (const n of result.large) {
      ensure(
        object(n) &&
          Object.keys(n).sort().join(',') === 'bytes,digest' &&
          typeof n.digest === 'string' &&
          keys.includes(n.digest) &&
          !seen.has(n.digest) &&
          Number.isSafeInteger(n.bytes) &&
          (n.bytes as number) > 0 &&
          (n.bytes as number) <= manifest.nodeBytes - bytes,
      );
      seen.add(n.digest);
      const raw = new Uint8Array(n.bytes as number);
      for (
        let index = 0, at = 0;
        at < raw.length;
        index++, at += originalCopyPartBytes
      ) {
        const v = await invoke('payment-read-part', {
          digest: n.digest,
          index,
        });
        ensure(
          object(v) &&
            Object.keys(v).sort().join(',') === 'bytes,data,digest,index' &&
            v.digest === n.digest &&
            v.bytes === raw.length &&
            v.index === index &&
            typeof v.data === 'string',
        );
        const part = originalCopyBytes(v.data);
        ensure(
          part.length === Math.min(originalCopyPartBytes, raw.length - at),
        );
        raw.set(part, at);
      }
      keep(n.digest, new TextDecoder('utf-8', { fatal: true }).decode(raw));
    }
    ensure(seen.size > 0);
    pending.unshift(...keys.filter((k) => !seen.has(k)));
  }
  current();
  const original = inspectOriginalCopy(manifest, (key) => nodes.get(key));
  current();
  return { link, ...original };
}
