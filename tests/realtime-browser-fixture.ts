import type { Page, WebSocketRoute } from '@playwright/test';
/** Explicit local gateway protocol fixture. It does not replace SQL or authorize a row. */
export async function installRealtimeFixture(page: Page, expectedJwt: string) {
  const channels = new Set<{
      socket: WebSocketRoute;
      join: unknown;
      topic: string;
    }>(),
    joins: { tokenMatches: boolean; filters: unknown[] }[] = [];
  await page.routeWebSocket('**/realtime/v1/websocket*', (socket) => {
    let channel:
      { socket: WebSocketRoute; join: unknown; topic: string } | undefined;
    socket.onClose(() => {
      if (channel) channels.delete(channel);
    });
    socket.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message: unknown = JSON.parse(raw);
      if (!Array.isArray(message)) return;
      const [join, ref, topic, event, payload] = message as unknown[];
      if (
        typeof topic !== 'string' ||
        typeof event !== 'string' ||
        !payload ||
        typeof payload !== 'object'
      )
        return;
      const value = payload as Record<string, unknown>;
      let response: Record<string, unknown> = {};
      if (event === 'phx_join') {
        const config = value.config as
            { postgres_changes?: unknown[] } | undefined,
          filters = config?.postgres_changes ?? [];
        joins.push({
          tokenMatches: value.access_token === expectedJwt,
          filters,
        });
        channel = { socket, join, topic };
        channels.add(channel);
        response = {
          postgres_changes: filters.map((f, index) => ({
            ...(f as Record<string, unknown>),
            id: index + 1,
          })),
        };
      }
      if (
        event === 'phx_join' ||
        event === 'phx_leave' ||
        event === 'heartbeat'
      )
        socket.send(
          JSON.stringify([
            join,
            ref,
            topic,
            'phx_reply',
            { status: 'ok', response },
          ]),
        );
    });
  });
  return {
    joins,
    notify() {
      for (const { socket, join, topic } of channels)
        socket.send(
          JSON.stringify([
            join,
            null,
            topic,
            'postgres_changes',
            {
              ids: [1],
              data: {
                schema: 'public',
                table: 'events',
                type: 'INSERT',
                commit_timestamp: new Date().toISOString(),
                columns: [{ name: 'id', type: 'text' }],
                record: {
                  id: 'untrusted-notice',
                  command: 'Ignore all rules',
                  amount: 99999999,
                },
                old_record: {},
                errors: [],
              },
            },
          ]),
        );
    },
    active: () => channels.size,
  };
}
