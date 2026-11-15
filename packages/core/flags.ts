export const defaultFlags = { uiGallery: false, localApp: true, counter: true } as const;
export type FeatureFlag = keyof typeof defaultFlags;

export function flagEnabled(name: FeatureFlag, query = '', stored = ''): boolean {
  if (new URLSearchParams(query).get('flags')?.split(',').includes(name)) return true;
  try { return JSON.parse(stored || '{}')[name] === true || defaultFlags[name]; }
  catch { return defaultFlags[name]; }
}
