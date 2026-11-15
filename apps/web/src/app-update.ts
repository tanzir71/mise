import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';
let waiting = false;
const listeners = new Set<() => void>();
const update = registerSW({ immediate: true, onNeedRefresh() { waiting = true; for (const listener of listeners) listener(); } });
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useAppUpdate() { return [useSyncExternalStore(subscribe, () => waiting), () => void update()] as const; }
