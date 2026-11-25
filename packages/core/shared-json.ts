import { sha256 } from '@noble/hashes/sha2';
import { MAX_BACKUP_BYTES } from './backup-tables';
import { literalToken } from './literal-token';
export interface SharedJsonNode {
  digest: string;
  json: string;
}
export const sharedJsonMaxNodes = Math.floor(MAX_BACKUP_BYTES / 64);
const encoder = new TextEncoder(),
  hex = /^[a-f0-9]{64}$/;
export function sharedJsonHash(text: string): string {
  return Array.from(sha256(encoder.encode(text)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
function ensure(ok: unknown): asserts ok {
  if (!ok) throw Error('Keep the complete bounded shared JSON graph.');
}
function shape(value: unknown, depth = 0): boolean {
  if (depth > 48) return false;
  if (Array.isArray(value)) return value.every((v) => shape(v, depth + 1));
  return (
    !plain(value) || Object.values(value).every((v) => shape(v, depth + 1))
  );
}
/** Types are tagged outside user data. A compacted literal stays a string on read. */
export function sharedJsonWriter(
  available: ReadonlyMap<string, string> = new Map(),
) {
  const nodes = new Map(available),
    added: SharedJsonNode[] = [],
    strings = new Map<string, string>();
  function intern(node: unknown): string {
    const json = literalToken(node),
      digest = sharedJsonHash(json),
      old = nodes.get(digest);
    ensure(old === undefined || old === json);
    if (old === undefined) {
      ensure(nodes.size < sharedJsonMaxNodes);
      nodes.set(digest, json);
      added.push({ digest, json });
    }
    return digest;
  }
  function write(value: unknown, depth = 0): string {
    ensure(depth <= 96);
    if (value === null) return intern(['z']);
    if (typeof value === 'boolean') return intern(['b', value]);
    if (typeof value === 'number') {
      ensure(Number.isFinite(value));
      return intern(['n', value]);
    }
    if (typeof value === 'string') {
      const old = strings.get(value);
      if (old) return old;
      let ref: string | undefined;
      if (
        value.length >= 1024 &&
        depth < 40 &&
        (value[0] === '{' || value[0] === '[')
      ) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          /* Opaque user text remains complete. */
        }
        if (
          parsed !== undefined &&
          shape(parsed) &&
          literalToken(parsed) === value
        )
          ref = intern(['j', write(parsed, depth + 1)]);
      }
      ref ??= intern(['s', value]);
      strings.set(value, ref);
      return ref;
    }
    if (Array.isArray(value))
      return intern(['a', value.map((v) => write(v, depth + 1))]);
    ensure(plain(value));
    return intern([
      'o',
      Object.keys(value)
        .sort()
        .map((k) => [k, write(value[k], depth + 1)]),
    ]);
  }
  return { write, nodes, added };
}
interface Stats {
  bytes: number;
  quotes: number;
  slashes: number;
}
const cap = MAX_BACKUP_BYTES * 4 + 4096;
const bounded = (n: number) => Math.min(cap + 1, n);
function textStats(text: string): Stats {
  return {
    bytes: encoder.encode(text).length,
    quotes: (text.match(/"/g) || []).length,
    slashes: (text.match(/\\/g) || []).length,
  };
}
const sum = (a: Stats, b: Stats): Stats => ({
  bytes: bounded(a.bytes + b.bytes),
  quotes: bounded(a.quotes + b.quotes),
  slashes: bounded(a.slashes + b.slashes),
});
export function sharedJsonReader(nodes: ReadonlyMap<string, string>) {
  ensure(nodes.size <= sharedJsonMaxNodes);
  const parsed = new Map<string, unknown[]>(),
    stats = new Map<string, Stats>(),
    active = new Set<string>(),
    used = new Set<string>();
  function inspect(key: string, depth = 0): Stats {
    ensure(hex.test(key) && depth <= 96);
    const old = stats.get(key);
    if (old) return old;
    ensure(!active.has(key));
    active.add(key);
    const json = nodes.get(key);
    ensure(
      typeof json === 'string' &&
        json.length <= MAX_BACKUP_BYTES &&
        encoder.encode(json).length <= MAX_BACKUP_BYTES &&
        sharedJsonHash(json) === key,
    );
    const n: unknown = JSON.parse(json);
    ensure(Array.isArray(n) && literalToken(n) === json);
    parsed.set(key, n);
    used.add(key);
    let s: Stats;
    if (n[0] === 'z') {
      ensure(n.length === 1);
      s = textStats('null');
    } else if (n[0] === 's' || n[0] === 'b' || n[0] === 'n') {
      ensure(
        n.length === 2 &&
          (n[0] === 's'
            ? typeof n[1] === 'string'
            : n[0] === 'b'
              ? typeof n[1] === 'boolean'
              : typeof n[1] === 'number' && Number.isFinite(n[1])),
      );
      s = textStats(JSON.stringify(n[1]));
    } else if (n[0] === 'j') {
      ensure(n.length === 2 && typeof n[1] === 'string');
      const c = inspect(n[1], depth + 1);
      s = {
        bytes: bounded(c.bytes + c.quotes + c.slashes + 2),
        quotes: bounded(c.quotes + 2),
        slashes: bounded(c.slashes * 2 + c.quotes),
      };
    } else {
      ensure(
        n.length === 2 && Array.isArray(n[1]) && (n[0] === 'a' || n[0] === 'o'),
      );
      s = { bytes: 2 + Math.max(0, n[1].length - 1), quotes: 0, slashes: 0 };
      let previous: string | undefined;
      for (const child of n[1]) {
        let ref: unknown = child;
        if (n[0] === 'o') {
          ensure(
            Array.isArray(child) &&
              child.length === 2 &&
              typeof child[0] === 'string' &&
              (previous === undefined || previous < child[0]),
          );
          previous = child[0];
          ref = child[1];
          s = sum(
            s,
            sum(textStats(JSON.stringify(child[0])), {
              bytes: 1,
              quotes: 0,
              slashes: 0,
            }),
          );
        }
        ensure(typeof ref === 'string');
        s = sum(s, inspect(ref, depth + 1));
      }
    }
    active.delete(key);
    stats.set(key, s);
    return s;
  }
  function read(key: string, limit = MAX_BACKUP_BYTES): unknown {
    ensure(
      Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= cap &&
        inspect(key).bytes <= limit,
    );
    const values = new Map<string, unknown>();
    function build(ref: string): unknown {
      if (values.has(ref)) return values.get(ref);
      const n = parsed.get(ref)!;
      let v: unknown;
      if (n[0] === 'z') v = null;
      else if (n[0] === 's' || n[0] === 'b' || n[0] === 'n') v = n[1];
      else if (n[0] === 'j') v = literalToken(build(n[1] as string));
      else if (n[0] === 'a') v = (n[1] as string[]).map(build);
      else
        v = Object.fromEntries(
          (n[1] as [string, string][]).map(([k, r]) => [k, build(r)]),
        );
      values.set(ref, v);
      return v;
    }
    return build(key);
  }
  return {
    read,
    used,
    assertComplete() {
      ensure(used.size === nodes.size);
    },
  };
}
