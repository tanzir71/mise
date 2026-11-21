export type KitchenLiveFrame = {v: 1; type: 'ready'|'wake'|'heartbeat'|'auth'};
/** A wake signal is never an order, a cursor, an acknowledgement or authority. */
export function parseKitchenLiveFrame(value: unknown): KitchenLiveFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'type,v' ||
      !('v' in value) || value.v !== 1 || !('type' in value) || !['ready','wake','heartbeat','auth'].includes(value.type as string)) throw Error('Kitchen updates are unavailable.');
  return {v: 1, type: value.type as KitchenLiveFrame['type']};
}
