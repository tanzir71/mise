import { expect, it } from 'vitest';
import {
  paymentWallTime,
  parsePaymentWallTime,
} from '../packages/core/payments';

it.each([
  'Asia/Dhaka',
  'UTC',
  'America/New_York',
  'Asia/Kolkata',
  'Pacific/Chatham',
])(
  'round trips the actual received milliseconds in %s independently of the browser clock',
  (zone) => {
    const at = Date.UTC(2026, 10, 25, 9, 12, 34, 567);
    expect(parsePaymentWallTime(paymentWallTime(at, zone), zone)).toBe(at);
  },
);
it('rejects a daylight-saving fold and gap instead of silently choosing another received time', () => {
  expect(() =>
    parsePaymentWallTime('2026-11-01T01:30', 'America/New_York'),
  ).toThrow('occurs twice');
  expect(() =>
    parsePaymentWallTime('2026-03-08T02:30', 'America/New_York'),
  ).toThrow('missing');
  expect(parsePaymentWallTime('2026-03-08T03:30', 'America/New_York')).toBe(
    Date.UTC(2026, 2, 8, 7, 30),
  );
});
it.each([
  '2026-02-29T12:00',
  '2026-04-31T12:00',
  '2026-01-01T24:00',
  '2026-01-01T12:00:60',
  '2026-01-01T12:00:00.1234',
  '2026-01-01T12:00Z',
  '01/02/2026 12:00',
  '',
])('rejects a malformed or impossible checked time %s', (value) =>
  expect(() => parsePaymentWallTime(value, 'UTC')).toThrow(),
);
it('keeps fractional seconds, leap days and explicit installation clock semantics', () => {
  expect(parsePaymentWallTime('2024-02-29T12:34:56.1', 'Asia/Dhaka')).toBe(
    Date.UTC(2024, 1, 29, 6, 34, 56, 100),
  );
  expect(parsePaymentWallTime('2026-11-25T14:30', 'Asia/Dhaka')).toBe(
    Date.UTC(2026, 10, 25, 8, 30),
  );
  expect(() =>
    parsePaymentWallTime('2026-11-25T14:30', 'Invalid/Clock'),
  ).toThrow();
  expect(() => paymentWallTime(-1, 'UTC')).toThrow();
});
