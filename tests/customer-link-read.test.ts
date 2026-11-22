import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createPublicReadDatabase,
  type PublicReadDatabase,
} from './public-read-fixture';
import {
  customerViewerUrl,
  decodeCustomerViewer,
  customerWhatsAppUrl,
} from '../packages/core/customer-link-url';
import { readCustomerLink } from '../apps/web/src/data/customer-link-read';
const token = 'a'.repeat(43),
  apiUrl = 'https://backend.example',
  viewer = { v: 1 as const, kind: 'order' as const, token, apiUrl };
let fixture: PublicReadDatabase;
it('messaging keeps a complete Unicode draft and falls back to Copy for an unrepresentable imported source', () => {
  const text =
      'অর্ডার\n' +
      customerViewerUrl('https://shop.example', '/app/', {
        apiUrl,
        kind: 'order',
        token,
      }),
    url = customerWhatsAppUrl('+14155550199', text);
  expect(new URL(url!).searchParams.get('text')).toBe(text);
  expect(customerWhatsAppUrl('+14155550199', 'Literal\ud800source')).toBeNull();
  expect(customerWhatsAppUrl('invalid', text)).toBeNull();
});
it('an app base cannot turn a customer link into a different host', () => {
  expect(() =>
    customerViewerUrl('https://shop.example', '//other.example/app/', {
      apiUrl,
      kind: 'order',
      token,
    }),
  ).toThrow();
});
beforeAll(async () => {
  fixture = await createPublicReadDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.db.close();
});
it.each(['/app/', '/mise/app/'])(
  'customer link round-trips under %s without a key, account, tenant or phone',
  (base) => {
    const raw = customerViewerUrl('https://shop.example', base, {
        apiUrl,
        kind: 'order',
        token,
      }),
      url = new URL(raw);
    expect(url.pathname).toBe(base + 't/' + token);
    expect(url.searchParams.get('flags')).toBe('customerLinks');
    expect(decodeCustomerViewer(url.pathname, url.hash, base)).toEqual(viewer);
    const decoded = decodeURIComponent(url.hash);
    for (const forbidden of [
      'publishable',
      'jwt',
      'password',
      'phone',
      'businessId',
      'outletId',
      'actorId',
    ])
      expect(decoded).not.toContain(forbidden);
  },
);
it.each([
  'javascript:alert(1)',
  'https://a:b@backend.example',
  'https://backend.example/path',
  'https://backend.example/?key=secret',
  'https://backend.example/#secret',
  'http://backend.example',
  ' https://backend.example',
])('unsafe backend URL %s never enters a customer link', (api) => {
  expect(() =>
    customerViewerUrl('https://shop.example', '/app/', {
      apiUrl: api,
      kind: 'order',
      token,
    }),
  ).toThrow();
});
it.each([
  { v: 1, apiUrl, jwt: 'owner.signature' },
  { v: 1, apiUrl, publishableKey: 'sb_publishable_test_only' },
  { v: 2, apiUrl },
  { v: 1, apiUrl, token },
])('unexpected fragment fields %j cannot configure the reader', (body) => {
  expect(() =>
    decodeCustomerViewer(
      '/app/t/' + token,
      '#mise-customer=' + encodeURIComponent(JSON.stringify(body)),
      '/app/',
    ),
  ).toThrow();
});
it.each([
  '',
  '/app/t/short',
  '/app/t/' + token + '/other',
  '/app/owner/' + token,
])('incomplete route %s cannot start a read', (path) => {
  expect(() =>
    decodeCustomerViewer(
      path,
      '#mise-customer=' + encodeURIComponent(JSON.stringify({ v: 1, apiUrl })),
      '/app/',
    ),
  ).toThrow();
});
it.each(['order', 'khata'] as const)(
  '%s public client reads the real bounded SQL projection with no owner credentials and preserves exact values',
  async (kind) => {
    const resource =
        kind === 'order'
          ? fixture.source.tables.orders[0].id
          : fixture.source.tables.creditAccounts[0].id,
      cap = await fixture.issue(1, kind, resource),
      handler = fixture.handler();
    let requests = 0;
    const send: typeof fetch = async (url, init) => {
      requests++;
      expect(new URL(String(url)).href).toBe(
        apiUrl + '/functions/v1/public-read',
      );
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
      });
      expect(Object.keys(init!.headers!)).toEqual(['Content-Type']);
      const headers = new Headers(init?.headers);
      headers.set('Origin', 'https://shop.example');
      return handler(new Request(String(url), { ...init, headers }));
    };
    const value = await readCustomerLink(
      { v: 1, apiUrl, kind, token: cap.token },
      0,
      50,
      { send },
    );
    expect(requests).toBe(1);
    expect(value.kind).toBe(kind);
    expect(value.kind === 'order' ? value.order.id : value.account.id).toBe(
      resource,
    );
    expect(JSON.stringify(value)).not.toContain(cap.token);
    expect(value).not.toHaveProperty('businessId');
    if (value.kind === 'order')
      expect(value.order.lines).toEqual(fixture.source.tables.orders[0].lines);
  },
);
it('wrong-purpose and revoked links are unavailable on the next real client read', async () => {
  const cap = await fixture.issue(
      1,
      'order',
      fixture.source.tables.orders[0].id,
    ),
    handler = fixture.handler(),
    send: typeof fetch = (url, init) =>
      handler(
        new Request(String(url), {
          ...init,
          headers: {
            Origin: 'https://shop.example',
            'Content-Type': 'application/json',
          },
        }),
      );
  await expect(
    readCustomerLink({ v: 1, apiUrl, kind: 'khata', token: cap.token }, 0, 50, {
      send,
    }),
  ).rejects.toMatchObject({ kind: 'missing' });
  await fixture.db.query(
    'update private.public_links set revoked_at=created_at where id=$1',
    [cap.id],
  );
  await expect(
    readCustomerLink({ ...viewer, token: cap.token }, 0, 50, { send }),
  ).rejects.toMatchObject({ kind: 'missing' });
});
it.each(['1', '60', '999', 'invalid', null])(
  'rate limiting accepts only the bounded Retry-After header %s',
  async (value) => {
    const send: typeof fetch = async () =>
      new Response('{}', {
        status: 429,
        headers: value ? { 'Retry-After': value } : {},
      });
    await expect(
      readCustomerLink(viewer, 0, 50, { send }),
    ).rejects.toMatchObject({
      kind: 'limited',
      retryAfter: value === '1' ? 1 : 60,
    });
  },
);
it.each([
  ['text/html', '<script>private</script>'],
  ['application/json', '{"error":"private detail"}'],
  ['application/json', '{invalid'],
])(
  'untrusted %s error/projection bodies never become displayed data',
  async (type, body) => {
    await expect(
      readCustomerLink(viewer, 0, 50, {
        send: async () =>
          new Response(body, { headers: { 'Content-Type': type } }),
      }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'This link could not be checked. Connect and try again.',
    });
  },
);
it('oversized streamed bodies are cancelled without decoding or returning a partial projection', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readCustomerLink(viewer, 0, 50, {
      send: async () =>
        new Response(stream, {
          headers: { 'Content-Type': 'application/json' },
        }),
    }),
  ).rejects.toMatchObject({ kind: 'unavailable' });
  expect(cancelled).toBe(true);
});
it.each(['headers', 'body'])(
  'the full client lifetime bounds a hanging %s even if the transport ignores abort',
  async (stage) => {
    vi.useFakeTimers();
    try {
      const send: typeof fetch =
          stage === 'headers'
            ? () => new Promise(() => {})
            : async () =>
                new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                  headers: { 'Content-Type': 'application/json' },
                }),
        pending = readCustomerLink(viewer, 0, 50, { send }),
        result = expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
      await vi.advanceTimersByTimeAsync(15001);
      await result;
    } finally {
      vi.useRealTimers();
    }
  },
);
it('a cancelled route never makes a late public request', async () => {
  const stop = new AbortController();
  stop.abort();
  const send = vi.fn<typeof fetch>();
  await expect(
    readCustomerLink(viewer, 0, 50, { send, signal: stop.signal }),
  ).rejects.toMatchObject({ kind: 'unavailable' });
  expect(send).not.toHaveBeenCalled();
});
