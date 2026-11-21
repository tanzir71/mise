import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openScreenJournal } from '../apps/web/src/data/device-screen-journal';
import { readScreenReservation } from '../apps/web/src/data/screen-profile';
import { deviceSecretHash } from '../packages/core/device-access';
it('an ordinary owner gate creates no screen database and recognizes the later reservation/tombstone', async () => {
  const factory = new IDBFactory(),
    base = '/mise/app/';
  expect(await readScreenReservation(base, factory)).toBe(false);
  expect(await factory.databases()).toEqual([]);
  const journal = await openScreenJournal(base, factory),
    empty = await journal.read(),
    token = 'D'.repeat(43);
  expect(await readScreenReservation(base, factory)).toBe(false);
  const saved = await journal.replace(empty, {
    phase: 'pairing',
    source: {
      connection: {
        apiUrl: 'https://screen.test',
        publishableKey: 'sb_publishable_test_only',
      },
      requestId: '00000000000000000000000005',
      token,
      tokenHash: await deviceSecretHash(token),
      code: '123456',
      pairingId: null,
    },
    receipt: null,
  });
  expect(await readScreenReservation(base, factory)).toBe(true);
  await journal.replace(saved, { phase: 'empty' });
  expect(await readScreenReservation(base, factory)).toBe(false);
  journal.close();
});
