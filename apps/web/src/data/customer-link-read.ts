import {
  projectCustomerLink,
  type CustomerLink,
  type CustomerLinkRequest,
} from '@mise/core/customer-links';
import {
  customerApiOrigin,
  type CustomerViewerLink,
} from '@mise/core/customer-link-url';
export class CustomerReadError extends Error {
  constructor(
    readonly kind: 'missing' | 'limited' | 'unavailable',
    readonly retryAfter = 0,
  ) {
    super(
      kind === 'missing'
        ? 'This link is unavailable. Ask the shop for a current link.'
        : kind === 'limited'
          ? 'Please wait a moment before checking this link again.'
          : 'This link could not be checked. Connect and try again.',
    );
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
/** Validate the HTTP projection again without importing owner Auth, storage or
 * database code. Only the named customer fields leave this decoder. */
export function decodeCustomerResponse(
  v: unknown,
  request: CustomerLinkRequest,
): CustomerLink {
  if (!object(v) || v.v !== 1 || v.kind !== request.kind || !object(v.shop))
    throw new CustomerReadError('unavailable');
  const shop = {
    v: 1,
    kind: request.kind,
    shopNameJson: JSON.stringify(v.shop.name),
    outletNameJson: JSON.stringify(v.shop.outletName),
    marketCode: v.shop.market,
    shopLink: v.shop.url,
  };
  try {
    if (request.kind === 'order') {
      if (!object(v.order)) throw Error();
      return projectCustomerLink(
        {
          ...shop,
          order: { ...v.order, linesJson: JSON.stringify(v.order.lines) },
        },
        request,
      );
    }
    if (!object(v.account) || !Array.isArray(v.account.entries)) throw Error();
    return projectCustomerLink(
      {
        ...shop,
        account: {
          ...v.account,
          customerNameJson: JSON.stringify(v.account.customerName),
          entries: v.account.entries.map((entry) => {
            if (!object(entry)) throw Error();
            return {
              ...entry,
              methodNameJson:
                entry.methodName === null
                  ? null
                  : JSON.stringify(entry.methodName),
            };
          }),
        },
      },
      request,
    );
  } catch {
    throw new CustomerReadError('unavailable');
  }
}
export async function readCustomerLink(
  link: CustomerViewerLink,
  afterSequence = 0,
  pageSize = 50,
  options: { send?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CustomerLink> {
  const api = customerApiOrigin(link.apiUrl);
  if (
    link.v !== 1 ||
    !['order', 'khata'].includes(link.kind) ||
    !/^[A-Za-z0-9_-]{43}$/.test(link.token) ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (link.kind === 'order' && (afterSequence !== 0 || pageSize !== 50))
  )
    throw new CustomerReadError('unavailable');
  const request = {
      kind: link.kind,
      token: link.token,
      afterSequence,
      pageSize,
    },
    body =
      link.kind === 'order' ? { kind: link.kind, token: link.token } : request;
  const stop = new AbortController(),
    signal = options.signal
      ? AbortSignal.any([options.signal, stop.signal])
      : stop.signal,
    timer = setTimeout(() => stop.abort(), 15000);
  const abortable = <T>(work: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener('abort', cancel);
        reject(new CustomerReadError('unavailable'));
      };
      if (signal.aborted) {
        void work.catch(() => {});
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) cancel();
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
    });
  try {
    if (signal.aborted) throw new CustomerReadError('unavailable');
    const response = await abortable(
      (options.send ?? fetch)(new URL('/functions/v1/public-read', api), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal,
      }),
    );
    if (signal.aborted || response.redirected)
      throw new CustomerReadError('unavailable');
    if (response.status === 404) throw new CustomerReadError('missing');
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After');
      throw new CustomerReadError(
        'limited',
        raw && /^(?:[1-9]|[1-5][0-9]|60)$/.test(raw) ? Number(raw) : 60,
      );
    }
    if (
      !response.ok ||
      response.headers
        .get('Content-Type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json' ||
      !response.body
    )
      throw new CustomerReadError('unavailable');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await abortable(reader.read());
        if (signal.aborted) throw Error();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 8 * 1024 * 1024) throw Error();
        chunks.push(item.value);
      }
    } catch {
      void reader.cancel().catch(() => {});
      throw new CustomerReadError('unavailable');
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    if (signal.aborted) throw Error();
    return decodeCustomerResponse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      request,
    );
  } catch (error) {
    if (error instanceof CustomerReadError) throw error;
    throw new CustomerReadError('unavailable');
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}
