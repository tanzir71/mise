import { liveQuery } from 'dexie';
import { newInboxId } from '@mise/core/inbox';
import {syncWaitingCount} from './native-payment-sync-source';
import { parseSyncSession } from '@mise/core/sync-session';
import {
  activeSyncSession,
  runSyncCycle,
  type SyncCycleOptions,
} from './sync-cycle';
import {
  requestSync,
  pauseSyncSession,
  freshSyncDownload,
} from './sync-session';
import type { MiseDatabase } from './db';

export interface SyncRuntimeOptions extends SyncCycleOptions {
  online?: () => boolean;
  onBusy?: (busy: boolean) => void;
  onFailure?: () => void;
  realtime?: (
    wake: () => void,
    disconnected: () => void,
    signal: AbortSignal,
  ) => Promise<() => void>;
}
/** One tab-local runner; browser locks coordinate tabs, with durable leases as fallback. */
export function createSyncRuntime(
  db: MiseDatabase,
  options: SyncRuntimeOptions,
) {
  const now = options.now ?? Date.now,
    online =
      options.online ??
      (() => typeof navigator === 'undefined' || navigator.onLine),
    lifetime = new AbortController();
  let closed = false,
    running: Promise<void> | null = null,
    cycle: AbortController | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopRealtime: (() => void) | undefined,
    realtimeController: AbortController | null = null,
    startingRealtime = false,
    wantRealtime = false,
    lastSequence: number | null = null,
    lastUnsent = 0;
  const failure = () => {
    if (!closed) options.onFailure?.();
  };
  function schedule(delay = 500) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        void pump();
      },
      Math.max(100, Math.min(30000, delay)),
    );
  }
  async function wake(reconnect = false) {
    try {
      await requestSync(db, false, reconnect);
      schedule(100);
    } catch {
      failure();
    }
  }
  async function pump() {
    if (closed || running || !online()) return;
    running = (async () => {
      const state = await activeSyncSession(db);
      if (
        !state ||
        state.paused ||
        state.problem === 'auth' ||
        state.problem === 'review'
      )
        return;
      if (state.retryAt > now()) {
        schedule(state.retryAt - now());
        return;
      }
      if (!state.readId && state.requested === state.confirmed && !state.lease)
        return;
      cycle = new AbortController();
      options.onBusy?.(true);
      const signal = AbortSignal.any([lifetime.signal, cycle.signal]);
      if (typeof navigator !== 'undefined' && navigator.locks)
        await navigator.locks.request(
          'mise:sync:' + db.name,
          { mode: 'exclusive', ifAvailable: true },
          (lock) =>
            lock && !signal.aborted
              ? runSyncCycle(db, options, signal, true)
              : Promise.resolve(false),
        );
      else await runSyncCycle(db, options, signal);
    })()
      .catch(() => {
        if (!closed && !lifetime.signal.aborted) failure();
      })
      .finally(async () => {
        running = null;
        cycle = null;
        options.onBusy?.(false);
        if (!closed && online()) {
          const latest = await activeSyncSession(db);
          if (
            latest &&
            !latest.paused &&
            latest.problem !== 'auth' &&
            latest.problem !== 'review' &&
            (latest.readId ||
              latest.lease ||
              latest.confirmed < latest.requested)
          )
            schedule(latest.retryAt > now() ? latest.retryAt - now() : 500);
        }
      });
    await running;
  }
  function realtime(enabled: boolean) {
    wantRealtime = enabled;
    if (!enabled) {
      realtimeController?.abort();
      realtimeController = null;
      stopRealtime?.();
      stopRealtime = undefined;
      return;
    }
    if (!options.realtime || stopRealtime || startingRealtime || closed) return;
    const attempt = new AbortController();
    realtimeController = attempt;
    startingRealtime = true;
    void options
      .realtime(
        () => {
          if (!attempt.signal.aborted && !closed) void wake();
        },
        () => {
          if (attempt.signal.aborted || closed) return;
          stopRealtime = undefined;
          void wake();
        },
        attempt.signal,
      )
      .then((stop) => {
        if (closed || !online() || !wantRealtime || attempt.signal.aborted)
          stop();
        else stopRealtime = stop;
      })
      .catch(() => {
        /* Cursor polling remains authoritative when the socket is unavailable. */
      })
      .finally(() => {
        startingRealtime = false;
        if (attempt.signal.aborted && wantRealtime && !closed) realtime(true);
      });
  }
  const network = () => {
    if (!online()) {
      cycle?.abort();
      realtime(false);
    } else void wake(true);
  };
  const auth = () => {
    if (options.auth.getSnapshot().phase !== 'signed-in') {
      cycle?.abort();
      realtime(false);
    } else schedule(100);
  };
  const changed = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === 'mise.cloud.connection.v1' ||
      event.key === options.auth.key
    ) {
      cycle?.abort();
      realtime(false);
      schedule(100);
    }
  };
  const visibility = () => {
    if (document.visibilityState === 'visible') void wake();
  };
  const queue = liveQuery(async () => {
    const binding = await db.cloudState.get('binding');
    return [
      binding?.sequence ?? 0,
      await syncWaitingCount(db),
    ] as const;
  }).subscribe({
    next([sequence, unsent]) {
      const changed = sequence !== lastSequence || unsent > lastUnsent;
      lastSequence = sequence;
      lastUnsent = unsent;
      // Acknowledgements belong to this cycle; only new local work wakes it.
      if (changed) void wake();
    },
    error: failure,
  });
  const session = liveQuery(() => db.syncSessions.get('active')).subscribe({
    next(raw) {
      if (raw) {
        const state = parseSyncSession(raw);
        if (state.paused) cycle?.abort();
        realtime(online() && !state.paused && state.problem === null);
        schedule(100);
      }
    },
    error: failure,
  });
  const unwatchAuth = options.auth.subscribe(auth),
    poll = setInterval(() => {
      // A running cycle already performs a cursor pull. Timer ticks must not
      // create a permanent backlog when a large download takes over 30 seconds.
      if (online() && !running) void wake();
    }, 30000);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    window.addEventListener('storage', changed);
    document.addEventListener('visibilitychange', visibility);
  }
  schedule(100);
  return {
    async now() {
      await requestSync(db, true);
      await pump();
    },
    async pause() {
      cycle?.abort();
      realtime(false);
      await pauseSyncSession(db);
    },
    async fresh() {
      await freshSyncDownload(db, newInboxId());
      schedule(100);
    },
    async stop() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      cycle?.abort();
      clearTimeout(timer);
      clearInterval(poll);
      queue.unsubscribe();
      session.unsubscribe();
      unwatchAuth();
      realtime(false);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', network);
        window.removeEventListener('offline', network);
        window.removeEventListener('storage', changed);
        document.removeEventListener('visibilitychange', visibility);
      }
      await running;
    },
  };
}
