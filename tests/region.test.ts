import { describe, expect, it, vi } from 'vitest';
import { browserRegion, countryRegion, resolveRegion } from '../packages/core/region';

describe('region selection', () => {
  const defaults = { timezone: 'Asia/Dhaka', languages: ['en-US'] };
  it('honours query over saved choice and skips lookup', async () => {
    const lookup = vi.fn();
    expect(await resolveRegion({ ...defaults, query: 'intl', saved: 'bd', lookup })).toBe('intl');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('honours saved choice over location', async () => {
    expect(await resolveRegion({ ...defaults, saved: 'intl' })).toBe('intl');
  });
  it('uses a valid geo response before browser hints', async () => {
    expect(await resolveRegion({ ...defaults, lookup: async () => ({ country_code: 'US' }) })).toBe('intl');
    expect(countryRegion({ countryCode: 'bd' })).toBe('bd');
    expect(countryRegion({ country: 'Bangladesh' })).toBeUndefined();
  });
  it('falls back on malformed responses and network failures', async () => {
    expect(await resolveRegion({ ...defaults, lookup: async () => { throw new Error('offline'); } })).toBe('bd');
    expect(await resolveRegion({ ...defaults, query: 'invalid', lookup: async () => ({}) })).toBe('bd');
    expect(browserRegion('Europe/London', ['bn-BD', 'en'])).toBe('bd');
    expect(browserRegion('Europe/London', ['en-GB'])).toBe('intl');
  });
});
