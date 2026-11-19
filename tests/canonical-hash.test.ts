import { expect, it } from 'vitest';
import { nativeRowHash } from '../apps/web/src/data/canonical-writes';
import { materializationHash } from '../packages/core/sync-materialize';
import { cloudUploadFixture } from './cloud-upload-fixture';
it('retains the exact existing hash for a complete 5,000-record plain-data shop', async () => {
  const backup = cloudUploadFixture(5000);
  expect(await nativeRowHash(backup)).toBe(await materializationHash(backup));
});
it('checks complete nested Blob bytes while preserving the existing object and undefined-field normalization', async () => {
  const bytes = Uint8Array.of(0, 255, 3, 128),
    blob = new Blob([bytes], { type: 'image/png' }),
    sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const value = {
      originals: [{ blob }, undefined],
      ignored: undefined,
      label: 'তালিকা',
    },
    expected = {
      originals: [
        { blob: { type: 'original-blob', mime: 'image/png', size: 4, sha256 } },
        null,
      ],
      label: 'তালিকা',
    };
  expect(await nativeRowHash(value)).toBe(await materializationHash(expected));
  expect(
    await nativeRowHash({
      ...value,
      originals: [
        {
          blob: new Blob([Uint8Array.of(0, 255, 3, 129)], {
            type: 'image/png',
          }),
        },
        undefined,
      ],
    }),
  ).not.toBe(await nativeRowHash(value));
});
it.each([
  new Date(),
  new Map(),
  { nested: () => 0 },
  [Symbol('invalid')],
  Number.NaN,
])('still rejects nonportable native row values', async (value) => {
  await expect(nativeRowHash(value)).rejects.toThrow();
});
