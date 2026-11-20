import { authHttp, readAuthBody, AuthBodyError } from './auth-http.ts';
import {
  parseOrderReviewRequest,
  type OrderReviewRequest,
  type OrderReviewDecision,
  type PreparedOrderReview,
  type OrderFinancialView,
} from '../../../packages/core/order-review.ts';
import {
  commandReviewHeader,
  commandReviewBodyLimit,
  reviewedOrderProposal,
  parseCommandResolutionReceipt,
} from '../../../packages/core/command-resolution.ts';
import {
  orderWritePlan,
  type OrderCommand,
} from '../../../packages/core/order-commands.ts';
import {
  orderFingerprint,
  replayOrderRecords,
} from '../../../packages/core/order-replay.ts';
import { orderWriteFields } from './order-write.ts';
import { parseShopCommandReceipt } from '../../../packages/core/shop-commands.ts';
import {
  decodeCommandRecord,
  decodeProposedCommandRecord,
} from '../../../packages/core/cloud-records.ts';
import { creditBalance } from '../../../packages/core/khata.ts';
import { syncHash } from '../../../packages/core/sync-read.ts';
import { syncDownloadToken } from '../../../packages/core/sync-download.ts';
import { deviceAuthId } from './device-pin-handler.ts';
import type {
  Order,
  CreditEntry,
  CreditAccount,
  Sale,
  OrderRefund,
  Customer,
} from '../../../packages/core/models.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 8640000000000000;
class ReviewFailure extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 429 | 503) {
    super(
      'Review the saved action with its original account and current shop values.',
    );
  }
}
export interface OrderReviewStore {
  admit(jwt: string, outletId: string): Promise<void>;
  prepare(jwt: string, input: OrderReviewRequest): Promise<unknown>;
  resolve(jwt: string, input: OrderReviewDecision): Promise<unknown>;
}
function financialView(order: Order): OrderFinancialView {
  return {
    id: order.id,
    number: order.number,
    revision: order.revision,
    status: order.status,
    currency: order.currency,
    customer: order.customer,
    lines: order.lines,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
    payment: order.payment,
  };
}
/** Original literal JSON remains data. No provider response or credentials enter
 * the projected review; the server ticket retains the complete source hash. */
async function reviewFields(
  value: unknown,
  input: OrderReviewRequest,
): Promise<{ view: PreparedOrderReview; proposal: OrderCommand | null }> {
  const c = input.command,
    plan = orderWritePlan(c),
    { intentJson: _, ...expectedPlan } = plan;
  void _;
  if (
    !object(value) ||
    value.done !== false ||
    value.id !== input.id ||
    value.replacementId !== input.replacementId ||
    value.commandId !== c.id ||
    value.type !== c.type ||
    value.outletId !== c.outletId ||
    !id(value.businessId) ||
    !id(value.actorId) ||
    value.commandHash !== (await orderFingerprint(c)) ||
    value.sourceHash !== input.sourceHash ||
    value.sourceJsonHash !==
      (await syncHash(new TextEncoder().encode(input.sourceJson))) ||
    syncDownloadToken(value.plan) !== syncDownloadToken(expectedPlan) ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    !time(value.at) ||
    !time(value.expiresAt) ||
    value.expiresAt <= value.at ||
    typeof value.contextJson !== 'string'
  )
    throw new ReviewFailure(503);
  const raw: unknown = JSON.parse(value.contextJson);
  if (
    !object(raw) ||
    !object(raw.business) ||
    raw.business.id !== value.businessId ||
    !object(raw.outlet) ||
    raw.outlet.id !== c.outletId ||
    raw.outlet.business_id !== value.businessId ||
    !(raw.order === null || object(raw.order)) ||
    !(raw.account === null || object(raw.account)) ||
    !Array.isArray(raw.entries)
  )
    throw new ReviewFailure(503);
  const order = raw.order
      ? (decodeCommandRecord('orders', raw.order) as unknown as Order)
      : null,
    account = raw.account
      ? (decodeCommandRecord(
          'creditAccounts',
          raw.account,
        ) as unknown as CreditAccount)
      : null;
  if (
    (order &&
      (order.outletId !== c.outletId ||
        !('orderId' in c) ||
        order.id !== c.orderId)) ||
    (account && account.outletId !== c.outletId)
  )
    throw new ReviewFailure(503);
  const customer = object(raw.customer)
    ? (decodeCommandRecord('customers', raw.customer) as unknown as Customer)
    : null;
  if (account && (!customer || customer.id !== account.customerId))
    throw new ReviewFailure(503);
  const entries = raw.entries.map((row) => {
    if (!object(row)) throw new ReviewFailure(503);
    const entry = decodeCommandRecord(
      'creditEntries',
      row,
    ) as unknown as CreditEntry;
    if (
      !account ||
      entry.outletId !== c.outletId ||
      entry.accountId !== account.id
    )
      throw new ReviewFailure(503);
    return entry;
  });
  let proposal: OrderCommand | null = null,
    preview: PreparedOrderReview['proposal'] = { enabled: false };
  try {
    proposal = reviewedOrderProposal(
      c,
      order?.revision ?? null,
      input.replacementId,
    );
    const records = replayOrderRecords(
        {
          businessId: value.businessId,
          outletId: c.outletId,
          actorId: value.actorId,
          at: value.at,
          contextJson: value.contextJson,
        },
        proposal,
      ),
      result = records.find((row) => row.table === 'orders')?.values;
    if (
      !result ||
      !(result.total === null || typeof result.total === 'number') ||
      typeof result.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(result.currency) ||
      typeof result.status !== 'string' ||
      typeof result.payment !== 'string'
    )
      throw Error();
    const payment = JSON.parse(result.payment),
      effects: Extract<
        PreparedOrderReview['proposal'],
        { enabled: true }
      >['effects'] = [],
      afterEntries = new Map(entries.map((entry) => [entry.id, entry]));
    for (const row of records) {
      if (row.table === 'credit_entries') {
        const entry = decodeProposedCommandRecord(
          'creditEntries',
          row,
        ) as unknown as CreditEntry;
        if (!account || entry.accountId !== account.id) throw Error();
        afterEntries.set(entry.id, entry);
      }
      if (row.table === 'sales' || row.table === 'order_refunds') {
        const sale = row.table === 'sales',
          after = decodeProposedCommandRecord(
            sale ? 'sales' : 'orderRefunds',
            row,
          ) as unknown as Sale | OrderRefund,
          beforeRaw = sale ? raw.sale : raw.refund;
        const before =
          object(beforeRaw) && beforeRaw.id === after.id
            ? (decodeCommandRecord(
                sale ? 'sales' : 'orderRefunds',
                beforeRaw,
              ) as unknown as Sale | OrderRefund)
            : null;
        const isVoided = after.voidedAt !== undefined,
          wasVoided = before?.voidedAt !== undefined;
        if ((!before && !isVoided) || (before && wasVoided !== isVoided))
          effects.push({
            kind: sale
              ? isVoided
                ? 'payment_reversed'
                : 'payment'
              : isVoided
                ? 'refund_reversed'
                : 'refund',
            amount: after.amount,
            currency: after.currency,
            method: after.method,
            methodName: after.methodName,
          });
      }
    }
    preview = {
      enabled: true,
      revision:
        proposal.type === 'order.create'
          ? 0
          : 'revision' in proposal
            ? proposal.revision
            : 0,
      total: result.total as number | null,
      currency: result.currency as string,
      status: result.status as Order['status'],
      method: payment.method,
      creditBalance: account
        ? creditBalance(account, [...afterEntries.values()])
        : null,
      refundDue: payment.cancellation?.refundDue ?? 0,
      effects,
    };
  } catch {
    proposal = null;
  }
  return {
    proposal,
    view: {
      v: 1,
      id: input.id,
      replacementId: input.replacementId,
      commandId: c.id,
      commandHash: value.commandHash as string,
      sourceHash: input.sourceHash,
      businessId: value.businessId,
      outletId: c.outletId,
      actorId: value.actorId,
      token: value.token,
      at: value.at,
      expiresAt: value.expiresAt,
      current: {
        order: order ? financialView(order) : null,
        balance: account ? creditBalance(account, entries) : null,
        limit: account?.limit ?? null,
        creditCurrency: account?.currency ?? null,
        creditCustomer:
          account && customer
            ? { name: customer.name, phone: customer.phone ?? null }
            : null,
      },
      proposal: preview,
    },
  };
}
export function createOrderReviewHandler(deps: {
  store: OrderReviewStore;
  origins: ReadonlySet<string>;
}) {
  const origins = new Set(deps.origins);
  return async (request: Request): Promise<Response> => {
    const { reply, blocked } = authHttp(request, origins, [
      commandReviewHeader.toLowerCase(),
    ]);
    if (blocked) return blocked;
    const jwt = request.headers
        .get('authorization')
        ?.match(
          /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
        )?.[1],
      outlet = request.headers.get(commandReviewHeader),
      query = new URL(request.url).searchParams,
      mode = query.get('review');
    if (!jwt || jwt.length > 8192)
      return reply(401, { error: 'Verify the original phone account again.' });
    if (
      !id(outlet) ||
      !['read', 'resolve'].includes(mode ?? '') ||
      [...query.keys()].some((key) => key !== 'review')
    )
      return reply(400, { error: 'Choose the original saved-action review.' });
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get('content-type') || '',
      )
    )
      return reply(415, { error: 'Use JSON.' });
    try {
      await deps.store.admit(jwt, outlet);
      const raw = await readAuthBody(request, commandReviewBodyLimit);
      let input: OrderReviewRequest | OrderReviewDecision;
      try {
        input =
          mode === 'resolve'
            ? parseOrderReviewRequest(raw, true)
            : parseOrderReviewRequest(raw, false);
      } catch {
        throw new ReviewFailure(400);
      }
      if (input.command.outletId !== outlet)
        return reply(400, { error: 'Keep the original reviewed outlet.' });
      return reply(
        200,
        mode === 'resolve'
          ? await deps.store.resolve(jwt, input as OrderReviewDecision)
          : await deps.store.prepare(jwt, input),
      );
    } catch (error) {
      const status =
        error instanceof ReviewFailure
          ? error.status
          : error instanceof AuthBodyError
            ? error.status
            : error instanceof SyntaxError || error instanceof TypeError
              ? 400
              : 503;
      return reply(status, {
        error:
          status === 409
            ? 'The saved review changed. Review the current shop values again.'
            : status === 401 || status === 403
              ? 'Verify the original account and outlet access.'
              : status === 429
                ? 'Finish an existing saved review before starting another.'
                : status === 400
                  ? 'Keep the complete original saved action and source.'
                  : 'The financial review is unconfirmed. Keep its original source and try again.',
      });
    }
  };
}
export function createOrderReviewStore(
  apiUrl: string,
  publishableKey: string,
  serviceKey: string,
  send: typeof fetch = fetch,
  newId: () => string = deviceAuthId,
): OrderReviewStore {
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
    throw new Error('Financial reviews are unavailable.');
  async function rpc(
    name: string,
    args: Record<string, unknown>,
    jwt?: string,
  ): Promise<unknown> {
    const response = await send(new URL('rest/v1/rpc/' + name, root), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: jwt ? publishableKey : serviceKey,
        ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}),
      },
      body: JSON.stringify(args),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const status = response.status;
      throw new ReviewFailure(
        status === 401 ||
          status === 403 ||
          status === 409 ||
          status === 429 ||
          status === 400
          ? status
          : 503,
      );
    }
    return response.json();
  }
  async function outcome(jwt: string, input: OrderReviewRequest) {
    const c = input.command,
      value = await rpc(
        'inspect_order_outcome',
        {
          p_command_id: c.id,
          p_type: c.type,
          p_outlet_id: c.outletId,
          p_hash: await orderFingerprint(c),
        },
        jwt,
      );
    if (value === null) return null;
    const receipt = parseShopCommandReceipt(value, c);
    if (
      receipt.type === 'command.resolved' &&
      receipt.sourceHash !== input.sourceHash
    )
      throw new ReviewFailure(409);
    return receipt;
  }
  return {
    admit: async (jwt, outletId) => {
      if (
        (await rpc('admit_order_write', { p_outlet_id: outletId }, jwt)) !==
        true
      )
        throw new ReviewFailure(403);
    },
    prepare: async (jwt, value) => {
      const input = parseOrderReviewRequest(value, false),
        found = await outcome(jwt, input);
      if (found) return { done: true, receipt: found };
      const c = input.command,
        prepared = await rpc(
          'prepare_order_review',
          {
            p_id: input.id,
            p_replacement_id: input.replacementId,
            p_command_id: c.id,
            p_type: c.type,
            p_outlet_id: c.outletId,
            p_plan: orderWritePlan(c),
            p_hash: await orderFingerprint(c),
            p_occurred_at: c.occurredAt,
            p_source_hash: input.sourceHash,
            p_source_json: input.sourceJson,
          },
          jwt,
        );
      if (object(prepared) && prepared.done === true)
        return {
          done: true,
          receipt: parseShopCommandReceipt(prepared.receipt, c),
        };
      return {
        done: false,
        review: (await reviewFields(prepared, input)).view,
      };
    },
    resolve: async (jwt, value) => {
      const input = parseOrderReviewRequest(value, true),
        found = await outcome(jwt, input);
      if (found) return found;
      const prepared = await rpc(
          'read_order_review',
          { p_id: input.id, p_token: input.token },
          jwt,
        ),
        review = await reviewFields(prepared, input);
      let fields: Record<string, unknown> | null = null,
        hash: string | null = null;
      if (input.outcome === 'replaced') {
        if (!review.proposal || !review.view.proposal.enabled)
          throw new ReviewFailure(409);
        const c = review.proposal,
          ticket = newId();
        hash = await orderFingerprint(c);
        const normal = await rpc(
          'prepare_order_write',
          {
            p_id: c.id,
            p_ticket_id: ticket,
            p_type: c.type,
            p_outlet_id: c.outletId,
            p_plan: orderWritePlan(c),
            p_hash: hash,
            p_occurred_at: c.occurredAt,
          },
          jwt,
        );
        if (object(normal) && normal.done === true)
          throw new ReviewFailure(409);
        fields = orderWriteFields(normal, c, ticket);
      }
      const result = await rpc('finish_order_review', {
        p_id: input.id,
        p_token: input.token,
        p_outcome: input.outcome,
        p_replacement_ticket: fields?.p_ticket_id ?? null,
        p_replacement_token: fields?.p_token ?? null,
        p_replacement_hash: hash,
        p_replacement_records: fields?.p_records ?? null,
      });
      const receipt = parseCommandResolutionReceipt(result, input.command);
      if (
        receipt.commandHash !== (await orderFingerprint(input.command)) ||
        receipt.sourceHash !== input.sourceHash
      )
        throw new ReviewFailure(503);
      return receipt;
    },
  };
}
