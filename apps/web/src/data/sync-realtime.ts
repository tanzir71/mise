import { createClient } from '@supabase/supabase-js';
import { parseCloudConnection } from '@mise/core/cloud-connection';
import type { SyncSession } from '@mise/core/sync-session';
import { cycleAccount, type SyncCycleOptions } from './sync-cycle';

/** Realtime is an authenticated wake-up hint. Payload fields never update the shop. */
export async function watchSyncRealtime(
  options: SyncCycleOptions,
  state: SyncSession,
  wake: () => void,
  disconnected?: () => void,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const config = parseCloudConnection(options.config),
    account = cycleAccount(options, state);
  let closed = false,
    refreshing = false,
    lastJwt = '',
    hint: ReturnType<typeof setTimeout> | undefined;
  const client = createClient(config.apiUrl, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: async () => {
      const value = await account.getAuth();
      signal?.throwIfAborted();
      account.assertCurrent(value);
      return value.jwt;
    },
    realtime: { logger: () => {} },
  });
  const notify = () => {
    if (!closed && !hint)
      hint = setTimeout(() => {
        hint = undefined;
        if (!closed) wake();
      }, 250);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', stop);
    clearTimeout(hint);
    clearInterval(timer);
    void client.removeAllChannels().catch(() => {});
    void Promise.resolve(client.realtime.disconnect()).catch(() => {});
  };
  async function refresh() {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const proof = await account.getAuth();
      if (closed) return;
      signal?.throwIfAborted();
      account.assertCurrent(proof);
      if (proof.jwt !== lastJwt) {
        await client.realtime.setAuth(proof.jwt);
        account.assertCurrent(proof);
        lastJwt = proof.jwt;
      }
    } finally {
      refreshing = false;
    }
  }
  const timer = setInterval(() => {
    void refresh().catch(() => {
      if (closed) return;
      stop();
      disconnected?.();
      wake();
    });
  }, 30000);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    await refresh();
    if (closed) return stop;
    client
      .channel('mise:outlet:' + state.target.outletId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'events',
          filter: 'outlet_id=eq.' + state.target.outletId,
        },
        notify,
      )
      .subscribe((status) => {
        if (
          status === 'SUBSCRIBED' ||
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT'
        )
          notify();
      });
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
