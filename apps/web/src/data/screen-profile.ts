import {
  screenJournalDatabaseName,
  ScreenStorageError,
} from './device-screen-journal';
import { parseScreenJournalRecord } from '@mise/core/device-screen-state';

export const screenProfileEvent = 'mise-screen-profile';
const channelName = (base: string) => 'mise.screen.profile:' + base;
export function watchScreenProfile(base: string, changed: () => void) {
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel === 'function')
      channel = new BroadcastChannel(channelName(base));
  } catch {
    /* Focus/visibility and the native checks remain available. */
  }
  if (channel) channel.onmessage = changed;
  window.addEventListener(screenProfileEvent, changed);
  window.addEventListener('focus', changed);
  const visible = () => {
    if (document.visibilityState === 'visible') changed();
  };
  document.addEventListener('visibilitychange', visible);
  return () => {
    channel?.close();
    window.removeEventListener(screenProfileEvent, changed);
    window.removeEventListener('focus', changed);
    document.removeEventListener('visibilitychange', visible);
  };
}
/** Read-only gate before the lazy owner app import. An absent database is
 * detected by aborting creation, so a normal visit creates no screen store. */
export function readScreenReservation(
  base: string,
  factory: IDBFactory = indexedDB,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined,
      missing = false,
      done = false;
    const finish = (value?: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      db?.close();
      if (value === undefined) reject(new ScreenStorageError('unavailable'));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(), 5000);
    try {
      const request = factory.open(screenJournalDatabaseName(base));
      request.onblocked = () => finish();
      request.onupgradeneeded = () => {
        missing = true;
        request.transaction?.abort();
      };
      request.onerror = () => finish(missing ? false : undefined);
      request.onsuccess = () => {
        db = request.result;
        if (done) {
          db.close();
          return;
        }
        db.onversionchange = () => finish();
        if (!db.objectStoreNames.contains('state')) {
          finish();
          return;
        }
        try {
          const tx = db.transaction('state', 'readonly'),
            read = tx.objectStore('state').get('current');
          let reserved = false;
          read.onsuccess = () => {
            try {
              reserved =
                read.result !== undefined &&
                parseScreenJournalRecord(read.result).state.phase !== 'empty';
            } catch {
              tx.abort();
            }
          };
          tx.oncomplete = () => finish(reserved);
          tx.onabort = () => finish();
          tx.onerror = () => finish();
        } catch {
          finish();
        }
      };
    } catch {
      finish();
    }
  });
}
