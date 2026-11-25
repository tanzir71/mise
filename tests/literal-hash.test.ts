import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createLiteralHasher,
  literalHashMaxBytes,
  literalHashMaxEntries,
  literalHashMaxEntryBytes,
} from '../packages/core/literal-hash';
import { literalToken } from '../packages/core/literal-token';
import { paymentEvidenceDigest } from '../packages/core/payment-evidence';
import { paymentInvocationHash } from '../packages/core/payment-invocations';
const independent = (value: unknown) =>
  createHash('sha256')
    .update(new TextEncoder().encode(literalToken(value)))
    .digest('hex');
it('preserves independent SHA-256 bytes for complete canonical JSON, Unicode, NULs, lone surrogates and historical undefined input', () => {
  const hash = createLiteralHasher();
  for (const value of [
    undefined,
    null,
    true,
    false,
    0,
    -0,
    Number.NaN,
    Infinity,
    'Full\0\ud800 বাংলা 💠',
    [],
    { b: 2, a: 1 },
    JSON.parse('{"__proto__":{"literal":true},"constructor":"text"}'),
  ]) {
    expect(hash.hash(value)).toBe(independent(value));
    expect(hash.hash(value)).toBe(independent(value));
  }
});
it('matches independent hashes across arbitrary JSON and repeated calculations', () => {
  const hash = createLiteralHasher();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const expected = independent(value);
      expect(hash.hash(value)).toBe(expected);
      expect(hash.hash(structuredClone(value))).toBe(expected);
      expect(paymentEvidenceDigest(value)).toBe(expected);
      expect(paymentInvocationHash(value)).toBe(expected);
    }),
    { numRuns: 200 },
  );
});
it('re-serializes changed money, scope, notes, nested fields and ledger parents instead of trusting object identity', () => {
  const hash = createLiteralHasher(),
    row = {
      amount: 100,
      note: 'original',
      scope: { outlet: 'one' },
      values: [1, 2],
    };
  const original = hash.hash(['parent-one', row]);
  row.amount = 200;
  expect(hash.hash(['parent-one', row])).toBe(independent(['parent-one', row]));
  expect(hash.hash(['parent-one', row])).not.toBe(original);
  row.note += '\0\ud800';
  row.scope.outlet = 'two';
  row.values.push(3);
  expect(hash.hash(['parent-two', row])).toBe(independent(['parent-two', row]));
});
it('hashes a complete million-code-unit value without retaining or truncating its bytes', () => {
  const hash = createLiteralHasher(),
    value = 'Original\0\ud800 বাংলা '.repeat(100000).slice(0, 1000000),
    before = hash.retainedBytes;
  expect(value).toHaveLength(1000000);
  expect(hash.hash(value)).toBe(independent(value));
  expect(hash.retainedBytes).toBe(before);
  expect(hash.size).toBe(0);
});
it('keeps accounting and entry counts bounded through eviction without changing any output', () => {
  const hash = createLiteralHasher({
    maxBytes: 2048,
    maxEntryBytes: 1024,
    maxEntries: 3,
  });
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < 50; i++) {
      const value = { i, text: 'Complete '.repeat(i) };
      expect(hash.hash(value)).toBe(independent(value));
      expect(hash.retainedBytes).toBeLessThanOrEqual(2048);
      expect(hash.size).toBeLessThanOrEqual(3);
    }
});
it('preserves property-order equivalence and rejects unsupported data before retaining anything', () => {
  const hash = createLiteralHasher();
  expect(hash.hash({ a: 1, b: 2 })).toBe(hash.hash({ b: 2, a: 1 }));
  const before = hash.size;
  expect(() => hash.hash({ invalid: 1n })).toThrow();
  expect(hash.size).toBe(before);
});
for (const options of [
  { maxBytes: 0 },
  { maxBytes: literalHashMaxBytes + 1 },
  { maxEntries: 0 },
  { maxEntries: literalHashMaxEntries + 1 },
  { maxEntryBytes: literalHashMaxEntryBytes + 1 },
  { maxBytes: 256, maxEntryBytes: 257 },
  { maxBytes: 1.5 },
])
  it(
    'rejects invalid calculation-cache limits ' + JSON.stringify(options),
    () => {
      expect(() => createLiteralHasher(options)).toThrow();
    },
  );
