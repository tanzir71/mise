import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { requestWorkerControl } from './pwa-control';
let waiting = false;
const listeners = new Set<() => void>();
registerSW({
  immediate: true,
  onRegisteredSW(_url,registration) { if(registration)requestWorkerControl(registration); },
  onNeedRefresh() { waiting = true; for (const listener of listeners) listener(); },
  // Only the tab whose owner presses Reload may replace its open form.
  onNeedReload() {},
});
let applying = false;
async function applyUpdate() {
  if (applying) return;
  applying = true;
  let reloading = false;
  const reload = () => { if (!reloading) { reloading = true; location.reload(); } };
  // Listen before querying the registration: another tab may activate it meanwhile.
  navigator.serviceWorker.addEventListener('controllerchange',reload,{once:true});
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration?.waiting) registration.waiting.postMessage({type:'SKIP_WAITING'});
    else reload(); // An update may already have been activated by another tab.
  } catch { reload(); }
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useAppUpdate() { return [useSyncExternalStore(subscribe, () => waiting), () => void applyUpdate()] as const; }
