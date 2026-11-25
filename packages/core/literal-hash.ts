import { sha256 } from '@noble/hashes/sha2';
import { literalToken } from './literal-token';
export const literalHashMaxBytes = 32 * 1024 * 1024;
export const literalHashMaxEntryBytes = 128 * 1024;
export const literalHashMaxEntries = 16384;
/** Calculation reuse, never a validation/permission proof. Every call serializes
 * the full current input before an exact string lookup. Large values are hashed
 * completely and are not retained. No mutable object is a cache key. */
export function createLiteralHasher(
  options: {
    maxBytes?: number;
    maxEntryBytes?: number;
    maxEntries?: number;
  } = {},
) {
  const maxBytes = options.maxBytes ?? literalHashMaxBytes,
    maxEntryBytes =
      options.maxEntryBytes ?? Math.min(maxBytes, literalHashMaxEntryBytes),
    maxEntries = options.maxEntries ?? literalHashMaxEntries;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > literalHashMaxBytes ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > Math.min(maxBytes, literalHashMaxEntryBytes) ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > literalHashMaxEntries
  )
    throw Error('Use bounded hashing limits.');
  const cache = new Map<string, { digest: string; bytes: number }>(),
    encoder = new TextEncoder();
  let retainedBytes = 0;
  return {
    get retainedBytes() {
      return retainedBytes;
    },
    get size() {
      return cache.size;
    },
    hash(value: unknown): string {
      const text = literalToken(value),
        bytes = typeof text === 'string' ? text.length * 2 + 256 : Infinity,
        retain = bytes <= maxEntryBytes;
      if (retain) {
        const old = cache.get(text);
        if (old) return old.digest;
      }
      const digest = Array.from(sha256(encoder.encode(text)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (retain) {
        while (cache.size >= maxEntries || retainedBytes + bytes > maxBytes) {
          const first = cache.keys().next().value!;
          retainedBytes -= cache.get(first)!.bytes;
          cache.delete(first);
        }
        cache.set(text, { digest, bytes });
        retainedBytes += bytes;
      }
      return digest;
    },
  };
}
const shared = createLiteralHasher();
export function literalSha256(value: unknown): string {
  return shared.hash(value);
}
