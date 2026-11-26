import {
  originalCopyFetchJson,
  OriginalCopyResponseError,
} from '../../../packages/core/original-copy-wire.ts';
import { authHttp, AuthBodyError, readAuthBody } from './auth-http.ts';
export const originalCopyHeaders = [
  'X-Mise-Original-Action',
  'X-Mise-Original-Id',
  'X-Mise-Original-Outlet',
] as const;
const operations = [
  'begin',
  'missing',
  'put',
  'part',
  'seal',
  'verify',
  'finish',
  'inspect',
  'read',
  'read-part',
  'payment-promote',
  'payment-stage',
  'payment-link',
  'payment-inspect',
  'payment-read',
  'payment-read-part',
];
export class OriginalCopyHttpError extends Error {
  constructor(readonly status: number) {
    super('Original copy unavailable.');
  }
}
export interface OriginalCopyStore {
  rpc(
    jwt: string,
    op: string,
    outlet: string,
    id: string,
    body: unknown,
  ): Promise<unknown>;
}
export function originalCopyHandler(
  origins: ReadonlySet<string>,
  store: OriginalCopyStore,
) {
  return async (request: Request) => {
    const { reply, blocked } = authHttp(request, origins, originalCopyHeaders);
    if (blocked) return blocked;
    const auth = request.headers.get('authorization') || '',
      jwt =
        auth.length <= 8192
          ? auth.match(
              /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
            )?.[1]
          : undefined;
    if (!jwt)
      return reply(401, {
        error: 'Verify your account before keeping an original copy.',
      });
    const op = request.headers.get(originalCopyHeaders[0]) || '',
      id = request.headers.get(originalCopyHeaders[1]) || '',
      outlet = request.headers.get(originalCopyHeaders[2]) || '';
    if (
      !operations.includes(op) ||
      ![id, outlet].every((s) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s))
    )
      return reply(400, { error: 'Keep the original copy and selected shop.' });
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get('content-type') || '',
      )
    )
      return reply(415, { error: 'Use JSON.' });
    try {
      if (
        (await store.rpc(jwt, 'admit', outlet, id, { operation: op })) !== true
      )
        throw new OriginalCopyHttpError(403);
      const body = await readAuthBody(request, 256000, 20000);
      return reply(200, await store.rpc(jwt, op, outlet, id, body));
    } catch (e) {
      return reply(
        e instanceof AuthBodyError
          ? e.status
          : e instanceof OriginalCopyHttpError ||
              e instanceof OriginalCopyResponseError
            ? e.status
            : 503,
        {
          error:
            'The original copy is unavailable. Keep your local backup and retry the same request.',
        },
      );
    }
  };
}
export function originalCopyStore(
  url: string,
  key: string,
  send: typeof fetch = fetch,
): OriginalCopyStore {
  const root = new URL(url);
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    root.pathname !== '/' ||
    (root.protocol !== 'https:' &&
      !(
        root.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname)
      )) ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  )
    throw Error('Configure the installation backend.');
  return {
    async rpc(jwt, op, outlet, id, body) {
      return originalCopyFetchJson(
        send,
        new URL('rest/v1/rpc/' + (op.startsWith('payment-') || op === 'admit' && !!body && typeof body === 'object' && String((body as {operation?:unknown}).operation).startsWith('payment-') ? 'payment_original' : 'native_original_copy'), root),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            apikey: key,
            Authorization: 'Bearer ' + jwt,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_op: op,
            p_outlet_id: outlet,
            p_copy_id: id,
            p_body: body,
          }),
        },
      );
    },
  };
}
