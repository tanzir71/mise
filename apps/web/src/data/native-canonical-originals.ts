import type { CloudConnection } from '@mise/core/cloud-connection';
import type { NativePaymentOriginalLoader } from '@mise/core/native-payment-canonical';
import {
  parseNativePaymentOriginalLink,
  paymentOriginalResponse,
} from '@mise/core/native-payment-originals';
import type { OriginalCopyScope } from '@mise/core/original-copy';
import type { PortableBackup } from '@mise/core/payment-archive';
import { literalToken } from '@mise/core/literal-token';
import {
  createOriginalCopyRequest,
  CommandRequestError,
  type CommandAccount,
} from './command-request';
import { downloadLinkedPaymentOriginal } from './linked-payment-original';

/** The established join/sync account supplies actual SDK authorization. Every
 * locator and response is checked as the current reader, separately from origin.
 * Cached bytes never replace current inspection or the installer's final role read. */
export function createNativeCanonicalOriginals(
  config: CloudConnection,
  account: CommandAccount,
  scope: OriginalCopyScope,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
  current: () => void = () => {},
  localOriginal?: (
    link: Parameters<NativePaymentOriginalLoader>[0],
  ) => Promise<Awaited<ReturnType<NativePaymentOriginalLoader>> | null>,
) {
  const controller = new AbortController(),
    request = createOriginalCopyRequest(config, account, send),
    copies = new Map<string, { retention: string; portable: PortableBackup }>();
  let active = true;
  const check = () => {
    signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    if (!active) throw new CommandRequestError('auth');
    const value: unknown = current();
    if (value !== undefined) {
      void Promise.resolve(value).catch(() => {});
      throw new CommandRequestError('auth');
    }
  };
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const call = async (
    op: string,
    id: string,
    body: Record<string, unknown>,
  ) => {
    check();
    const result = await request(
      JSON.stringify(body),
      {
        'Content-Type': 'application/json',
        'X-Mise-Original-Action': op,
        'X-Mise-Original-Id': id,
        'X-Mise-Original-Outlet': scope.outletId,
      },
      20000,
      controller.signal,
    );
    result.guard();
    check();
    return paymentOriginalResponse(result.value, scope);
  };
  const load: NativePaymentOriginalLoader = async (input) => {
    check();
    const expected = parseNativePaymentOriginalLink(input),
      link = parseNativePaymentOriginalLink(
        await call('payment-inspect', expected.id, {}),
      );
    if (
      link.businessId !== scope.businessId ||
      link.outletId !== scope.outletId ||
      literalToken(link) !== literalToken(expected)
    )
      throw new CommandRequestError('review');
    const key = link.retention.copy.id,
      retention = literalToken(link.retention),
      cached = copies.get(key);
    if (cached) {
      if (cached.retention !== retention)
        throw new CommandRequestError('review');
      return { link, portable: structuredClone(cached.portable) };
    }
    const local = await localOriginal?.(link);
    if (local) {
      check();
      if (literalToken(local.link) !== literalToken(link))
        throw new CommandRequestError('review');
      copies.set(key, { retention, portable: structuredClone(local.portable) });
      return local;
    }
    const loaded = await downloadLinkedPaymentOriginal(
      link,
      (op, body) => call(op, link.id, body),
      check,
    );
    check();
    copies.set(key, { retention, portable: structuredClone(loaded.portable) });
    return loaded;
  };
  return {
    load,
    stop() {
      active = false;
      copies.clear();
      controller.abort();
      signal?.removeEventListener('abort', abort);
    },
  };
}
