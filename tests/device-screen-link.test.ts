import { expect, it } from 'vitest';
import {
  decodeScreenSetupHash,
  screenSetupUrl,
} from '../packages/core/device-screen-link';
const source = {
  v: 1 as const,
  connection: {
    apiUrl: 'https://screen.test',
    publishableKey: 'sb_publishable_test_only',
  },
  pairingId: '00000000000000000000000010',
  code: '123456',
};
it.each(['/app/', '/mise/app/'])(
  'setup links preserve the supplied runtime connection at portable base %s, with no device/session/PIN fields',
  (base) => {
    const url = new URL(screenSetupUrl('https://shop.test', base, source));
    expect(url.pathname).toBe(base + 'screen/setup');
    expect(url.searchParams.get('flags')).toBe('deviceAccess');
    expect(decodeScreenSetupHash(url.hash)).toEqual(source);
    expect(Object.keys(decodeScreenSetupHash(url.hash)!).sort()).toEqual([
      'code',
      'connection',
      'pairingId',
      'v',
    ]);
  },
);
it('extra credentials cannot be encoded or decoded as setup data', () => {
  for (const patch of [
    { token: 'D'.repeat(43) },
    { sessionToken: 'S'.repeat(43) },
    { pin: '0042' },
    {
      connection: {
        apiUrl: 'https://screen.test',
        publishableKey: 'sb_secret_test_only',
      },
    },
  ]) {
    expect(() =>
      screenSetupUrl('https://shop.test', '/app/', {
        ...source,
        ...patch,
      } as typeof source),
    ).toThrow();
    expect(() =>
      decodeScreenSetupHash(
        '#mise-screen=' +
          encodeURIComponent(JSON.stringify({ ...source, ...patch })),
      ),
    ).toThrow();
  }
});
it('unsupported hashes, oversized values and alternate setup authorities fail without echoing input', () => {
  expect(decodeScreenSetupHash('')).toBeNull();
  for (const hash of [
    '#foreign=PRIVATE',
    '#mise-screen=%zz',
    '#mise-screen=' + 'x'.repeat(8193),
  ])
    expect(() => decodeScreenSetupHash(hash)).toThrow(
      'Use the complete screen setup link',
    );
  for (const origin of [
    'https://user:password@shop.test',
    'https://shop.test/path',
    'http://shop.test',
  ])
    expect(() => screenSetupUrl(origin, '/app/', source)).toThrow();
});
