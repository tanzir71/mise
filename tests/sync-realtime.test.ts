import { afterEach, expect, it, vi } from 'vitest';
import type { SyncSession } from '../packages/core/sync-session';
import type { SyncCycleOptions } from '../apps/web/src/data/sync-cycle';
const mock = vi.hoisted(() => ({
  getAuth: vi.fn(),
  assertCurrent: vi.fn(),
  channel: vi.fn(),
  removeAllChannels: vi.fn(),
  disconnect: vi.fn(),
  setAuth: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../apps/web/src/data/sync-cycle', () => ({
  cycleAccount: () => mock,
}));
vi.mock('../apps/web/node_modules/@supabase/supabase-js', () => ({
  createClient: () => ({
    channel: mock.channel,
    removeAllChannels: mock.removeAllChannels,
    realtime: { disconnect: mock.disconnect, setAuth: mock.setAuth },
  }),
}));
import { watchSyncRealtime } from '../apps/web/src/data/sync-realtime';
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const state = {
    target: { outletId: '00000000000000000000000001' },
  } as SyncSession,
  options = {
    config: {
      apiUrl: 'https://realtime.test',
      publishableKey: 'sb_publishable_test_only',
    },
  } as SyncCycleOptions;
function client() {
  mock.removeAllChannels.mockResolvedValue(undefined);
  mock.setAuth.mockResolvedValue(undefined);
  mock.channel.mockReturnValue({ on: mock.on });
  mock.on.mockReturnValue({ subscribe: mock.subscribe });
}
it('cancelling during initial verification cannot join the outlet when the Auth reply arrives later', async () => {
  client();
  let release!: (value: unknown) => void;
  mock.getAuth.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController(),
    wake = vi.fn(),
    watch = watchSyncRealtime(
      options,
      state,
      wake,
      undefined,
      controller.signal,
    );
  controller.abort();
  release({ jwt: 'synthetic-test-token' });
  const stop = await watch;
  stop();
  expect(mock.channel).not.toHaveBeenCalled();
  expect(mock.setAuth).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
  expect(mock.disconnect).toHaveBeenCalledOnce();
});
it('an outlet message only schedules a pull, and cancellation drops an already queued hint', async () => {
  vi.useFakeTimers();
  client();
  mock.getAuth.mockResolvedValue({ jwt: 'synthetic-test-token' });
  const controller = new AbortController(),
    wake = vi.fn(),
    stop = await watchSyncRealtime(
      options,
      state,
      wake,
      undefined,
      controller.signal,
    ),
    notify = mock.on.mock.calls[0][2] as (payload: unknown) => void;
  notify({ new: { amount: 99999999 } });
  notify({ new: { amount: 1 } });
  expect(wake).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(wake).toHaveBeenCalledOnce();
  notify({ new: { amount: 2 } });
  controller.abort();
  await vi.advanceTimersByTimeAsync(30000);
  expect(wake).toHaveBeenCalledOnce();
  stop();
  expect(mock.on.mock.calls[0].slice(0, 2)).toEqual([
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'events',
      filter: 'outlet_id=eq.' + state.target.outletId,
    },
  ]);
});
