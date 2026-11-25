import { newInboxId } from '../../../packages/core/inbox.ts';
import {
  parseNativePaymentInvocation,
  paymentInvocationHash,
  type NativePaymentInvocation,
} from '../../../packages/core/payment-invocations.ts';
import {
  nativePaymentHeader,
  nativePaymentBodyLimit,
  nativePaymentWritePlan,
  nativePaymentWriteFields,
  parseNativePaymentBackendReceipt,
  NativePaymentBackendConflict,
  type NativePaymentBackendReceipt,
} from '../../../packages/core/payment-backend.ts';
import type { Payment } from '../../../packages/core/models.ts';
import { authHttp, AuthBodyError, readAuthBody } from './auth-http.ts';
export class NativePaymentDenied extends Error {
  constructor(readonly status: 401 | 403 = 403) {
    super('This native payment action is unavailable.');
  }
}
class NativePaymentSnapshotChanged extends Error {}
export interface NativePaymentStore {
  admit(jwt: string, outletId: string): Promise<void>;
  apply(
    jwt: string,
    invocation: NativePaymentInvocation,
  ): Promise<NativePaymentBackendReceipt>;
}
export function createNativePaymentHandler(deps: {
  origins: ReadonlySet<string>;
  store: NativePaymentStore;
}) {
  return async (request: Request) => {
    const { reply, blocked } = authHttp(request, deps.origins, [
      nativePaymentHeader,
    ]);
    if (blocked) return blocked;
    const authorization = request.headers.get('authorization') || '',
      jwt =
        authorization.length <= 8192
          ? authorization.match(
              /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
            )?.[1]
          : undefined;
    if (!jwt)
      return reply(401, { error: 'Sign in again before reviewing a payment.' });
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get('content-type') || '',
      )
    )
      return reply(415, { error: 'Use JSON.' });
    const outlet = request.headers.get(nativePaymentHeader);
    if (!outlet || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(outlet))
      return reply(400, { error: 'Keep the selected payment outlet.' });
    try {
      await deps.store.admit(jwt, outlet);
    } catch (error) {
      return reply(error instanceof NativePaymentDenied ? error.status : 503, {
        error: 'Payment changes are unavailable for this account.',
      });
    }
    let invocation: NativePaymentInvocation;
    try {
      invocation = parseNativePaymentInvocation(
        await readAuthBody(request, nativePaymentBodyLimit, 20000),
      );
    } catch (error) {
      return reply(error instanceof AuthBodyError ? error.status : 400, {
        error: 'Keep the exact checked native payment request.',
      });
    }
    const c = invocation.command;
    if (c.outletId !== outlet)
      return reply(400, { error: 'Keep the admitted payment outlet.' });
    try {
      return reply(
        200,
        parseNativePaymentBackendReceipt(
          await deps.store.apply(jwt, invocation),
          c,
        ),
      );
    } catch (error) {
      return error instanceof NativePaymentDenied
        ? reply(error.status, {
            error: 'This payment change is unavailable for this account.',
          })
        : error instanceof NativePaymentBackendConflict
          ? reply(409, {
              error:
                'The original payment or financial comparison changed. Open its current review.',
            })
          : reply(503, {
              error:
                'Payment changes are unavailable. Keep the original request and retry it.',
            });
    }
  };
}
export function createNativePaymentStore(
  apiUrl: string,
  publishableKey: string,
  serviceKey: string,
  send: typeof fetch = fetch,
  newId = () => newInboxId(),
): NativePaymentStore {
  const root = new URL(apiUrl);
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
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) ||
    !/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey)
  )
    throw Error(
      'Configure native payments in the private installation environment.',
    );
  async function rpc(
    name: string,
    args: Record<string, unknown>,
    server: boolean,
    jwt?: string,
  ) {
    const headers: Record<string, string> = {
      apikey: server ? serviceKey : publishableKey,
      'Content-Type': 'application/json',
    };
    if (jwt) headers.Authorization = 'Bearer ' + jwt;
    const response = await send(new URL('rest/v1/rpc/' + name, root), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers,
      body: JSON.stringify(args),
    });
    if (response.status === 401 || response.status === 403) {
      if (server && response.status === 401)
        throw Error('Native payment service unavailable.');
      throw new NativePaymentDenied(response.status);
    }
    if (response.status === 409) {
      let code: unknown, details: unknown;
      try {
        const value = await response.json();
        code = value.code;
        details = value.details;
      } catch {
        /* No backend details leave this module. */
      }
      if (code === 'PT409' && details === 'native_payment_snapshot_changed')
        throw new NativePaymentSnapshotChanged();
      throw new NativePaymentBackendConflict();
    }
    if (!response.ok) throw Error('Native payment service unavailable.');
    return response.json();
  }
  return {
    admit: async (jwt, outletId) => {
      if (
        (await rpc(
          'admit_native_payment_write',
          { p_outlet_id: outletId },
          false,
          jwt,
        )) !== true
      )
        throw new NativePaymentDenied();
    },
    apply: async (jwt, input) => {
      const invocation = parseNativePaymentInvocation(input),
        c = invocation.command,
        p_plan = nativePaymentWritePlan(invocation),
        p_hash = paymentInvocationHash(invocation);
      for (let attempt = 0; attempt < 3; attempt++) {
        const ticket = newId(),
          prepared = await rpc(
            'prepare_native_payment_write',
            {
              p_id: c.id,
              p_ticket_id: ticket,
              p_type: c.type,
              p_outlet_id: c.outletId,
              p_plan,
              p_hash,
              p_occurred_at: c.occurredAt,
            },
            false,
            jwt,
          );
        if (prepared?.done === true) {
          const receipt = parseNativePaymentBackendReceipt(prepared.receipt, c);
          if (receipt.paymentHash !== invocation.paymentHash)
            throw new NativePaymentBackendConflict();
          return receipt;
        }
        const fields = nativePaymentWriteFields(prepared, invocation, ticket);
        try {
          return parseNativePaymentBackendReceipt(
            await rpc('finish_native_payment_write', fields, true),
            c,
            JSON.parse(fields.p_payment_json) as Payment,
          );
        } catch (error) {
          if (!(error instanceof NativePaymentSnapshotChanged)) throw error;
        }
      }
      throw new NativePaymentBackendConflict();
    },
  };
}
