export const defaultFlags = { uiGallery: false, localApp: true, counter: true, khata: true, orders: true, stock: true, today: true, exports: true, pwa: true, shopLinks: true, pasteOrders: true, qrPosters: false, handOffs: true, shareTarget: false, cloudSetup:false, cloudSync:false, deviceAccess:false, kitchenScreen:false, kitchenAlarms:false, customerLinks:false, publicOrders:false, staffTeam:false,customerKhata:false,liveStore:false } as const;
export type FeatureFlag = keyof typeof defaultFlags;

export function flagEnabled(name: FeatureFlag, query = '', stored = ''): boolean {
  return flagValue(name,defaultFlags[name],query,stored);
}

/** A single known default can be tree-shaken into small independent entries. */
export function flagValue(name: string, fallback: boolean, query = '', stored = ''): boolean {
  if (new URLSearchParams(query).get('flags')?.split(',').includes(name)) return true;
  try { return JSON.parse(stored || '{}')[name] === true || fallback; }
  catch { return fallback; }
}
