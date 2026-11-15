export type Region = 'bd' | 'intl';
export function validRegion(value: unknown): Region | undefined {
  return value === 'bd' || value === 'intl' ? value : undefined;
}
export function browserRegion(timezone: string, languages: readonly string[]): Region {
  return timezone === 'Asia/Dhaka' || languages.some(language => /^bn(?:-|$)/i.test(language)) ? 'bd' : 'intl';
}
export function countryRegion(value: unknown): Region | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const data = value as Record<string, unknown>;
  const country = data.country_code ?? data.countryCode ?? data.country;
  if (typeof country !== 'string' || !/^[a-z]{2}$/i.test(country)) return undefined;
  return country.toUpperCase() === 'BD' ? 'bd' : 'intl';
}
export async function resolveRegion(options: {
  query?: string | null; saved?: string | null; timezone: string; languages: readonly string[];
  lookup?: () => Promise<unknown>;
}): Promise<Region> {
  const explicit = validRegion(options.query) || validRegion(options.saved);
  if (explicit) return explicit;
  if (options.lookup) {
    try { const region = countryRegion(await options.lookup()); if (region) return region; }
    catch { /* A failed lookup never prevents the regional page from loading. */ }
  }
  return browserRegion(options.timezone, options.languages);
}
